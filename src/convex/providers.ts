// Provider management for merchants: capability catalog, connections
// (sealed credentials), connection tests, circuit + health visibility.

import { v, ConvexError } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { listDescriptors, getAdapter, SANDBOX_PROVIDER_IDS } from "./providers/index";
import { METHOD_LABELS } from "./providers/types";
import { requireOrgMember, requirePermissionFor, requireSensitive, requireOrgMemberAction, requirePermission } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { randomToken, sealSecret } from "./lib/crypto";
import { platformConnectionId, platformCredentials, resolveConnection } from "./connections";

const envValidator = v.union(v.literal("sandbox"), v.literal("production"));

/** Public capability catalog (no secrets). */
export const catalog = query({
  args: {},
  handler: async (ctx) => {
    await requireOrgMember(ctx);
    return listDescriptors().map((d) => ({
      id: d.id,
      displayName: d.displayName,
      category: d.category,
      description: d.description,
      website: d.website,
      docsUrl: d.docsUrl,
      countries: d.countries,
      currencies: d.currencies,
      methods: d.methods.map((m) => ({ id: m, label: METHOD_LABELS[m] })),
      operations: d.operations,
      pricing: d.pricing,
      credentials: d.credentials.map((c) => ({ key: c.key, label: c.label, secret: c.secret, required: c.required, help: c.help })),
    }));
  },
});

function hint(value: string, secret: boolean): string {
  if (!secret) return value.length > 48 ? `${value.slice(0, 44)}…` : value;
  return value.length <= 8 ? "••••" : `${value.slice(0, Math.min(8, value.indexOf("_", 3) + 1 || 4))}…${value.slice(-4)}`;
}

/** Connections for the signed-in org + platform rails, with live circuit + health. */
export const listConnections = query({
  args: { environment: v.optional(envValidator) },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    const env = args.environment ?? ((oc.org.environment ?? "sandbox") as "sandbox" | "production");
    const rows = await ctx.db
      .query("providerConnections")
      .withIndex("by_org_env", (q) => q.eq("orgId", oc.orgId).eq("environment", env))
      .collect();
    const day = new Date().toISOString().slice(0, 10);
    const enrich = async (connectionId: string, providerId: string) => {
      const circuit = await ctx.db.query("circuitStates").withIndex("by_connection", (q) => q.eq("connectionId", connectionId)).unique();
      const health = await ctx.db
        .query("providerHealth")
        .withIndex("by_provider_env_day", (q) => q.eq("provider", providerId).eq("environment", env).eq("day", day))
        .unique();
      return {
        circuit: circuit ? { state: circuit.state, consecutiveFailures: circuit.consecutiveFailures, nextProbeAt: circuit.nextProbeAt ?? null, reason: circuit.lastFailureReason ?? null } : { state: "closed" as const, consecutiveFailures: 0, nextProbeAt: null, reason: null },
        today: health
          ? {
              attempts: health.charges,
              successRate: health.charges ? (health.successful + health.pending) / health.charges : null,
              avgLatencyMs: health.charges ? Math.round(health.latencySumMs / health.charges) : null,
              lastError: health.lastErrorMessage ?? null,
            }
          : null,
      };
    };
    const own = await Promise.all(
      rows.map(async (r) => ({
        connectionKey: r.connectionKey,
        providerId: r.providerId,
        displayName: getAdapter(r.providerId)?.descriptor.displayName ?? r.providerId,
        label: r.label,
        environment: r.environment,
        enabled: r.enabled,
        priority: r.priority,
        status: r.status,
        credentialHints: (r.credentialHints as Record<string, string>) ?? {},
        pricing: r.pricing ?? null,
        lastVerifiedAt: r.lastVerifiedAt ?? null,
        lastError: r.lastError ?? null,
        source: "organization" as const,
        webhookUrl: process.env.CONVEX_SITE_URL ? `${process.env.CONVEX_SITE_URL}/api/v1/webhooks/providers/${r.connectionKey}` : null,
        ...(await enrich(r.connectionKey, r.providerId)),
      })),
    );
    const platform = [];
    for (const d of listDescriptors()) {
      const isSandbox = SANDBOX_PROVIDER_IDS.has(d.id);
      if (isSandbox ? env !== "sandbox" : !platformCredentials(d.id, env)) continue;
      const id = platformConnectionId(d.id, env);
      platform.push({
        connectionKey: id,
        providerId: d.id,
        displayName: d.displayName,
        label: isSandbox ? "Built-in simulation rail" : "USOPGRID platform account",
        environment: env,
        enabled: true,
        priority: d.id === "sandbox" ? 10 : 0,
        status: "active" as const,
        credentialHints: {},
        pricing: null,
        lastVerifiedAt: null,
        lastError: null,
        source: "platform" as const,
        webhookUrl: null,
        ...(await enrich(id, d.id)),
      });
    }
    return { environment: env, connections: [...own, ...platform] };
  },
});

