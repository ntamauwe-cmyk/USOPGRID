// Recurring billing: saved payment methods, plans, subscriptions, invoices.
//
// - Saved payment methods are provider-issued reusable tokens (Paystack
//   authorizations, Flutterwave card tokens, Stripe customer+payment method,
//   sandbox tokens), sealed with the keyring and bound to the connection that
//   issued them. USOPGRID never sees or stores card numbers.
// - A scheduled job renews due subscriptions: one invoice per period, charged
//   merchant-initiated at the issuing provider only (tokens are not portable).
// - Failed renewals retry on DUNNING_DAYS when the failure can recover
//   (insufficient funds, provider trouble); hard declines stop immediately.
// - Every attempt is a normal USOPGRID payment (ledger, webhooks, recovery),
//   with an invoice-derived reference and idempotency key per attempt.

import { v, ConvexError } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember, requireOrgMemberAction, requirePermissionFor } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { randomToken, sha256Hex } from "./lib/crypto";
import { keyringConfigured, open, seal } from "./lib/keyring";
import { enqueueOrgEvent } from "./lib/events";
import { addInterval, describeInterval, INTERVALS, isRetryableRenewalFailure, nextRetryAt, type Interval } from "./lib/billing";
import { getAdapter } from "./providers/index";
import type { ReusableToken } from "./providers/types";
import { formatMoney, isSupportedCurrency } from "../lib/money";
import type { TransactionSummary, ProcessResult } from "./payments";
import type { RoutingContext } from "./connections";

const intervalV = v.union(v.literal("day"), v.literal("week"), v.literal("month"), v.literal("year"));
const envV = v.union(v.literal("sandbox"), v.literal("production"));
const DUE_BATCH = 25;

// ---------------------------------------------------------------------------
// Saved payment methods
// ---------------------------------------------------------------------------
const aadFor = (orgId: string, methodId: string) => `pm:${orgId}:${methodId}`;

/** Seal and store a provider token (callable from actions and HTTP actions). */
export async function savePaymentMethodFromAction(
  ctx: ActionCtx,
  a: { orgId: Id<"organizations">; environment: "sandbox" | "production"; customerEmail: string; providerId: string; connectionId: string; token: ReusableToken; sourceTransactionId?: string },
): Promise<string> {
  if (!keyringConfigured()) {
    if (a.environment === "production") throw new Error("Encryption key is not configured; payment methods cannot be saved.");
  }
  const methodId = `pm_${randomToken(22)}`;
  const tokenHash = await sha256Hex(`${a.providerId}:${a.token.token}`);
  const sealedToken = keyringConfigured() ? await seal(a.token.token, aadFor(a.orgId, methodId)) : `plain:${a.token.token}`;
  return await ctx.runMutation(internal.billing.storePaymentMethodInternal, {
    orgId: a.orgId,
    environment: a.environment,
    methodId,
    customerEmail: a.customerEmail.toLowerCase(),
    providerId: a.providerId,
    connectionId: a.connectionId,
    sealedToken,
    tokenHash,
    brand: a.token.brand?.slice(0, 24),
    last4: a.token.last4 && /^\d{4}$/.test(a.token.last4) ? a.token.last4 : undefined,
    expMonth: a.token.expMonth,
    expYear: a.token.expYear,
    sourceTransactionId: a.sourceTransactionId,
  });
}

async function openToken(pm: Doc<"paymentMethods">): Promise<string> {
  if (pm.sealedToken.startsWith("plain:")) {
    if (pm.environment === "production") throw new Error("Saved payment method is not encrypted; refusing to use it in production.");
    return pm.sealedToken.slice(6);
  }
  return open(pm.sealedToken, aadFor(pm.orgId, pm.methodId));
}

