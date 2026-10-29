// USOPGRID service layer: settlements, reconciliation, API keys, webhook
// endpoints. RBAC checks happen here, once, before any financial operation.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { requireOrgMember, requireOrgMemberAction, requireSensitive } from "./lib/rbac";
import { normaliseRules } from "./lib/ipallow";
import { PERMISSIONS } from "./schema";
import { generateApiKey, hashApiKey } from "./lib/apikeys";
import { randomToken } from "./lib/crypto";
import { logAudit } from "./lib/audit";

// Audit writer usable from actions. Mutations use logAudit directly.
interface AuditEntry {
  orgId?: string;
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
}
async function audit(ctx: ActionCtx, entry: AuditEntry) {
  await ctx.runMutation(internal.servicesInternal.auditInternal, {
    orgId: entry.orgId as never,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    before: entry.before,
    after: entry.after,
  });
}

// ---------------------------------------------------------------------------
// Settlement batches
// ---------------------------------------------------------------------------
export const listSettlementBatches = query({
  args: {
    paginationOpts: v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("settlementBatches")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getSettlementSummary = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const merchants = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .collect();

    const balances = [];
    for (const m of merchants) {
      const account = await ctx.db
        .query("ledgerAccounts")
        .withIndex("by_code", (q) => q.eq("code", `merch_${m._id}_${m.defaultCurrency}`))
        .unique();
      let balanceMinor = 0;
      if (account) {
        const entries = await ctx.db
          .query("ledgerEntries")
          .withIndex("by_account_at", (q) => q.eq("accountId", account._id))
          .collect();
        for (const e of entries) {
          balanceMinor += e.direction === "credit" ? e.amountMinor : -e.amountMinor;
        }
      }
      balances.push({
        merchantId: m._id,
        merchantName: m.name,
        currency: m.defaultCurrency,
        balanceMinor,
      });
    }
    return { balances };
  },
});

export const buildSettlementBatch = action({
  args: { merchantId: v.id("merchants"), currency: v.string() },
  handler: async (ctx, args): Promise<{ created: boolean; reason?: string; batchId?: string; reference?: string }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.SETTLEMENT_VIEW)) {
      throw new ConvexError("FORBIDDEN: missing permission 'settlement:view'");
    }
    const merchant = await ctx.runQuery(internal.servicesInternal.merchantByIdInternal, {
      merchantId: args.merchantId,
    });
    if (!merchant || merchant.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");

    const result = await ctx.runMutation(internal.settlements.buildBatchInternal, {
      orgId: oc.orgId,
      merchantId: args.merchantId,
      currency: args.currency,
    });
    await audit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "settlement.batch_built",
      resource: "merchant",
      resourceId: args.merchantId,
      after: result as unknown,
    });
    return result;
  },
});

export const settleSettlementBatch = action({
  args: { batchId: v.id("settlementBatches") },
  handler: async (ctx, args): Promise<unknown> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.SETTLEMENT_VIEW)) {
      throw new ConvexError("FORBIDDEN: missing permission 'settlement:view'");
    }
    const batch = await ctx.runQuery(internal.servicesInternal.batchByIdInternal, {
      batchId: args.batchId,
    });
    if (!batch || batch.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");

    const result = await ctx.runMutation(internal.settlements.settleBatchInternal, {
      batchId: args.batchId,
    });
    await audit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "settlement.marked_settled",
      resource: "settlementBatch",
      resourceId: args.batchId,
    });
    return result;
  },
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
export const runReconciliation = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; matched: number; findings: number; exceptionsCreated: number }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.SETTLEMENT_VIEW)) {
      throw new ConvexError("FORBIDDEN: missing permission 'settlement:view'");
    }
    const result = await ctx.runMutation(internal.settlements.reconcileInternal, {
      orgId: oc.orgId,
    });
    await audit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "recon.run",
      resource: "organization",
      resourceId: oc.orgId,
      after: result as unknown,
    });
    return result;
  },
});

export const listReconExceptions = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("reconExceptions")
      .withIndex("by_org_status_created", (q) => q.eq("orgId", oc.orgId).eq("status", "open"))
      .order("desc")
      .take(50);
  },
});

export const listBankRecords = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("bankRecords")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(50);
  },
});