export const insertConnectionInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    connectionKey: v.string(),
    providerId: v.string(),
    environment: envValidator,
    label: v.string(),
    priority: v.number(),
    sealedCredentials: v.string(),
    credentialHints: v.any(),
    pricing: v.optional(v.object({ pctBps: v.number(), fixedMinor: v.number(), fixedCurrency: v.string() })),
    userId: v.id("users"),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    await ctx.db.insert("providerConnections", {
      orgId: a.orgId,
      connectionKey: a.connectionKey,
      providerId: a.providerId,
      environment: a.environment,
      label: a.label,
      enabled: true,
      priority: a.priority,
      sealedCredentials: a.sealedCredentials,
      credentialHints: a.credentialHints,
      pricing: a.pricing,
      status: "unverified",
      createdByUserId: a.userId,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, {
      orgId: a.orgId,
      actor: a.userId,
      action: "provider_connection.created",
      resource: "provider_connection",
      resourceId: a.connectionKey,
      after: { providerId: a.providerId, environment: a.environment, label: a.label, credentialHints: a.credentialHints },
    });
  },
});

/** Used by actions to enforce permission + MFA step-up with the caller's identity. */
export const assertSensitive = query({
  args: { permission: v.string() },
  handler: async (ctx, { permission }) => {
    const oc = await requireSensitive(ctx, permission);
    return { orgId: oc.orgId, userId: oc.userId };
  },
});

/** Create a connection. Credentials are validated, sealed (AES-256-GCM) and never returned. */
export const createConnection = action({
  args: {
    providerId: v.string(),
    environment: envValidator,
    label: v.string(),
    priority: v.optional(v.number()),
    credentials: v.record(v.string(), v.string()),
    pricing: v.optional(v.object({ pctBps: v.number(), fixedMinor: v.number(), fixedCurrency: v.string() })),
  },
  handler: async (ctx, a): Promise<{ connectionKey: string }> => {
    const who: { orgId: Id<"organizations">; userId: Id<"users"> } = await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.PROVIDERS_MANAGE });
    const adapter = getAdapter(a.providerId);
    if (!adapter || SANDBOX_PROVIDER_IDS.has(a.providerId)) throw new ConvexError("Unknown provider");
    const creds: Record<string, string> = {};
    const hints: Record<string, string> = {};
    for (const f of adapter.descriptor.credentials) {
      const val = a.credentials[f.key]?.trim();
      if (!val) {
        if (f.required) throw new ConvexError(`${f.label} is required`);
        continue;
      }
      if (val.length > 4096) throw new ConvexError(`${f.label} is too long`);
      creds[f.key] = val;
      hints[f.key] = hint(val, f.secret);
    }
    if (a.environment === "production" && /(_test_|test_|sandbox|sk_test)/i.test(creds.secretKey ?? "")) {
      throw new ConvexError("These look like test credentials. Add them to the sandbox environment instead.");
    }
    const key = process.env.USOPGRID_ENCRYPTION_KEY;
    if (!key) throw new ConvexError("Credential storage is not configured (USOPGRID_ENCRYPTION_KEY missing). Contact your administrator.");
    const connectionKey = `pc_${randomToken(22)}`;
    const sealed = await sealSecret(JSON.stringify(creds), key, connectionKey);
    const priority = Math.max(-100, Math.min(100, Math.round(a.priority ?? 0)));
    if (a.pricing && (a.pricing.pctBps < 0 || a.pricing.pctBps > 5000 || a.pricing.fixedMinor < 0)) throw new ConvexError("Invalid pricing");
    await ctx.runMutation(internal.providers.insertConnectionInternal, {
      orgId: who.orgId,
      connectionKey,
      providerId: a.providerId,
      environment: a.environment,
      label: a.label.trim().slice(0, 80) || adapter.descriptor.displayName,
      priority,
      sealedCredentials: sealed,
      credentialHints: hints,
      pricing: a.pricing,
      userId: who.userId,
    });
    return { connectionKey };
  },
});