export const storePaymentMethodInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    environment: envV,
    methodId: v.string(),
    customerEmail: v.string(),
    providerId: v.string(),
    connectionId: v.string(),
    sealedToken: v.string(),
    tokenHash: v.string(),
    brand: v.optional(v.string()),
    last4: v.optional(v.string()),
    expMonth: v.optional(v.number()),
    expYear: v.optional(v.number()),
    sourceTransactionId: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const dup = await ctx.db.query("paymentMethods").withIndex("by_org_token", (q) => q.eq("orgId", a.orgId).eq("tokenHash", a.tokenHash)).first();
    if (dup && dup.status === "active") return dup.methodId;
    await ctx.db.insert("paymentMethods", { ...a, status: "active", createdAt: Date.now() });
    await logAudit(ctx, { orgId: a.orgId, actor: "system", action: "payment_method.saved", resource: "paymentMethod", resourceId: a.methodId, after: { provider: a.providerId, brand: a.brand, last4: a.last4, customer: a.customerEmail } });
    await enqueueOrgEvent(ctx, a.orgId, a.environment === "production", "payment_method.saved", { id: a.methodId, customer_email: a.customerEmail, provider: a.providerId, brand: a.brand ?? null, last4: a.last4 ?? null, source_payment: a.sourceTransactionId ?? null });
    return a.methodId;
  },
});

/** Import a token the merchant obtained through the provider's own SDK. */
export const importPaymentMethodInternal = internalAction({
  args: { orgId: v.id("organizations"), environment: envV, providerId: v.string(), token: v.string(), customerEmail: v.string(), brand: v.optional(v.string()), last4: v.optional(v.string()), expMonth: v.optional(v.number()), expYear: v.optional(v.number()) },
  handler: async (ctx, a): Promise<{ methodId?: string; error?: string }> => {
    const adapter = getAdapter(a.providerId);
    if (!adapter) return { error: `Unknown provider '${a.providerId}'.` };
    if (!adapter.descriptor.operations.recurring) return { error: `${adapter.descriptor.displayName} saved payment methods are not supported for recurring charges yet. Supported: Paystack, Flutterwave, Stripe.` };
    const rc: RoutingContext = await ctx.runQuery(internal.connections.routingContextInternal, { orgId: a.orgId, environment: a.environment });
    const conn = rc.candidates.filter((c) => c.providerId === a.providerId && c.enabled).sort((x, y) => y.priority - x.priority)[0];
    if (!conn) return { error: `No enabled ${adapter.descriptor.displayName} connection in the ${a.environment} environment.` };
    if (a.token.length < 6 || a.token.length > 300) return { error: "token looks invalid." };
    const methodId = await savePaymentMethodFromAction(ctx, {
      orgId: a.orgId,
      environment: a.environment,
      customerEmail: a.customerEmail,
      providerId: a.providerId,
      connectionId: conn.connectionId,
      token: { token: a.token, brand: a.brand, last4: a.last4, expMonth: a.expMonth, expYear: a.expYear },
    });
    return { methodId };
  },
});

export const listPaymentMethodsInternal = internalQuery({
  args: { orgId: v.id("organizations"), customerEmail: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const rows = a.customerEmail
      ? await ctx.db.query("paymentMethods").withIndex("by_org_customer", (q) => q.eq("orgId", a.orgId).eq("customerEmail", a.customerEmail!.toLowerCase())).collect()
      : await ctx.db.query("paymentMethods").withIndex("by_org_customer", (q) => q.eq("orgId", a.orgId)).take(200);
    return rows.map(pmJson);
  },
});

export function pmJson(p: Doc<"paymentMethods">) {
  return { id: p.methodId, customer_email: p.customerEmail, provider: p.providerId, brand: p.brand ?? null, last4: p.last4 ?? null, exp_month: p.expMonth ?? null, exp_year: p.expYear ?? null, status: p.status, livemode: p.environment === "production", created_at: new Date(p.createdAt).toISOString() };
}