export const resolveReconException = mutation({
  args: {
    exceptionId: v.id("reconExceptions"),
    resolution: v.union(v.literal("resolved"), v.literal("acknowledged")),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.SETTLEMENT_VIEW)) {
      throw new ConvexError("FORBIDDEN: missing permission 'settlement:view'");
    }
    const ex = await ctx.db.get(args.exceptionId);
    if (!ex || ex.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");
    await ctx.db.patch(args.exceptionId, { status: args.resolution, resolvedAt: Date.now() });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "recon.exception_resolved",
      resource: "reconException",
      resourceId: args.exceptionId,
      after: { resolution: args.resolution },
    });
  },
});

// ---------------------------------------------------------------------------
// API keys — shown once, stored hashed
// ---------------------------------------------------------------------------
export const listApiKeys = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .collect();
    return keys
      .sort((a, b) =>
        a.status === b.status ? b.createdAt - a.createdAt : a.status === "active" ? -1 : 1,
      )
      .map((k) => ({
        _id: k._id,
        name: k.name,
        environment: k.environment,
        mode: k.mode,
        prefix: k.prefix,
        status: k.status,
        scope: k.scope ?? "full",
        allowedIps: k.allowedIps ?? [],
        expiresAt: k.expiresAt ?? null,
        lastUsedAt: k.lastUsedAt ?? null,
        createdAt: k.createdAt,
      }));
  },
});

export const createApiKey = action({
  args: {
    name: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    mode: v.union(v.literal("secret"), v.literal("publishable")),
    scope: v.optional(v.union(v.literal("full"), v.literal("read_only"))),
    allowedIps: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ keyId: string; fullKey: string; prefix: string }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.KEYS_MANAGE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'keys:manage'");
    }
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.KEYS_MANAGE });
    let allowedIps: string[] = [];
    try {
      allowedIps = normaliseRules(args.allowedIps ?? []);
    } catch (err) {
      throw new ConvexError(err instanceof Error ? err.message : "Invalid IP allowlist");
    }
    const { full, prefix } = generateApiKey(args.environment, args.mode);
    const hash = await hashApiKey(full);
    const keyId = await ctx.runMutation(internal.servicesInternal.insertApiKeyInternal, {
      orgId: oc.orgId,
      name: args.name,
      environment: args.environment,
      mode: args.mode,
      prefix,
      hash,
      userId: oc.userId,
      scope: args.scope ?? "full",
      allowedIps,
    });
    await audit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "key.created",
      resource: "apiKey",
      resourceId: keyId,
      after: { name: args.name, environment: args.environment, mode: args.mode, prefix, scope: args.scope ?? "full", allowedIps },
    });
    return { keyId, fullKey: full, prefix };
  },
});

export const revokeApiKey = mutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.KEYS_MANAGE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'keys:manage'");
    }
    const key = await ctx.db.get(args.keyId);
    if (!key || key.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");
    await ctx.db.patch(args.keyId, { status: "revoked" });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "key.revoked",
      resource: "apiKey",
      resourceId: args.keyId,
      before: { status: key.status },
      after: { status: "revoked" },
    });
  },
});

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------
export const listWebhookEndpoints = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const endpoints = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .collect();
    return endpoints.map((e) => ({
      _id: e._id,
      url: e.url,
      events: e.events,
      status: e.status,
      secret: e.secret, // developers need this to verify signatures
      createdAt: e.createdAt,
    }));
  },
});

export const createWebhookEndpoint = mutation({
  args: { url: v.string(), events: v.array(v.string()) },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.WEBHOOKS_MANAGE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'webhooks:manage'");
    }
    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      throw new ConvexError("VALIDATION_ERROR: url must be a valid absolute URL");
    }
    if (parsed.protocol !== "https:") {
      throw new ConvexError("VALIDATION_ERROR: webhook URLs must use HTTPS");
    }
    const secret = `whsec_${randomToken(24)}`;
    const id = await ctx.db.insert("webhookEndpoints", {
      orgId: oc.orgId,
      url: args.url,
      events: args.events.length > 0 ? args.events : ["*"],
      secret,
      status: "active",
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "webhook.created",
      resource: "webhookEndpoint",
      resourceId: id,
      after: { url: args.url, events: args.events },
    });
    return { _id: id, secret };
  },
});

