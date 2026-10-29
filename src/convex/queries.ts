// USOPGRID dashboard read/write surface. Every query resolves tenant context
// server-side via requireOrgMember so data isolation holds regardless of UI.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { requireOrgMember, requirePermissionFor, getOrgForMember, requireSensitive } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { computeOverview, SUCCESS_LIKE } from "./lib/analytics";
import type { TransactionSummary, ProcessResult } from "./payments";
import type { Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Transactions list — filters + cursor pagination
// ---------------------------------------------------------------------------
export const listTransactions = query({
  args: {
    status: v.optional(v.string()),
    search: v.optional(v.string()),
    currency: v.optional(v.string()),
    paginationOpts: v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);

    const search = args.search?.trim().toLowerCase();
    if (search) {
      // Search across reference / transactionId / customer email. Index-backed
      // lookups; merge results in createdAt order client-safe.
      const byRef = await ctx.db
        .query("transactions")
        .withIndex("by_reference", (q) => q.eq("orgId", oc.orgId).eq("reference", search))
        .take(args.paginationOpts.numItems);
      const byTxnIdAll = await ctx.db
        .query("transactions")
        .withIndex("by_transaction_id", (q) => q.eq("transactionId", search))
        .take(args.paginationOpts.numItems);
      // Tenant isolation: transactionId is globally unique; filter post-fetch.
      const byTxnId = byTxnIdAll.filter((t) => t.orgId === oc.orgId);
      const byEmail = await ctx.db
        .query("transactions")
        .withIndex("by_org_email_created", (q) =>
          q.eq("orgId", oc.orgId).eq("customerEmail", search),
        )
        .order("desc")
        .take(args.paginationOpts.numItems);

      const seen = new Set<string>();
      const merged = [...byRef, ...byTxnId, ...byEmail]
        .filter((t) => {
          if (seen.has(t._id)) return false;
          seen.add(t._id);
          return true;
        })
        .sort((a, b) => b.createdAt - a.createdAt);

      return {
        page: merged,
        isDone: true,
        continueCursor: args.paginationOpts.cursor ?? "",
      };
    }

    if (args.status) {
      return ctx.db
        .query("transactions")
        .withIndex("by_org_status_created", (q) =>
          q
            .eq("orgId", oc.orgId)
            .eq("status", args.status as never)
            .gt("createdAt", 0),
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }

    return ctx.db
      .query("transactions")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// ---------------------------------------------------------------------------
// Transaction 360 — one complete view
// ---------------------------------------------------------------------------
export const getTransaction360 = query({
  args: { transactionId: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);

    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_transaction_id", (q) => q.eq("transactionId", args.transactionId))
      .unique();
    if (!txn || txn.orgId !== oc.orgId) return null; // tenant isolation

    const events = await ctx.db
      .query("transactionEvents")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect();
    events.sort((a, b) => a.at - b.at);

    const ledger = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect();
    ledger.sort((a, b) => a.at - b.at);

    const webhooks = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect();

    const merchant = await ctx.db.get(txn.merchantId);
    const attempts = await ctx.db.query("paymentAttempts").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect();
    const routing = await ctx.db.query("routingDecisions").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).first();
    const refunds = await ctx.db.query("refunds").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect();
    const recovery = await ctx.db.query("recoveryJobs").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect();

    return {
      transaction: txn,
      merchantName: merchant?.name ?? "Merchant",
      attempts: attempts
        .sort((a, b) => a.attempt - b.attempt)
        .map((a) => ({
          attempt: a.attempt,
          providerId: a.providerId,
          connectionId: a.connectionId,
          status: a.status,
          providerReference: a.providerReference ?? null,
          latencyMs: a.latencyMs,
          probe: a.probe,
          failure: a.failureCode ? { category: a.failureCategory ?? "", code: a.failureCode, message: a.failureMessage ?? "" } : null,
          startedAt: a.startedAt,
        })),
      routing: routing
        ? {
            explanation: routing.explanation,
            chain: routing.chain.map((c) => c.providerId),
            matchedRules: routing.matchedRules,
            evaluations: (routing.evaluations as { providerId: string; eligible: boolean; score: number; reasons: string[]; estimatedFeeMinor: number | null }[]).map((e) => ({
              providerId: e.providerId,
              eligible: e.eligible,
              score: e.score,
              reasons: e.reasons,
              estimatedFeeMinor: e.estimatedFeeMinor,
            })),
          }
        : null,
      refunds: refunds.map((r) => ({ refundId: r.refundId, amountMinor: r.amountMinor, status: r.status, reason: r.reason ?? null, createdAt: r.createdAt, providerRefundReference: r.providerRefundReference ?? null })),
      recovery: recovery.map((j) => ({ kind: j.kind, status: j.status, checksDone: j.checksDone, nextCheckAt: j.nextCheckAt, lastResult: j.lastResult ?? null })),
      events: events.map((e) => ({
        _id: e._id,
        type: e.type,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus ?? null,
        data: (e.data ?? null) as unknown,
        actor: e.actor,
        at: e.at,
      })),
      ledger: ledger.map((e) => ({
        _id: e._id,
        ledgerRef: e.ledgerRef,
        accountCode: e.accountCode,
        direction: e.direction,
        amountMinor: e.amountMinor,
        currency: e.currency,
        description: e.description,
        at: e.at,
      })),
      webhooks: webhooks.map((w) => ({
        _id: w._id,
        event: w.event,
        status: w.status,
        attempts: w.attempts,
        responseStatus: w.responseStatus ?? null,
        lastError: w.lastError ?? null,
        createdAt: w.createdAt,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Overview stats — computed from real transactions with the shared metric
// definitions in lib/analytics (currencies are never summed together).
// ---------------------------------------------------------------------------
export const getOverviewStats = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    const days = Math.min(Math.max(args.days ?? 30, 1), 365);
    const to = Date.now();
    const from = to - days * 86_400_000;
    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org_env_created", (q) => q.eq("orgId", oc.orgId).eq("environment", env).gte("createdAt", from))
      .take(20_000);
    const o = computeOverview(txns, from, to);

    const merchant = await ctx.db.query("merchants").withIndex("by_org", (q) => q.eq("orgId", oc.orgId)).first();
    const counts = Object.entries(o.volumeByCurrency).sort((a, b) => b[1] - a[1]);
    const primaryCurrency = merchant?.defaultCurrency ?? counts[0]?.[0] ?? oc.org.settings?.currency ?? "USD";
    const inPrimary = (r: { currency: string }) => r.currency === primaryCurrency;
    const seriesByDay = new Map(o.daily.map((d) => [d.day, { day: d.day, volume: 0, count: d.payments, successful: d.successful, failed: d.failed }]));
    for (const t of txns) {
      if (!inPrimary(t) || !SUCCESS_LIKE.has(t.status)) continue;
      const b = seriesByDay.get(new Date(t.createdAt).toISOString().slice(0, 10));
      if (b) b.volume += t.amountMinor;
    }
    return {
      environment: env,
      truncated: txns.length >= 20_000,
      primaryCurrency,
      volume: o.volumeByCurrency[primaryCurrency] ?? 0,
      fees: o.feesByCurrency[primaryCurrency] ?? 0,
      refunded: o.refundedByCurrency[primaryCurrency] ?? 0,
      volumeByCurrency: o.volumeByCurrency,
      successful: o.totals.successful,
      failed: o.totals.failed + o.totals.declined,
      declined: o.totals.declined,
      pending: o.totals.pending,
      exceptions: o.totals.exceptions,
      total: o.totals.payments,
      successRate: o.totals.successRate === null ? 0 : Math.round(o.totals.successRate * 1000) / 10,
      failoverRate: o.totals.failoverRate,
      series: [...seriesByDay.values()],
      currencyCounts: o.byCurrency.map((b) => ({ currency: b.key, count: b.count })),
      methodCounts: o.byMethod.map((b) => ({ method: b.key, count: b.count })),
      countryCounts: o.byCountry.map((b) => ({ country: b.key, count: b.count, successRate: b.successRate })),
      providerCounts: o.byProvider.map((b) => ({ provider: b.key, count: b.count, successRate: b.successRate })),
      failureCategories: o.failureReasons.map((r) => ({ category: r.category, code: r.code, count: r.count })),
      topMethod: o.byMethod[0]?.key ?? null,
    };
  },
});

// ---------------------------------------------------------------------------
// Dashboard-initiated payments — same engine as the API.
// Actions (not mutations) because the provider adapter call is async.
// ---------------------------------------------------------------------------
export const resolvePaymentContext = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.PAYMENTS_CREATE);
    const merchant = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .first();
    if (!merchant) throw new ConvexError("No merchant configured for this organization");
    if (merchant.status !== "active") {
      throw new ConvexError(`Merchant is ${merchant.status}; payments are disabled.`);
    }
    return {
      orgId: oc.orgId,
      merchantId: merchant._id,
      environment: (oc.org.environment ?? "sandbox") as "sandbox" | "production",
      currency: merchant.defaultCurrency,
      userId: oc.userId,
    };
  },
});

export const createDashboardPayment = action({
  args: {
    amountMinor: v.number(),
    currency: v.string(),
    reference: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    paymentMethod: v.string(),
    country: v.optional(v.string()),
    simulate: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TransactionSummary> => {
    const pc: { orgId: Id<"organizations">; merchantId: Id<"merchants">; environment: "sandbox" | "production"; userId: Id<"users"> } = await ctx.runQuery(api.queries.resolvePaymentContext, {});
    const reference = args.reference?.trim() || `dash_${Date.now().toString(36)}`;
    // Same engine as the public API, so behaviour is identical across entry points.
    const result: ProcessResult = await ctx.runAction(internal.payments.processPaymentInternal, {
      orgId: pc.orgId,
      merchantId: pc.merchantId,
      environment: pc.environment,
      amountMinor: args.amountMinor,
      currency: args.currency.toUpperCase(),
      reference,
      paymentMethod: args.paymentMethod,
      country: args.country?.toUpperCase() || undefined,
      customerEmail: args.customerEmail?.trim().toLowerCase() || undefined,
      customerName: args.customerName,
      description: args.description,
      // Simulation directives only ever reach sandbox rails.
      metadata: pc.environment === "sandbox" && args.simulate ? { simulate: args.simulate } : undefined,
      actor: pc.userId,
    });
    if (result.kind === "rejected" || !result.transaction) {
      throw new ConvexError(result.error?.message ?? "Payment could not be created.");
    }
    return result.transaction;
  },
});

export const resolveRefundContext = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.REFUNDS_CREATE);
    return { orgId: oc.orgId, userId: oc.userId };
  },
});

export const refundDashboardPayment = action({
  args: { transactionId: v.string(), amountMinor: v.optional(v.number()), reason: v.optional(v.string()) },
  handler: async (ctx, args): Promise<TransactionSummary> => {
    const rc: { orgId: Id<"organizations">; userId: Id<"users"> } = await ctx.runQuery(api.queries.resolveRefundContext, {});
    const result: { kind: "error" | "done"; message?: string; transaction?: TransactionSummary } = await ctx.runAction(internal.payments.refundInternal, {
      transactionId: args.transactionId,
      orgId: rc.orgId,
      amountMinor: args.amountMinor,
      reason: args.reason,
      actor: rc.userId,
    });
    if (result.kind === "error" || !result.transaction) throw new ConvexError(result.message ?? "Refund failed");
    return result.transaction;
  },
});