export const revokePaymentMethodInternal = internalMutation({
  args: { orgId: v.id("organizations"), methodId: v.string(), actor: v.string() },
  handler: async (ctx, a) => {
    const p = await ctx.db.query("paymentMethods").withIndex("by_method_id", (q) => q.eq("methodId", a.methodId)).unique();
    if (!p || p.orgId !== a.orgId) return null;
    // Destroy the token: a revoked method can never be charged again.
    await ctx.db.patch(p._id, { status: "revoked", sealedToken: "revoked" });
    await logAudit(ctx, { orgId: a.orgId, actor: a.actor, action: "payment_method.revoked", resource: "paymentMethod", resourceId: a.methodId });
    return pmJson({ ...p, status: "revoked" });
  },
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
function validatePlan(a: { name: string; amountMinor: number; currency: string; interval: string; intervalCount: number; trialDays?: number }): string | null {
  if (!a.name.trim() || a.name.length > 120) return "name is required (up to 120 characters).";
  if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) return "amount must be a positive integer of minor units.";
  if (!isSupportedCurrency(a.currency)) return `Unsupported currency '${a.currency}'.`;
  if (!(INTERVALS as readonly string[]).includes(a.interval)) return "interval must be day, week, month or year.";
  if (!Number.isInteger(a.intervalCount) || a.intervalCount < 1 || a.intervalCount > 36) return "interval_count must be between 1 and 36.";
  if (a.trialDays !== undefined && (!Number.isInteger(a.trialDays) || a.trialDays < 0 || a.trialDays > 365)) return "trial_days must be between 0 and 365.";
  return null;
}

export const createPlanInternal = internalMutation({
  args: { orgId: v.id("organizations"), name: v.string(), amountMinor: v.number(), currency: v.string(), interval: intervalV, intervalCount: v.number(), trialDays: v.optional(v.number()), actor: v.string() },
  handler: async (ctx, a) => {
    const err = validatePlan(a);
    if (err) throw new ConvexError(`VALIDATION_ERROR: ${err}`);
    const planId = `plan_${randomToken(16)}`;
    const doc = { orgId: a.orgId, planId, name: a.name.trim(), amountMinor: a.amountMinor, currency: a.currency.toUpperCase(), interval: a.interval, intervalCount: a.intervalCount, trialDays: a.trialDays, active: true, createdAt: Date.now() };
    await ctx.db.insert("plans", doc);
    await logAudit(ctx, { orgId: a.orgId, actor: a.actor, action: "plan.created", resource: "plan", resourceId: planId, after: { name: doc.name, amount: formatMoney(doc.amountMinor, doc.currency), every: describeInterval(a.interval, a.intervalCount) } });
    return planJson(doc);
  },
});

export function planJson(p: Pick<Doc<"plans">, "planId" | "name" | "amountMinor" | "currency" | "interval" | "intervalCount" | "trialDays" | "active" | "createdAt">) {
  return { id: p.planId, name: p.name, amount: p.amountMinor, currency: p.currency, interval: p.interval, interval_count: p.intervalCount, trial_days: p.trialDays ?? 0, active: p.active, description: `${formatMoney(p.amountMinor, p.currency)} · ${describeInterval(p.interval, p.intervalCount)}`, created_at: new Date(p.createdAt).toISOString() };
}

export const listPlansInternal = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, a) => (await ctx.db.query("plans").withIndex("by_org", (q) => q.eq("orgId", a.orgId)).collect()).sort((x, y) => y.createdAt - x.createdAt).map(planJson),
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
export function subscriptionJson(s: Doc<"subscriptions">, plan?: Doc<"plans"> | null) {
  return {
    id: s.subscriptionId,
    status: s.status,
    plan: plan ? planJson(plan) : { id: s.planId },
    customer_email: s.customerEmail,
    customer_name: s.customerName ?? null,
    payment_method: s.paymentMethodId,
    current_period_start: new Date(s.currentPeriodStart).toISOString(),
    current_period_end: new Date(s.currentPeriodEnd).toISOString(),
    next_charge_at: s.status === "canceled" || s.status === "unpaid" ? null : new Date(s.nextChargeAt).toISOString(),
    failed_attempts: s.failedAttempts,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt ? new Date(s.canceledAt).toISOString() : null,
    livemode: s.environment === "production",
    metadata: s.metadata ?? null,
    created_at: new Date(s.createdAt).toISOString(),
  };
}