export const updateConnection = mutation({
  args: {
    connectionKey: v.string(),
    enabled: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    label: v.optional(v.string()),
    pricing: v.optional(v.union(v.null(), v.object({ pctBps: v.number(), fixedMinor: v.number(), fixedCurrency: v.string() }))),
  },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.PROVIDERS_MANAGE);
    const row = await ctx.db.query("providerConnections").withIndex("by_connection_key", (q) => q.eq("connectionKey", a.connectionKey)).unique();
    if (!row || row.orgId !== oc.orgId) throw new ConvexError("Connection not found");
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (a.enabled !== undefined) {
      patch.enabled = a.enabled;
      patch.status = a.enabled ? (row.status === "disabled" ? "unverified" : row.status) : "disabled";
    }
    if (a.priority !== undefined) patch.priority = Math.max(-100, Math.min(100, Math.round(a.priority)));
    if (a.label !== undefined) patch.label = a.label.trim().slice(0, 80);
    if (a.pricing !== undefined) patch.pricing = a.pricing ?? undefined;
    await ctx.db.patch(row._id, patch);
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "provider_connection.updated", resource: "provider_connection", resourceId: row.connectionKey, before: { enabled: row.enabled, priority: row.priority, label: row.label }, after: patch });
  },
});

export const deleteConnection = mutation({
  args: { connectionKey: v.string() },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.PROVIDERS_MANAGE);
    const row = await ctx.db.query("providerConnections").withIndex("by_connection_key", (q) => q.eq("connectionKey", a.connectionKey)).unique();
    if (!row || row.orgId !== oc.orgId) throw new ConvexError("Connection not found");
    // Keep the row (historical payments reference it for refunds/recovery);
    // destroy the secret material and disable routing.
    await ctx.db.patch(row._id, { enabled: false, status: "disabled", sealedCredentials: undefined, credentialHints: {}, updatedAt: Date.now() });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "provider_connection.revoked", resource: "provider_connection", resourceId: row.connectionKey, before: { providerId: row.providerId, label: row.label } });
  },
});

export const markTestedInternal = internalMutation({
  args: { connectionKey: v.string(), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("providerConnections").withIndex("by_connection_key", (q) => q.eq("connectionKey", a.connectionKey)).unique();
    if (!row) return;
    await ctx.db.patch(row._id, { status: a.ok ? "active" : "error", lastVerifiedAt: Date.now(), lastError: a.ok ? undefined : a.error, updatedAt: Date.now() });
  },
});

/**
 * Verify credentials without moving money: a status lookup for a reference
 * that cannot exist. Auth errors (401/403) fail the test; "not found" passes.
 */
export const testConnection = action({
  args: { connectionKey: v.string() },
  handler: async (ctx, a): Promise<{ ok: boolean; message: string }> => {
    const oc = await requireOrgMemberAction(ctx);
    requirePermission(oc, PERMISSIONS.PROVIDERS_MANAGE);
    const row = await ctx.runQuery(internal.connections.connectionByKeyInternal, { connectionKey: a.connectionKey });
    if (!row || row.orgId !== oc.orgId) throw new ConvexError("Connection not found");
    const res = await resolveConnection(a.connectionKey, row.environment, async () => row);
    if ("error" in res) {
      await ctx.runMutation(internal.providers.markTestedInternal, { connectionKey: a.connectionKey, ok: false, error: res.error.message });
      return { ok: false, message: res.error.message };
    }
    const probeId = `usopgrid_connection_test_${Date.now()}`;
    const r = await res.adapter.getStatus(res.ctx, { transactionId: probeId, reference: probeId, currency: "USD", providerReference: probeId });
    const authFail = r.failure?.category === "configuration_error";
    const unreachable = r.status === "unknown" && (r.failure?.category === "network_error" || r.failure?.category === "timeout");
    const ok = !authFail && !unreachable;
    const message = ok ? `${res.adapter.descriptor.displayName} accepted the credentials.` : (r.failure?.message ?? "Provider rejected the credentials.");
    await ctx.runMutation(internal.providers.markTestedInternal, { connectionKey: a.connectionKey, ok, error: ok ? undefined : message });
    return { ok, message };
  },
});

/** Provider health over N days for the org's environment. */
export const healthSeries = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const since = new Date(Date.now() - (a.days ?? 14) * 86_400_000).toISOString().slice(0, 10);
    const out: { provider: string; day: string; attempts: number; successRate: number | null; avgLatencyMs: number | null }[] = [];
    for (const d of listDescriptors()) {
      const rows = await ctx.db
        .query("providerHealth")
        .withIndex("by_provider_env_day", (q) => q.eq("provider", d.id).eq("environment", env).gte("day", since))
        .collect();
      for (const r of rows) {
        out.push({
          provider: d.id,
          day: r.day,
          attempts: r.charges,
          successRate: r.charges ? (r.successful + r.pending) / r.charges : null,
          avgLatencyMs: r.charges ? Math.round(r.latencySumMs / r.charges) : null,
        });
      }
    }
    return out;
  },
});
