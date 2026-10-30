// USOPGRID operations console — platform operators only.
// System + provider health, circuits, recovery queue, webhook dead letters,
// inbound provider events, feature flags, organizations, audit, alerts.
// Every write is audited with the operator's identity.

import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { isPlatformAdmin, requirePlatformAdmin, requireOperatorStepUp } from "./lib/rbac";
import { listDescriptors } from "./providers/index";
import { CLOSED } from "./orchestration/circuit";
import { keyringConfigured } from "./lib/keyring";

async function audit(ctx: MutationCtx, actor: string, action: string, resource: string, resourceId?: string, after?: unknown) {
  await ctx.db.insert("auditLogs", { actor: `operator:${actor}`, action, resource, resourceId, after, at: Date.now() });
}

export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const a = await isPlatformAdmin(ctx);
    return { isPlatformAdmin: Boolean(a), email: a?.email ?? null };
  },
});

export const systemHealth = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const circuits = await ctx.db.query("circuitStates").collect();
    const health = (await ctx.db.query("providerHealth").collect()).filter((h) => h.day === day);
    const recoveryOpen = await ctx.db.query("recoveryJobs").withIndex("by_status_next", (q) => q.eq("status", "open")).take(1000);
    const overdue = recoveryOpen.filter((j) => j.nextCheckAt < now - 5 * 60_000);
    const pendingHooks = await ctx.db.query("webhookDeliveries").withIndex("by_status_next", (q) => q.eq("status", "pending")).take(5000);
    const failedHooks = await ctx.db.query("webhookDeliveries").withIndex("by_status_next", (q) => q.eq("status", "failed")).take(5000);
    const deadHooks = await ctx.db.query("webhookDeliveries").withIndex("by_status_next", (q) => q.eq("status", "dead")).take(5000);
    const fx = await ctx.db.query("fxRateSnapshots").withIndex("by_base_fetched", (q) => q.eq("base", "USD")).order("desc").first();
    const rejected = (await ctx.db.query("providerEvents").withIndex("by_received", (q) => q.gte("receivedAt", now - 86_400_000)).take(5000)).filter((e) => e.outcome === "rejected").length;

    const env = {
      encryptionKey: keyringConfigured(),
      siteUrl: process.env.CONVEX_SITE_URL ?? null,
      sanctionsScreening: Boolean(process.env.OPENSANCTIONS_API_KEY),
      premiumFx: Boolean(process.env.FX_RATE_PROVIDER_URL && process.env.FX_RATE_PROVIDER_KEY),
      platformAdmins: (process.env.USOPGRID_PLATFORM_ADMINS ?? "").split(",").filter(Boolean).length,
    };
    const checks = [
      { id: "encryption", label: "Credential encryption key", ok: env.encryptionKey, detail: env.encryptionKey ? "AES-256-GCM key loaded" : "USOPGRID_ENCRYPTION_KEY missing — connections & MFA disabled" },
      { id: "fx", label: "FX rates fresh (<36h)", ok: Boolean(fx && now - fx.sourceTimestamp < 36 * 3_600_000), detail: fx ? `${fx.source}, ${Object.keys(fx.rates as object).length} currencies` : "no snapshot yet" },
      { id: "recovery", label: "Recovery queue on schedule", ok: overdue.length === 0, detail: `${recoveryOpen.length} open, ${overdue.length} overdue` },
      { id: "webhooks", label: "Webhook dispatcher", ok: pendingHooks.filter((d) => (d.nextAttemptAt ?? 0) < now - 5 * 60_000).length === 0, detail: `${pendingHooks.length} pending, ${failedHooks.length} retrying, ${deadHooks.length} dead` },
      { id: "circuits", label: "Provider circuits closed", ok: circuits.every((c) => c.state === "closed"), detail: `${circuits.filter((c) => c.state !== "closed").length} open/half-open` },
      { id: "sanctions", label: "Watchlist screening", ok: env.sanctionsScreening, detail: env.sanctionsScreening ? "OpenSanctions configured" : "OPENSANCTIONS_API_KEY not set — jurisdiction policy only" },
    ];

    return {
      generatedAt: now,
      checks,
      env,
      providers: listDescriptors().map((d) => {
        const rows = health.filter((h) => h.provider === d.id);
        const charges = rows.reduce((s, r) => s + r.charges, 0);
        const ok = rows.reduce((s, r) => s + r.successful + r.pending, 0);
        const lat = rows.reduce((s, r) => s + r.latencySumMs, 0);
        const errs = rows.reduce((s, r) => s + r.failed + (r.unknown ?? 0), 0);
        const cs = circuits.filter((c) => c.providerId === d.id);
        return {
          id: d.id,
          name: d.displayName,
          category: d.category,
          attemptsToday: charges,
          successRate: charges ? ok / charges : null,
          errorRate: charges ? errs / charges : null,
          avgLatencyMs: charges ? Math.round(lat / charges) : null,
          lastError: rows.map((r) => r.lastErrorMessage).find(Boolean) ?? null,
          circuits: cs.map((c) => ({ connectionId: c.connectionId, state: c.state, failures: c.consecutiveFailures, nextProbeAt: c.nextProbeAt ?? null, reason: c.lastFailureReason ?? null })),
        };
      }),
      queues: { recoveryOpen: recoveryOpen.length, recoveryOverdue: overdue.length, webhooksPending: pendingHooks.length, webhooksRetrying: failedHooks.length, webhooksDead: deadHooks.length, rejectedProviderEvents24h: rejected },
      fx: fx ? { source: fx.source, sourceTimestamp: fx.sourceTimestamp, fetchedAt: fx.fetchedAt, currencies: Object.keys(fx.rates as object).length } : null,
    };
  },
});