export const createSubscriptionInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    merchantId: v.id("merchants"),
    environment: envV,
    planId: v.string(),
    paymentMethodId: v.string(),
    customerName: v.optional(v.string()),
    trialDays: v.optional(v.number()),
    metadata: v.optional(v.any()),
    actor: v.string(),
  },
  handler: async (ctx, a) => {
    const plan = await ctx.db.query("plans").withIndex("by_plan_id", (q) => q.eq("planId", a.planId)).unique();
    if (!plan || plan.orgId !== a.orgId) throw new ConvexError("NOT_FOUND: plan");
    if (!plan.active) throw new ConvexError("VALIDATION_ERROR: this plan is archived");
    const pm = await ctx.db.query("paymentMethods").withIndex("by_method_id", (q) => q.eq("methodId", a.paymentMethodId)).unique();
    if (!pm || pm.orgId !== a.orgId || pm.status !== "active") throw new ConvexError("NOT_FOUND: active payment method");
    if (pm.environment !== a.environment) throw new ConvexError(`VALIDATION_ERROR: payment method belongs to the ${pm.environment} environment`);
    const adapter = getAdapter(pm.providerId);
    if (!adapter?.descriptor.operations.recurring) throw new ConvexError(`VALIDATION_ERROR: ${pm.providerId} does not support recurring charges`);
    const trialDays = a.trialDays ?? plan.trialDays ?? 0;
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) throw new ConvexError("VALIDATION_ERROR: trial_days must be between 0 and 365");
    const now = Date.now();
    const start = trialDays > 0 ? now + trialDays * 86_400_000 : now;
    const subscriptionId = `sub_${randomToken(18)}`;
    const id = await ctx.db.insert("subscriptions", {
      orgId: a.orgId,
      merchantId: a.merchantId,
      environment: a.environment,
      subscriptionId,
      planId: plan.planId,
      customerEmail: pm.customerEmail,
      customerName: a.customerName?.slice(0, 200),
      paymentMethodId: pm.methodId,
      status: trialDays > 0 ? "trialing" : "active",
      // The first billed period starts at currentPeriodEnd (now, or when the trial ends).
      currentPeriodStart: now,
      currentPeriodEnd: start,
      anchorDay: new Date(start).getUTCDate(),
      nextChargeAt: start,
      failedAttempts: 0,
      cancelAtPeriodEnd: false,
      metadata: a.metadata,
      createdAt: now,
      updatedAt: now,
    });
    const s = (await ctx.db.get(id))!;
    await logAudit(ctx, { orgId: a.orgId, actor: a.actor, action: "subscription.created", resource: "subscription", resourceId: subscriptionId, after: { plan: plan.name, customer: pm.customerEmail, trialDays } });
    await enqueueOrgEvent(ctx, a.orgId, a.environment === "production", "subscription.created", subscriptionJson(s, plan));
    return subscriptionJson(s, plan);
  },
});

export const cancelSubscriptionInternal = internalMutation({
  args: { orgId: v.id("organizations"), subscriptionId: v.string(), atPeriodEnd: v.boolean(), actor: v.string() },
  handler: async (ctx, a) => {
    const s = await ctx.db.query("subscriptions").withIndex("by_subscription_id", (q) => q.eq("subscriptionId", a.subscriptionId)).unique();
    if (!s || s.orgId !== a.orgId) throw new ConvexError("NOT_FOUND: subscription");
    if (s.status === "canceled") return subscriptionJson(s, await planOf(ctx, s));
    const now = Date.now();
    const patch = a.atPeriodEnd && s.status !== "unpaid" ? { cancelAtPeriodEnd: true, updatedAt: now } : { status: "canceled" as const, canceledAt: now, updatedAt: now };
    await ctx.db.patch(s._id, patch);
    const updated = (await ctx.db.get(s._id))!;
    await logAudit(ctx, { orgId: a.orgId, actor: a.actor, action: a.atPeriodEnd ? "subscription.cancel_scheduled" : "subscription.canceled", resource: "subscription", resourceId: s.subscriptionId });
    if (!a.atPeriodEnd) await enqueueOrgEvent(ctx, s.orgId, s.environment === "production", "subscription.canceled", subscriptionJson(updated, await planOf(ctx, s)));
    return subscriptionJson(updated, await planOf(ctx, s));
  },
});

async function planOf(ctx: MutationCtx | { db: MutationCtx["db"] }, s: Doc<"subscriptions">) {
  return ctx.db.query("plans").withIndex("by_plan_id", (q) => q.eq("planId", s.planId)).unique();
}