export const toggleWebhookEndpoint = mutation({
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.WEBHOOKS_MANAGE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'webhooks:manage'");
    }
    const ep = await ctx.db.get(args.endpointId);
    if (!ep || ep.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");
    const status = ep.status === "active" ? "disabled" : "active";
    await ctx.db.patch(args.endpointId, { status });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "webhook.status_changed",
      resource: "webhookEndpoint",
      resourceId: args.endpointId,
      after: { status },
    });
  },
});

export const listWebhookDeliveries = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("webhookDeliveries")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(50);
  },
});

// Re-queue a failed/dead delivery (: replay). Tenant-checked.
export const replayWebhookDelivery = mutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.WEBHOOKS_MANAGE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'webhooks:manage'");
    }
    const d = await ctx.db.get(args.deliveryId);
    if (!d || d.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");
    await ctx.db.patch(args.deliveryId, {
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: undefined,
    });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "webhook.replayed",
      resource: "webhookDelivery",
      resourceId: args.deliveryId,
    });
  },
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
export const listAuditLogs = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.AUDIT_VIEW)) return [];
    return ctx.db
      .query("auditLogs")
      .withIndex("by_org_at", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(100);
  },
});

/**
 * Rotate a key: issue a replacement with the same name/environment/mode and
 * keep the old key working for a grace period (default 24 h) so deployments
 * can roll over without downtime. The old key is then refused automatically.
 */
/** Change a key's scope or IP allowlist (step-up when MFA is on or required). */
export const setApiKeyRestrictions = mutation({
  args: {
    keyId: v.id("apiKeys"),
    scope: v.union(v.literal("full"), v.literal("read_only")),
    allowedIps: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.KEYS_MANAGE);
    const key = await ctx.db.get(args.keyId);
    if (!key || key.orgId !== oc.orgId || key.status !== "active") throw new ConvexError("NOT_FOUND: active key");
    let allowedIps: string[];
    try {
      allowedIps = normaliseRules(args.allowedIps);
    } catch (err) {
      throw new ConvexError(err instanceof Error ? err.message : "Invalid IP allowlist");
    }
    await ctx.db.patch(args.keyId, { scope: args.scope, allowedIps });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "key.restrictions_changed",
      resource: "apiKey",
      resourceId: args.keyId,
      before: { scope: key.scope ?? "full", allowedIps: key.allowedIps ?? [] },
      after: { scope: args.scope, allowedIps },
    });
  },
});

export const rotateApiKey = action({
  args: { keyId: v.id("apiKeys"), graceHours: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ keyId: string; fullKey: string; prefix: string; oldKeyExpiresAt: number }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.KEYS_MANAGE)) throw new ConvexError("FORBIDDEN: missing permission 'keys:manage'");
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.KEYS_MANAGE });
    const old = await ctx.runQuery(internal.servicesInternal.apiKeyByIdInternal, { keyId: args.keyId });
    if (!old || old.orgId !== oc.orgId || old.status !== "active") throw new ConvexError("NOT_FOUND: active key");
    const { full, prefix } = generateApiKey(old.environment, old.mode);
    const hash = await hashApiKey(full);
    const keyId = await ctx.runMutation(internal.servicesInternal.insertApiKeyInternal, {
      orgId: oc.orgId,
      name: old.name,
      environment: old.environment,
      mode: old.mode,
      prefix,
      hash,
      userId: oc.userId,
      // The replacement keeps the same restrictions.
      scope: old.scope ?? "full",
      allowedIps: old.allowedIps ?? [],
    });
    const grace = Math.min(Math.max(args.graceHours ?? 24, 0), 168);
    const oldKeyExpiresAt = Date.now() + grace * 3_600_000;
    await ctx.runMutation(internal.servicesInternal.expireApiKeyInternal, { keyId: args.keyId, expiresAt: oldKeyExpiresAt, rotatedToKeyId: keyId });
    await audit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "key.rotated", resource: "apiKey", resourceId: args.keyId, after: { newKeyId: keyId, newPrefix: prefix, oldKeyExpiresAt } });
    return { keyId, fullKey: full, prefix, oldKeyExpiresAt };
  },
});