export const resetCircuit = mutation({
  args: { connectionId: v.string() },
  handler: async (ctx, a) => {
    const op = await requireOperatorStepUp(ctx);
    const row = await ctx.db.query("circuitStates").withIndex("by_connection", (q) => q.eq("connectionId", a.connectionId)).unique();
    if (!row) return;
    await ctx.db.patch(row._id, { ...CLOSED, openedAt: undefined, nextProbeAt: undefined, cooldownMs: undefined, lastFailureReason: undefined, updatedAt: Date.now() });
    await audit(ctx, op.email, "ops.circuit_reset", "circuit", a.connectionId, { previous: row.state });
  },
});

export const recoveryQueue = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const jobs = await ctx.db.query("recoveryJobs").withIndex("by_status_next", (q) => q.eq("status", "open")).take(200);
    const escalated = (await ctx.db.query("recoveryJobs").withIndex("by_status_next", (q) => q.eq("status", "escalated")).order("desc").take(50));
    const enrich = async (j: (typeof jobs)[number]) => {
      const t = await ctx.db.get(j.transactionId);
      return { _id: j._id, kind: j.kind, status: j.status, providerId: j.providerId, checksDone: j.checksDone, nextCheckAt: j.nextCheckAt, deadlineAt: j.deadlineAt, lastResult: j.lastResult ?? null, transactionId: t?.transactionId ?? null, txStatus: t?.status ?? null, amountMinor: t?.amountMinor ?? null, currency: t?.currency ?? null };
    };
    return { open: await Promise.all(jobs.map(enrich)), escalated: await Promise.all(escalated.map(enrich)) };
  },
});

export const expediteRecovery = mutation({
  args: { jobId: v.id("recoveryJobs") },
  handler: async (ctx, a) => {
    const op = await requireOperatorStepUp(ctx);
    const j = await ctx.db.get(a.jobId);
    if (!j || j.status !== "open") throw new ConvexError("Job is not open");
    await ctx.db.patch(a.jobId, { nextCheckAt: Date.now(), updatedAt: Date.now() });
    await audit(ctx, op.email, "ops.recovery_expedited", "recovery_job", a.jobId);
  },
});

export const deadLetters = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const rows = await ctx.db.query("webhookDeliveries").withIndex("by_status_next", (q) => q.eq("status", "dead")).order("desc").take(200);
    const out = [];
    for (const d of rows) {
      const org = await ctx.db.get(d.orgId);
      const ep = await ctx.db.get(d.endpointId);
      out.push({ _id: d._id, event: d.event, org: org?.name ?? "—", url: ep?.url ?? "—", attempts: d.attempts, lastError: d.lastError ?? null, responseStatus: d.responseStatus ?? null, createdAt: d.createdAt });
    }
    return out;
  },
});

export const replayDeadLetter = mutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, a) => {
    const op = await requireOperatorStepUp(ctx);
    const d = await ctx.db.get(a.deliveryId);
    if (!d || d.status !== "dead") throw new ConvexError("Only dead-lettered deliveries can be replayed here");
    await ctx.db.patch(a.deliveryId, { status: "pending", attempts: 0, nextAttemptAt: Date.now(), lastError: undefined });
    await audit(ctx, op.email, "ops.webhook_replayed", "webhook_delivery", a.deliveryId, { event: d.event });
  },
});