export const listSubscriptionsInternal = internalQuery({
  args: { orgId: v.id("organizations"), limit: v.number() },
  handler: async (ctx, a) => {
    const subs = await ctx.db.query("subscriptions").withIndex("by_org_created", (q) => q.eq("orgId", a.orgId)).order("desc").take(Math.min(a.limit, 200));
    const plans = new Map<string, Doc<"plans"> | null>();
    for (const s of subs) if (!plans.has(s.planId)) plans.set(s.planId, await ctx.db.query("plans").withIndex("by_plan_id", (q) => q.eq("planId", s.planId)).unique());
    return subs.map((s) => subscriptionJson(s, plans.get(s.planId)));
  },
});

export const getSubscriptionInternal = internalQuery({
  args: { orgId: v.id("organizations"), subscriptionId: v.string() },
  handler: async (ctx, a) => {
    const s = await ctx.db.query("subscriptions").withIndex("by_subscription_id", (q) => q.eq("subscriptionId", a.subscriptionId)).unique();
    if (!s || s.orgId !== a.orgId) return null;
    const plan = await ctx.db.query("plans").withIndex("by_plan_id", (q) => q.eq("planId", s.planId)).unique();
    const invs = await ctx.db.query("invoices").withIndex("by_subscription_period", (q) => q.eq("subscriptionId", s.subscriptionId)).order("desc").take(24);
    return {
      ...subscriptionJson(s, plan),
      invoices: invs.map((i) => ({ id: i.invoiceId, status: i.status, amount: i.amountMinor, currency: i.currency, period_start: new Date(i.periodStart).toISOString(), period_end: new Date(i.periodEnd).toISOString(), attempts: i.attempts, payment: i.transactionId ?? null, last_error: i.lastError ?? null, paid_at: i.paidAt ? new Date(i.paidAt).toISOString() : null })),
    };
  },
});

// ---------------------------------------------------------------------------
// Renewal engine
// ---------------------------------------------------------------------------
export const dueSubscriptionsInternal = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, a) => {
    const out: Id<"subscriptions">[] = [];
    for (const status of ["trialing", "active", "past_due"] as const) {
      const rows = await ctx.db.query("subscriptions").withIndex("by_status_next", (q) => q.eq("status", status).lte("nextChargeAt", a.now)).take(DUE_BATCH);
      out.push(...rows.map((r) => r._id));
    }
    return out.slice(0, DUE_BATCH);
  },
});

/** Atomically pick up a due renewal: opens the period's invoice (once) and claims an attempt. */
export const claimRenewalInternal = internalMutation({
  args: { subId: v.id("subscriptions"), now: v.number() },
  handler: async (ctx, a) => {
    const s = await ctx.db.get(a.subId);
    if (!s || s.nextChargeAt > a.now || !["trialing", "active", "past_due"].includes(s.status)) return null;
    const plan = await planOf(ctx, s);
    if (s.cancelAtPeriodEnd || !plan) {
      await ctx.db.patch(s._id, { status: "canceled", canceledAt: a.now, updatedAt: a.now });
      await enqueueOrgEvent(ctx, s.orgId, s.environment === "production", "subscription.canceled", subscriptionJson({ ...s, status: "canceled", canceledAt: a.now }, plan));
      return null;
    }
    const periodStart = s.currentPeriodEnd;
    let inv = await ctx.db.query("invoices").withIndex("by_subscription_period", (q) => q.eq("subscriptionId", s.subscriptionId).eq("periodStart", periodStart)).unique();
    if (!inv) {
      const invoiceId = `inv_${randomToken(18)}`;
      const docId = await ctx.db.insert("invoices", {
        orgId: s.orgId,
        invoiceId,
        subscriptionId: s.subscriptionId,
        periodStart,
        periodEnd: addInterval(periodStart, plan.interval as Interval, plan.intervalCount, s.anchorDay),
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        status: "open",
        attempts: 0,
        createdAt: a.now,
      });
      inv = (await ctx.db.get(docId))!;
    }
    if (inv.status !== "open") return inv.status === "processing" ? { reconcile: true as const, invoice: inv, sub: s } : null;
    await ctx.db.patch(inv._id, { status: "processing", attempts: inv.attempts + 1 });
    // Hold the subscription until the attempt resolves (avoids double pick-up).
    await ctx.db.patch(s._id, { nextChargeAt: a.now + 30 * 60_000, updatedAt: a.now });
    return { reconcile: false as const, invoice: { ...inv, attempts: inv.attempts + 1 }, sub: s };
  },
});

export const settleInvoiceInternal = internalMutation({
  args: {
    invoiceDocId: v.id("invoices"),
    outcome: v.union(v.literal("paid"), v.literal("failed"), v.literal("pending")),
    transactionId: v.optional(v.string()),
    failureCategory: v.optional(v.string()),
    failureMessage: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, a) => {
    const inv = await ctx.db.get(a.invoiceDocId);
    if (!inv || inv.status === "paid" || inv.status === "void") return;
    const s = await ctx.db.query("subscriptions").withIndex("by_subscription_id", (q) => q.eq("subscriptionId", inv.subscriptionId)).unique();
    if (!s) return;
    const plan = await planOf(ctx, s);
    const live = s.environment === "production";
    if (a.outcome === "pending") {
      await ctx.db.patch(inv._id, { status: "processing", transactionId: a.transactionId ?? inv.transactionId });
      await ctx.db.patch(s._id, { nextChargeAt: a.now + 15 * 60_000, updatedAt: a.now });
      return;
    }
    if (a.outcome === "paid") {
      await ctx.db.patch(inv._id, { status: "paid", transactionId: a.transactionId ?? inv.transactionId, paidAt: a.now, lastError: undefined });
      await ctx.db.patch(s._id, { status: "active", currentPeriodStart: inv.periodStart, currentPeriodEnd: inv.periodEnd, nextChargeAt: inv.periodEnd, failedAttempts: 0, updatedAt: a.now });
      const pm = await ctx.db.query("paymentMethods").withIndex("by_method_id", (q) => q.eq("methodId", s.paymentMethodId)).unique();
      if (pm) await ctx.db.patch(pm._id, { lastUsedAt: a.now });
      const updated = (await ctx.db.get(s._id))!;
      await enqueueOrgEvent(ctx, s.orgId, live, "invoice.paid", { id: inv.invoiceId, subscription: s.subscriptionId, amount: inv.amountMinor, currency: inv.currency, payment: a.transactionId ?? null });
      await enqueueOrgEvent(ctx, s.orgId, live, "subscription.renewed", subscriptionJson(updated, plan));
      return;
    }
    // Failed attempt: retry on schedule when the failure can recover, else stop.
    const failed = s.failedAttempts + 1;
    const retryAt = isRetryableRenewalFailure(a.failureCategory) ? nextRetryAt(failed, a.now) : null;
    await ctx.db.patch(inv._id, { status: retryAt ? "open" : "failed", transactionId: a.transactionId ?? inv.transactionId, lastError: a.failureMessage?.slice(0, 300) });
    await enqueueOrgEvent(ctx, s.orgId, live, "invoice.payment_failed", { id: inv.invoiceId, subscription: s.subscriptionId, amount: inv.amountMinor, currency: inv.currency, attempt: inv.attempts, failure: { category: a.failureCategory ?? null, message: a.failureMessage ?? null }, next_retry_at: retryAt ? new Date(retryAt).toISOString() : null });
    if (retryAt) {
      await ctx.db.patch(s._id, { status: "past_due", failedAttempts: failed, nextChargeAt: retryAt, updatedAt: a.now });
      if (s.status !== "past_due") await enqueueOrgEvent(ctx, s.orgId, live, "subscription.past_due", subscriptionJson({ ...s, status: "past_due", failedAttempts: failed, nextChargeAt: retryAt }, plan));
    } else {
      await ctx.db.patch(s._id, { status: "unpaid", failedAttempts: failed, updatedAt: a.now });
      await enqueueOrgEvent(ctx, s.orgId, live, "subscription.unpaid", subscriptionJson({ ...s, status: "unpaid", failedAttempts: failed }, plan));
      await ctx.db.insert("notifications", { orgId: s.orgId, kind: "subscription_unpaid", severity: "warning", title: "A subscription stopped after failed renewals", body: `${s.customerEmail}: ${a.failureMessage ?? "payment failed"}`, link: "/dashboard/billing", readBy: [], createdAt: a.now });
    }
  },
});

export const paymentMethodByIdInternal = internalQuery({
  args: { methodId: v.string() },
  handler: async (ctx, a) => ctx.db.query("paymentMethods").withIndex("by_method_id", (q) => q.eq("methodId", a.methodId)).unique(),
});