export const providerEvents = query({
  args: { outcome: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await requirePlatformAdmin(ctx);
    const rows = await ctx.db.query("providerEvents").withIndex("by_received").order("desc").take(300);
    return rows.filter((r) => !a.outcome || r.outcome === a.outcome).slice(0, 200);
  },
});

export const listFlags = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    return ctx.db.query("featureFlags").collect();
  },
});

export const setFlag = mutation({
  args: { key: v.string(), enabled: v.boolean(), description: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const op = await requireOperatorStepUp(ctx);
    if (!/^[a-z0-9_.-]{2,64}$/.test(a.key)) throw new ConvexError("Flag keys are lowercase letters, digits, . _ -");
    const row = await ctx.db.query("featureFlags").withIndex("by_key", (q) => q.eq("key", a.key)).unique();
    if (row) await ctx.db.patch(row._id, { enabled: a.enabled, description: a.description ?? row.description, updatedBy: op.email, updatedAt: Date.now() });
    else await ctx.db.insert("featureFlags", { key: a.key, enabled: a.enabled, description: a.description ?? "", updatedBy: op.email, updatedAt: Date.now() });
    await audit(ctx, op.email, "ops.flag_set", "feature_flag", a.key, { enabled: a.enabled });
  },
});

export const organizations = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const orgs = await ctx.db.query("organizations").order("desc").take(500);
    const out = [];
    for (const o of orgs) {
      const members = await ctx.db.query("orgMembers").withIndex("by_org", (q) => q.eq("orgId", o._id)).collect();
      const last = await ctx.db.query("transactions").withIndex("by_org_created", (q) => q.eq("orgId", o._id)).order("desc").first();
      out.push({ _id: o._id, name: o.name, slug: o.slug, environment: o.environment ?? "sandbox", status: o.status ?? "active", country: o.country ?? null, members: members.length, lastPaymentAt: last?.createdAt ?? null, createdAt: o._creationTime });
    }
    return out;
  },
});

export const setOrgStatus = mutation({
  args: { orgId: v.id("organizations"), status: v.union(v.literal("active"), v.literal("restricted"), v.literal("suspended")), reason: v.string() },
  handler: async (ctx, a) => {
    const op = await requireOperatorStepUp(ctx);
    if (a.reason.trim().length < 5) throw new ConvexError("A reason is required");
    const org = await ctx.db.get(a.orgId);
    if (!org) throw new ConvexError("Organization not found");
    await ctx.db.patch(a.orgId, { status: a.status });
    await ctx.db.insert("auditLogs", { orgId: a.orgId, actor: `operator:${op.email}`, action: "ops.org_status_changed", resource: "organization", resourceId: a.orgId, before: { status: org.status ?? "active" }, after: { status: a.status, reason: a.reason }, at: Date.now() });
  },
});

/** Raise or lower one API key's rate limit (enterprise customers, load tests). Operators only. */
export const setApiKeyRateLimit = mutation({
  args: { keyPrefix: v.string(), perMinute: v.union(v.number(), v.null()), reason: v.string() },
  handler: async (ctx, a) => {
    const op = await requireOperatorStepUp(ctx);
    if (a.reason.trim().length < 5) throw new ConvexError("A reason is required");
    if (a.perMinute !== null && (!Number.isInteger(a.perMinute) || a.perMinute < 10 || a.perMinute > 6000)) throw new ConvexError("Limit must be a whole number from 10 to 6000 per minute");
    const prefix = a.keyPrefix.trim();
    const key = (await ctx.db.query("apiKeys").collect()).find((k) => k.prefix === prefix && k.status === "active");
    if (!key) throw new ConvexError("No active key with that prefix");
    await ctx.db.patch(key._id, { rateLimitPerMinute: a.perMinute ?? undefined });
    await ctx.db.insert("auditLogs", { orgId: key.orgId, actor: `operator:${op.email}`, action: "ops.api_key_rate_limit_changed", resource: "api_key", resourceId: key.prefix, before: { perMinute: key.rateLimitPerMinute ?? 120 }, after: { perMinute: a.perMinute ?? 120, reason: a.reason }, at: Date.now() });
    return { prefix: key.prefix, perMinute: a.perMinute ?? 120 };
  },
});

export const platformAudit = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const rows = await ctx.db.query("auditLogs").order("desc").take(400);
    return rows.filter((r) => r.actor.startsWith("operator:") || r.action.startsWith("security.") || r.action.startsWith("provider_connection.")).slice(0, 200);
  },
});

export const platformAlerts = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    return ctx.db.query("notifications").withIndex("by_org_created", (q) => q.eq("orgId", undefined)).order("desc").take(100);
  },
});