const FINAL_FAIL = new Set(["FAILED", "DECLINED", "CANCELLED", "EXPIRED"]);

async function renewOne(ctx: ActionCtx, subId: Id<"subscriptions">, now: number): Promise<string> {
  const claim = await ctx.runMutation(internal.billing.claimRenewalInternal, { subId, now });
  if (!claim) return "skipped";
  const { invoice, sub } = claim;
  if (claim.reconcile) {
    // An earlier attempt is still settling: look at its payment, never re-charge blindly.
    if (!invoice.transactionId) {
      // Claimed but no payment was created (crash between steps): reopen for a new attempt.
      await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "failed", failureCategory: "temporary_provider_failure", failureMessage: "Renewal attempt interrupted; retrying.", now });
      return "reopened";
    }
    const t = await ctx.runQuery(internal.payments.transactionByTransactionId, { transactionId: invoice.transactionId });
    if (!t) return "missing";
    if (t.status === "SUCCESSFUL") await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "paid", transactionId: t.transactionId, now });
    else if (FINAL_FAIL.has(t.status)) await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "failed", transactionId: t.transactionId, failureCategory: t.failureCategory, failureMessage: t.failureMessage, now });
    else await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "pending", transactionId: t.transactionId, now });
    return "reconciled";
  }
  const pm = await ctx.runQuery(internal.billing.paymentMethodByIdInternal, { methodId: sub.paymentMethodId });
  if (!pm || pm.status !== "active") {
    await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "failed", failureCategory: "invalid_payment_information", failureMessage: "The saved payment method was removed.", now });
    return "no_method";
  }
  let token: string;
  try {
    token = await openToken(pm);
  } catch (err) {
    await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "failed", failureCategory: "configuration_error", failureMessage: err instanceof Error ? err.message : "Could not read saved payment method.", now });
    return "unreadable";
  }
  const result: ProcessResult = await ctx.runAction(internal.payments.processPaymentInternal, {
    orgId: sub.orgId,
    merchantId: sub.merchantId,
    environment: sub.environment,
    amountMinor: invoice.amountMinor,
    currency: invoice.currency,
    reference: `${invoice.invoiceId}-${invoice.attempts}`,
    paymentMethod: "card",
    customerEmail: sub.customerEmail,
    customerName: sub.customerName,
    paymentToken: token,
    description: `Subscription ${sub.subscriptionId}`,
    metadata: { ...(sub.metadata && typeof sub.metadata === "object" ? sub.metadata : {}), subscription_id: sub.subscriptionId, invoice_id: invoice.invoiceId },
    idempotencyKey: `${invoice.invoiceId}:${invoice.attempts}`,
    actor: "billing",
    recurring: true,
    pinnedConnectionId: pm.connectionId,
    invoiceId: invoice._id,
  });
  const t: TransactionSummary | undefined = result.transaction;
  if (result.kind === "rejected" || !t) {
    await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "failed", failureCategory: "invalid_payment_information", failureMessage: result.error?.message ?? "Renewal could not be created.", now });
    return "rejected";
  }
  if (t.status === "SUCCESSFUL") await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "paid", transactionId: t.transactionId, now });
  else if (FINAL_FAIL.has(t.status)) await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "failed", transactionId: t.transactionId, failureCategory: t.failure?.category, failureMessage: t.failure?.message, now });
  else await ctx.runMutation(internal.billing.settleInvoiceInternal, { invoiceDocId: invoice._id, outcome: "pending", transactionId: t.transactionId, now });
  return t.status;
}

/** Cron: renew due subscriptions and settle renewals whose payments resolved. */
export const runDue = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number }> => {
    const now = Date.now();
    const ids: Id<"subscriptions">[] = await ctx.runQuery(internal.billing.dueSubscriptionsInternal, { now });
    for (const id of ids) {
      try {
        await renewOne(ctx, id, now);
      } catch (err) {
        console.error("[billing] renewal error", id, err instanceof Error ? err.message : err);
      }
    }
    return { processed: ids.length };
  },
});

// ---------------------------------------------------------------------------
// Dashboard surface
// ---------------------------------------------------------------------------
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const plans = (await ctx.db.query("plans").withIndex("by_org", (q) => q.eq("orgId", oc.orgId)).collect()).sort((a, b) => b.createdAt - a.createdAt);
    const subs = await ctx.db.query("subscriptions").withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId)).order("desc").take(200);
    const planById = new Map(plans.map((p) => [p.planId, p]));
    const env = oc.org.environment ?? "sandbox";
    const mrr: Record<string, number> = {};
    for (const s of subs) {
      const p = planById.get(s.planId);
      if (!p || (s.status !== "active" && s.status !== "past_due") || s.environment !== env) continue;
      const perMonth = { day: 30, week: 52 / 12, month: 1, year: 1 / 12 }[p.interval as Interval] / p.intervalCount;
      mrr[p.currency] = (mrr[p.currency] ?? 0) + Math.round(p.amountMinor * perMonth);
    }
    const count = (st: string) => subs.filter((s) => s.status === st && s.environment === env).length;
    return {
      environment: env,
      canManage: oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE),
      mrr: Object.entries(mrr).map(([c, m]) => formatMoney(m, c)),
      counts: { active: count("active"), trialing: count("trialing"), pastDue: count("past_due"), unpaid: count("unpaid"), canceled: count("canceled") },
      plans: plans.map((p) => ({ ...planJson(p), subscribers: subs.filter((s) => s.planId === p.planId && (s.status === "active" || s.status === "trialing" || s.status === "past_due")).length })),
      subscriptions: subs.filter((s) => s.environment === env).slice(0, 50).map((s) => {
        const p = planById.get(s.planId);
        return { id: s.subscriptionId, customer: s.customerEmail, plan: p?.name ?? s.planId, price: p ? `${formatMoney(p.amountMinor, p.currency)} · ${describeInterval(p.interval as Interval, p.intervalCount)}` : "", status: s.status, nextChargeAt: s.status === "canceled" || s.status === "unpaid" ? null : s.nextChargeAt, cancelAtPeriodEnd: s.cancelAtPeriodEnd, failedAttempts: s.failedAttempts };
      }),
    };
  },
});

export const createPlan = mutation({
  args: { name: v.string(), amountMinor: v.number(), currency: v.string(), interval: intervalV, intervalCount: v.number(), trialDays: v.optional(v.number()) },
  handler: async (ctx, a): Promise<ReturnType<typeof planJson>> => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.PAYMENTS_CREATE);
    return await ctx.runMutation(internal.billing.createPlanInternal, { orgId: oc.orgId, ...a, actor: oc.userId });
  },
});

export const cancelSubscription = mutation({
  args: { subscriptionId: v.string(), atPeriodEnd: v.boolean() },
  handler: async (ctx, a): Promise<ReturnType<typeof subscriptionJson>> => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.PAYMENTS_CREATE);
    return await ctx.runMutation(internal.billing.cancelSubscriptionInternal, { orgId: oc.orgId, subscriptionId: a.subscriptionId, atPeriodEnd: a.atPeriodEnd, actor: oc.userId });
  },
});

/** Dashboard: subscribe a customer using one of their saved payment methods. */
export const createSubscription = action({
  args: { planId: v.string(), paymentMethodId: v.string(), trialDays: v.optional(v.number()) },
  handler: async (ctx, a): Promise<ReturnType<typeof subscriptionJson>> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.PAYMENTS_CREATE });
    const merchant = await ctx.runQuery(internal.apiInternal.orgPrimaryMerchantInternal, { orgId: oc.orgId });
    if (!merchant) throw new ConvexError("No merchant is configured for this organization.");
    return await ctx.runMutation(internal.billing.createSubscriptionInternal, {
      orgId: oc.orgId,
      merchantId: merchant._id,
      environment: (oc.org.environment ?? "sandbox") as "sandbox" | "production",
      planId: a.planId,
      paymentMethodId: a.paymentMethodId,
      trialDays: a.trialDays,
      actor: oc.userId,
    });
  },
});

export const paymentMethodsForCustomer = query({
  args: { customerEmail: v.string() },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const env = oc.org.environment ?? "sandbox";
    const rows = await ctx.db.query("paymentMethods").withIndex("by_org_customer", (q) => q.eq("orgId", oc.orgId).eq("customerEmail", a.customerEmail.trim().toLowerCase())).collect();
    return rows.filter((r) => r.status === "active" && r.environment === env).map(pmJson);
  },
});
