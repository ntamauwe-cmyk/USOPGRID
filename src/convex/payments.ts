// USOPGRID payment engine.
//
//   CREATED → VALIDATED → ACCEPTED → PROCESSING → SUCCESSFUL | PENDING | DECLINED | FAILED
//   PENDING → SUCCESSFUL | DECLINED | FAILED | EXPIRED          (webhooks / recovery queue)
//   SUCCESSFUL → REFUND_PENDING → PARTIALLY_REFUNDED | REFUNDED (refund engine)
//   anything contradictory                → RECONCILIATION_EXCEPTION (finance)
//
// Every status change goes through moveTo(), which enforces the transition
// table in orchestration/states.ts and records an append-only event. Money is
// integer minor units throughout; the ledger is posted only on confirmed
// outcomes.

import { v, ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { computeFees } from "./lib/fees";
import { evaluatePaymentRisk } from "./lib/risk";
import { postDoubleEntry, merchantAccountCode, providerClearingCode, feesAccountCode, recipientAccountCode, ACCOUNT_KINDS, type Posting } from "./lib/ledger";
import { capShares, refundReversals, type SplitInput } from "./lib/splits";
import { logAudit } from "./lib/audit";
import { withIdempotency, fingerprint } from "./lib/idempotency";
import { getAdapter, PAYMENT_METHODS } from "./providers/index";
import type { ChargeResult, FailureInfo } from "./providers/types";
import { failure as mkFailure } from "./providers/types";
import { canTransition, resolveProviderOutcome, IN_FLIGHT_STATES, type TxState } from "./orchestration/states";
import { route, DEFAULT_STRATEGY, type RoutingDecision } from "./orchestration/router";
import { savePaymentMethodFromAction } from "./billing";
import { executeChain, type AttemptRecord, type ChainStep } from "./orchestration/engine";
import { evaluateJurisdiction, screenWatchlist, type ComplianceDecision } from "./orchestration/compliance";
import { nextRecoveryAt, RECOVERY_DEADLINE_MS, REQUIRES_ACTION_TTL_MS } from "./orchestration/retry";
import { platformConnectionId, resolveConnection, notify, type RoutingContext } from "./connections";
import { isSupportedCurrency } from "../lib/money";
import { isKnownCountry } from "../lib/geo";
import { randomToken } from "./lib/crypto";

const envValidator = v.union(v.literal("sandbox"), v.literal("production"));
const failureValidator = v.object({
  category: v.string(),
  code: v.string(),
  message: v.string(),
  retryable: v.boolean(),
  safeToFailover: v.optional(v.boolean()),
  providerCode: v.optional(v.string()),
});

// ---------------------------------------------------------------------------
// Lookups used by the HTTP layer
// ---------------------------------------------------------------------------

/** Load an API key by SHA-256 hash. The hash itself is never returned. */
export const apiKeyByHash = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .unique();
    if (!key || key.status !== "active") return null;
    if (key.expiresAt !== undefined && key.expiresAt <= Date.now()) return null; // rotated-out key past its grace period
    return {
      _id: key._id,
      orgId: key.orgId,
      merchantId: key.merchantId,
      environment: key.environment,
      mode: key.mode,
      scope: key.scope,
      allowedIps: key.allowedIps,
      prefix: key.prefix,
    };
  },
});

export const transactionByTransactionId = internalQuery({
  args: { transactionId: v.string() },
  handler: async (ctx, args) =>
    (await ctx.db
      .query("transactions")
      .withIndex("by_transaction_id", (q) => q.eq("transactionId", args.transactionId))
      .unique()) ?? null,
});

export const transactionByIdInternal = internalQuery({
  args: { internalId: v.id("transactions") },
  handler: async (ctx, { internalId }) => ctx.db.get(internalId),
});

/** Flat, serializable transaction summary returned by engine entry points. */
export interface TransactionSummary {
  transactionId: string;
  reference: string;
  status: string;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  country: string | null;
  feeMinor: number | null;
  netMinor: number | null;
  refundedMinor: number;
  provider: string;
  providerReference: string | null;
  attempts: number;
  failovers: number;
  outcomeUnknown: boolean;
  nextAction: { type: string; url?: string; instructions?: string; expiresAt?: number } | null;
  failure: { category: string; code: string; message: string; retryable: boolean } | null;
  createdAt: number;
  splits?: SplitSummary[];
}

export interface SplitSummary {
  recipient: string;
  amount: number;
  percent: number | null;
  allocated: number | null;
  reversed: number;
}

export function splitSummaries(t: Pick<Doc<"transactions">, "splits">): SplitSummary[] | undefined {
  return t.splits?.map((sp) => ({
    recipient: sp.recipientRef,
    amount: sp.amountMinor,
    percent: sp.percentBps !== undefined ? sp.percentBps / 100 : null,
    allocated: sp.allocatedMinor ?? null,
    reversed: sp.reversedMinor ?? 0,
  }));
}

export function summarize(t: Doc<"transactions">): TransactionSummary {
  return {
    transactionId: t.transactionId,
    reference: t.reference,
    status: t.status,
    amountMinor: t.amountMinor,
    currency: t.currency,
    paymentMethod: t.paymentMethod,
    country: t.country ?? null,
    feeMinor: t.feeMinor ?? null,
    netMinor: t.netMinor ?? null,
    refundedMinor: t.refundedMinor ?? 0,
    provider: t.provider,
    providerReference: t.providerReference ?? null,
    attempts: t.attemptCount ?? 0,
    failovers: t.failoverCount ?? 0,
    outcomeUnknown: t.outcomeUnknown ?? false,
    nextAction: (t.nextAction as TransactionSummary["nextAction"]) ?? null,
    failure:
      t.failureCategory && t.failureCode
        ? { category: t.failureCategory, code: t.failureCode, message: t.failureMessage ?? "", retryable: t.failureRetryable ?? false }
        : null,
    createdAt: t.createdAt,
    splits: splitSummaries(t),
  };
}

// ---------------------------------------------------------------------------
// Core transition helper — the ONLY way a payment changes state.
// ---------------------------------------------------------------------------
async function recordEvent(
  ctx: MutationCtx,
  txInternalId: Id<"transactions">,
  ev: { type: string; fromStatus?: string; toStatus?: string; data?: unknown; actor?: string },
) {
  await ctx.db.insert("transactionEvents", {
    transactionId: txInternalId,
    type: ev.type,
    fromStatus: ev.fromStatus,
    toStatus: ev.toStatus,
    data: ev.data,
    actor: ev.actor ?? "system",
    at: Date.now(),
  });
}

async function moveTo(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  to: TxState,
  actor: string,
  patch: Partial<Doc<"transactions">> = {},
  data?: unknown,
): Promise<Doc<"transactions">> {
  if (txn.status !== to && !canTransition(txn.status, to)) {
    throw new ConvexError(`ILLEGAL_TRANSITION: ${txn.transactionId} ${txn.status} → ${to}`);
  }
  await ctx.db.patch(txn._id, { ...patch, status: to, updatedAt: Date.now() });
  await recordEvent(ctx, txn._id, { type: to.toLowerCase(), fromStatus: txn.status, toStatus: to, data, actor });
  const updated = await ctx.db.get(txn._id);
  if (!updated) throw new ConvexError("transaction vanished");
  return updated;
}

async function mustGet(ctx: MutationCtx, id: Id<"transactions">) {
  const t = await ctx.db.get(id);
  if (!t) throw new ConvexError("NOT_FOUND: transaction");
  return t;
}

// ---------------------------------------------------------------------------
// Outbound webhooks
// ---------------------------------------------------------------------------
async function enqueueWebhooks(ctx: MutationCtx, txn: Doc<"transactions">, event: string, extra: Record<string, unknown> = {}) {
  const endpoints = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_org", (q) => q.eq("orgId", txn.orgId))
    .collect();
  const eventId = `evt_${randomToken(24)}`;
  const payload = {
    id: eventId,
    event,
    created_at: new Date().toISOString(),
    livemode: txn.environment === "production",
    data: {
      id: txn.transactionId,
      reference: txn.reference,
      status: txn.status,
      amount: txn.amountMinor,
      currency: txn.currency,
      payment_method: txn.paymentMethod,
      country: txn.country ?? null,
      provider: txn.provider,
      provider_reference: txn.providerReference ?? null,
      fee: txn.feeMinor ?? null,
      net: txn.netMinor ?? null,
      refunded_amount: txn.refundedMinor ?? 0,
      failure: txn.failureCode
        ? { category: txn.failureCategory, code: txn.failureCode, message: txn.failureMessage, retryable: txn.failureRetryable ?? false }
        : null,
      ...extra,
    },
  };
  for (const ep of endpoints) {
    if (ep.status !== "active") continue;
    if (!ep.events.includes(event) && !ep.events.includes("*")) continue;
    await ctx.db.insert("webhookDeliveries", {
      orgId: txn.orgId,
      endpointId: ep._id,
      transactionId: txn._id,
      event,
      eventId,
      payload,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Creation + validation
// ---------------------------------------------------------------------------
export const paymentContextInternal = internalQuery({
  args: { orgId: v.id("organizations"), merchantId: v.id("merchants") },
  handler: async (ctx, { orgId, merchantId }) => {
    const org = await ctx.db.get(orgId);
    const merchant = await ctx.db.get(merchantId);
    if (!org || !merchant || merchant.orgId !== orgId) return null;
    return {
      orgStatus: org.status ?? "active",
      orgCountry: org.country,
      maxTransactionMinor: org.maxTransactionMinor,
      merchantStatus: merchant.status,
      merchantName: merchant.name,
    };
  },
});

export const createTransactionInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    merchantId: v.id("merchants"),
    environment: envValidator,
    amountMinor: v.number(),
    currency: v.string(),
    reference: v.string(),
    paymentMethod: v.string(),
    country: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    customerPhone: v.optional(v.string()),
    metadata: v.optional(v.any()),
    idempotencyKey: v.optional(v.string()),
    requestId: v.optional(v.string()),
    actor: v.optional(v.string()),
    savePaymentMethod: v.optional(v.boolean()),
    invoiceId: v.optional(v.id("invoices")),
    splits: v.optional(v.array(v.object({ recipientId: v.id("recipients"), recipientRef: v.string(), amountMinor: v.number(), percentBps: v.optional(v.number()) }))),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const dup = await ctx.db
      .query("transactions")
      .withIndex("by_reference", (q) => q.eq("orgId", args.orgId).eq("reference", args.reference))
      .first();
    if (dup) throw new ConvexError(`CONFLICT: reference '${args.reference}' already used by transaction ${dup.transactionId}`);

    const transactionId = `txn_${now.toString(36)}${randomToken(10)}`;
    const docId = await ctx.db.insert("transactions", {
      orgId: args.orgId,
      merchantId: args.merchantId,
      environment: args.environment,
      status: "CREATED",
      amountMinor: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
      transactionId,
      idempotencyKey: args.idempotencyKey,
      provider: "unassigned",
      paymentMethod: args.paymentMethod,
      country: args.country,
      customerEmail: args.customerEmail,
      customerName: args.customerName,
      customerPhone: args.customerPhone,
      metadata: args.metadata,
      savePaymentMethod: args.savePaymentMethod,
      invoiceId: args.invoiceId,
      splits: args.splits,
      attemptCount: 0,
      failoverCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await recordEvent(ctx, docId, { type: "created", actor: args.actor ?? "api", toStatus: "CREATED", data: { requestId: args.requestId } });
    await logAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor ?? "api",
      action: "transaction.created",
      resource: "transaction",
      resourceId: transactionId,
      after: { amountMinor: args.amountMinor, currency: args.currency, reference: args.reference, country: args.country },
      requestId: args.requestId,
    });
    return { internalId: docId, transactionId };
  },
});

/** Record risk + compliance; either VALIDATED or terminally DECLINED. */
export const validateInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    risk: v.object({ score: v.number(), decision: v.string(), reasons: v.array(v.string()) }),
    compliance: v.object({ decision: v.string(), reasons: v.array(v.string()), watchlist: v.optional(v.any()) }),
  },
  handler: async (ctx, a) => {
    const txn = await mustGet(ctx, a.internalId);
    await ctx.db.patch(txn._id, {
      riskScore: a.risk.score,
      riskDecision: a.risk.decision as Doc<"transactions">["riskDecision"],
      complianceDecision: a.compliance.decision,
    });
    await recordEvent(ctx, txn._id, { type: "risk_evaluated", data: a.risk, actor: "risk_engine" });
    await recordEvent(ctx, txn._id, { type: "compliance_screened", data: a.compliance, actor: "compliance_engine" });

    let f: FailureInfo | null = null;
    if (a.compliance.decision === "BLOCK") {
      f = mkFailure("compliance_block", "compliance_blocked", `Blocked by compliance policy (${a.compliance.reasons.join(", ")}).`);
    } else if (a.compliance.decision === "REVIEW") {
      f = mkFailure("compliance_block", "compliance_review_required", `Requires compliance review before processing (${a.compliance.reasons.join(", ")}).`);
    } else if (a.risk.decision === "BLOCK" || a.risk.decision === "HOLD") {
      f = mkFailure("fraud_rejection", "risk_blocked", `Blocked by risk engine (score ${a.risk.score}: ${a.risk.reasons.join(", ") || "policy"}).`);
    }
    if (f) {
      const declined = await finalizeFailure(ctx, txn, "DECLINED", f, { provider: f.category === "compliance_block" ? "compliance_engine" : "risk_engine" });
      if (f.category === "compliance_block") {
        await notify(ctx, {
          orgId: txn.orgId,
          kind: "compliance",
          severity: "warning",
          title: `Payment ${txn.transactionId} stopped by compliance`,
          body: f.message,
          link: `/dashboard/transactions/${txn.transactionId}`,
        });
      }
      return { ok: false as const, summary: summarize(declined) };
    }
    await moveTo(ctx, txn, "VALIDATED", "system");
    return { ok: true as const };
  },
});

export const saveRoutingDecisionInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    internalId: v.id("transactions"),
    request: v.any(),
    chain: v.array(v.object({ providerId: v.string(), connectionId: v.string() })),
    evaluations: v.any(),
    matchedRules: v.array(v.string()),
    explanation: v.string(),
  },
  handler: async (ctx, a) => {
    const txn = await mustGet(ctx, a.internalId);
    const id = await ctx.db.insert("routingDecisions", {
      orgId: a.orgId,
      transactionId: a.internalId,
      request: a.request,
      chain: a.chain,
      evaluations: a.evaluations,
      matchedRules: a.matchedRules,
      explanation: a.explanation,
      at: Date.now(),
    });
    await recordEvent(ctx, txn._id, { type: "routed", data: { chain: a.chain.map((c) => c.providerId), explanation: a.explanation }, actor: "router" });
    if (a.chain.length === 0) {
      const f = mkFailure("unsupported", "no_route", a.explanation);
      const failed = await finalizeFailure(ctx, txn, "FAILED", f, { provider: "router" });
      return { decisionId: id, summary: summarize(failed) };
    }
    await moveTo(ctx, txn, "ACCEPTED", "router");
    const t2 = await mustGet(ctx, a.internalId);
    await moveTo(ctx, t2, "PROCESSING", "engine", {}, { chain: a.chain.map((c) => c.providerId) });
    return { decisionId: id, summary: null };
  },
});

// ---------------------------------------------------------------------------
// Outcome finalizers
// ---------------------------------------------------------------------------
async function finalizeFailure(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  to: "FAILED" | "DECLINED" | "EXPIRED" | "CANCELLED",
  f: FailureInfo | { category: string; code: string; message: string; retryable: boolean },
  opts: { provider?: string; providerReference?: string; connectionId?: string; actor?: string } = {},
) {
  const updated = await moveTo(
    ctx,
    txn,
    to,
    opts.actor ?? "system",
    {
      provider: opts.provider ?? txn.provider,
      providerReference: opts.providerReference ?? txn.providerReference,
      connectionId: opts.connectionId ?? txn.connectionId,
      failureCategory: f.category,
      failureCode: f.code,
      failureMessage: f.message,
      failureRetryable: f.retryable,
      outcomeUnknown: false,
      nextAction: undefined,
    },
    f,
  );
  if (txn.customerEmail) {
    await ctx.runMutation(internal.customers.upsertCustomerInternal, {
      orgId: txn.orgId,
      email: txn.customerEmail,
      name: txn.customerName,
      successful: false,
      volumeMinor: 0,
      currency: txn.currency,
    });
  }
  await closeRecovery(ctx, txn._id, "resolved", to);
  await enqueueWebhooks(ctx, updated, to === "DECLINED" ? "payment.declined" : to === "EXPIRED" ? "payment.expired" : "payment.failed");
  await logAudit(ctx, { orgId: txn.orgId, actor: opts.actor ?? "system", action: `transaction.${to.toLowerCase()}`, resource: "transaction", resourceId: txn.transactionId, after: f });
  return updated;
}

/**
 * Move each recipient's share out of the merchant's net into the
 * recipient's own balance. Shares were checked against the estimated net
 * when the payment was created; if actual fees left less, the last shares
 * are reduced and the shortfall is recorded on the payment.
 */
async function allocateSplits(ctx: MutationCtx, txn: Doc<"transactions">, netMinor: number, actor?: string) {
  const splits = txn.splits ?? [];
  if (splits.some((sp) => sp.allocatedMinor !== undefined)) return; // already allocated
  const { shares, shortfallMinor } = capShares(splits, netMinor);
  const postings: Posting[] = [];
  let total = 0;
  for (const sh of shares) {
    if (sh.allocatedMinor <= 0) continue;
    total += sh.allocatedMinor;
    postings.push({
      account: {
        orgId: txn.orgId,
        currency: txn.currency,
        kind: ACCOUNT_KINDS.RECIPIENT_BALANCE,
        code: recipientAccountCode(sh.recipientId, txn.currency),
        name: `Recipient ${sh.recipientRef} balance ${txn.currency}`,
      },
      direction: "credit",
      amountMinor: sh.allocatedMinor,
      description: `Share of ${txn.transactionId}`,
    });
  }
  if (total > 0) {
    await postDoubleEntry(ctx, {
      orgId: txn.orgId,
      ledgerRef: `SPL-${txn.transactionId}`,
      transactionId: txn._id,
      postings: [
        {
          account: {
            orgId: txn.orgId,
            merchantId: txn.merchantId,
            currency: txn.currency,
            kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
            code: merchantAccountCode(txn.merchantId, txn.currency),
            name: `merchant balance ${txn.currency}`,
          },
          direction: "debit",
          amountMinor: total,
          description: `Shares paid to recipients from ${txn.transactionId}`,
        },
        ...postings,
      ],
    });
  }
  await ctx.db.patch(txn._id, {
    splits: shares.map((sh) => ({ recipientId: sh.recipientId, recipientRef: sh.recipientRef, amountMinor: sh.amountMinor, percentBps: sh.percentBps, allocatedMinor: sh.allocatedMinor, reversedMinor: 0 })),
  });
  await recordEvent(ctx, txn._id, {
    type: "splits.allocated",
    actor: actor ?? "system",
    data: { totalMinor: total, shortfallMinor, shares: shares.map((sh) => ({ recipient: sh.recipientRef, amountMinor: sh.allocatedMinor })) },
  });
}

/** Reverse recipients' shares in proportion to a successful refund. */
async function reverseSplits(ctx: MutationCtx, txn: Doc<"transactions">, refundId: string, refundedBefore: number, refundMinor: number, actor: string) {
  const splits = txn.splits ?? [];
  if (!splits.some((sp) => (sp.allocatedMinor ?? 0) > 0)) return;
  const deltas = refundReversals(splits.map((sp) => ({ allocatedMinor: sp.allocatedMinor ?? 0 })), txn.amountMinor, refundedBefore, refundMinor);
  const total = deltas.reduce((n, d) => n + d, 0);
  if (total <= 0) return;
  await postDoubleEntry(ctx, {
    orgId: txn.orgId,
    ledgerRef: `SPLR-${refundId}`,
    transactionId: txn._id,
    postings: [
      ...splits.flatMap((sp, i): Posting[] =>
        deltas[i] > 0
          ? [
              {
                account: {
                  orgId: txn.orgId,
                  currency: txn.currency,
                  kind: ACCOUNT_KINDS.RECIPIENT_BALANCE,
                  code: recipientAccountCode(sp.recipientId, txn.currency),
                  name: `Recipient ${sp.recipientRef} balance ${txn.currency}`,
                },
                direction: "debit",
                amountMinor: deltas[i],
                description: `Share reversed for refund ${refundId}`,
              },
            ]
          : [],
      ),
      {
        account: {
          orgId: txn.orgId,
          merchantId: txn.merchantId,
          currency: txn.currency,
          kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
          code: merchantAccountCode(txn.merchantId, txn.currency),
          name: `merchant balance ${txn.currency}`,
        },
        direction: "credit",
        amountMinor: total,
        description: `Recipient shares returned for refund ${refundId}`,
      },
    ],
  });
  await ctx.db.patch(txn._id, { splits: splits.map((sp, i) => ({ ...sp, reversedMinor: (sp.reversedMinor ?? 0) + deltas[i] })) });
  await recordEvent(ctx, txn._id, { type: "splits.reversed", actor, data: { refundId, totalMinor: total, shares: splits.map((sp, i) => ({ recipient: sp.recipientRef, amountMinor: deltas[i] })) } });
}

async function finalizeSuccess(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  p: {
    provider: string;
    connectionId?: string;
    providerReference?: string;
    providerFeeMinor?: number;
    reportedAmountMinor?: number;
    reportedCurrency?: string;
    actor?: string;
  },
) {
  if (txn.status === "SUCCESSFUL") return txn;

  // The provider says it captured something different from what we asked:
  // never credit the merchant on a mismatch — hand it to finance.
  const amountMismatch = p.reportedAmountMinor !== undefined && p.reportedAmountMinor !== txn.amountMinor;
  const currencyMismatch = p.reportedCurrency !== undefined && p.reportedCurrency !== txn.currency;
  if (amountMismatch || currencyMismatch) {
    return raiseException(ctx, txn, currencyMismatch ? "currency_mismatch" : "amount_mismatch", `Provider ${p.provider} reported ${p.reportedAmountMinor ?? "?"} ${p.reportedCurrency ?? txn.currency}; instruction was ${txn.amountMinor} ${txn.currency}.`, {
      provider: p.provider,
      providerReference: p.providerReference,
      ledgerAmountMinor: txn.amountMinor,
      bankAmountMinor: p.reportedAmountMinor,
    });
  }

  const merchant = await ctx.db.get(txn.merchantId);
  if (!merchant) throw new ConvexError("merchant not found");
  const fees = computeFees(merchant, txn.amountMinor, txn.currency);

  const updated = await moveTo(
    ctx,
    txn,
    "SUCCESSFUL",
    p.actor ?? "system",
    {
      provider: p.provider,
      connectionId: p.connectionId ?? txn.connectionId,
      providerReference: p.providerReference ?? txn.providerReference,
      providerFeeMinor: p.providerFeeMinor,
      feeMinor: fees.feeMinor,
      feeCurrency: fees.currency,
      netMinor: fees.netMinor,
      outcomeUnknown: false,
      nextAction: undefined,
      failureCategory: undefined,
      failureCode: undefined,
      failureMessage: undefined,
      failureRetryable: undefined,
    },
    { provider: p.provider, providerReference: p.providerReference, fees: fees.parts, fixedFeeUnconverted: fees.fixedFeeUnconverted },
  );

  await postDoubleEntry(ctx, {
    orgId: txn.orgId,
    ledgerRef: `LED-${txn.transactionId}`,
    transactionId: txn._id,
    postings: [
      {
        account: {
          orgId: txn.orgId,
          currency: txn.currency,
          kind: ACCOUNT_KINDS.PROVIDER_CLEARING,
          code: providerClearingCode(p.provider, txn.currency),
          name: `Provider clearing — ${p.provider} ${txn.currency}`,
        },
        direction: "debit",
        amountMinor: txn.amountMinor,
        description: `Payment received ${txn.transactionId}`,
      },
      {
        account: {
          orgId: txn.orgId,
          merchantId: txn.merchantId,
          currency: txn.currency,
          kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
          code: merchantAccountCode(txn.merchantId, txn.currency),
          name: `${merchant.name} balance ${txn.currency}`,
        },
        direction: "credit",
        amountMinor: fees.netMinor,
        description: `Net of fees ${txn.transactionId}`,
      },
      ...(fees.feeMinor > 0
        ? [
            {
              account: {
                orgId: txn.orgId,
                currency: txn.currency,
                kind: ACCOUNT_KINDS.PLATFORM_FEES,
                code: feesAccountCode(txn.currency),
                name: `USOPGRID fees ${txn.currency}`,
              },
              direction: "credit" as const,
              amountMinor: fees.feeMinor,
              description: `Platform fee ${txn.transactionId}`,
            },
          ]
        : []),
    ],
  });

  if (txn.splits && txn.splits.length > 0) await allocateSplits(ctx, txn, fees.netMinor, p.actor);

  if (txn.customerEmail) {
    await ctx.runMutation(internal.customers.upsertCustomerInternal, {
      orgId: txn.orgId,
      email: txn.customerEmail,
      name: txn.customerName,
      successful: true,
      volumeMinor: txn.amountMinor,
      currency: txn.currency,
    });
  }
  await closeRecovery(ctx, txn._id, "resolved", "SUCCESSFUL");
  await enqueueWebhooks(ctx, updated, "payment.successful");
  await logAudit(ctx, {
    orgId: txn.orgId,
    actor: p.actor ?? "system",
    action: "transaction.successful",
    resource: "transaction",
    resourceId: txn.transactionId,
    after: { provider: p.provider, providerReference: p.providerReference, feeMinor: fees.feeMinor },
  });
  return updated;
}

async function raiseException(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  type: Doc<"reconExceptions">["type"],
  detail: string,
  extra: { provider?: string; providerReference?: string; ledgerAmountMinor?: number; bankAmountMinor?: number } = {},
) {
  const updated =
    txn.status === "RECONCILIATION_EXCEPTION" || !canTransition(txn.status, "RECONCILIATION_EXCEPTION")
      ? txn
      : await moveTo(ctx, txn, "RECONCILIATION_EXCEPTION", "system", { outcomeUnknown: false }, { type, detail });
  await ctx.db.insert("reconExceptions", {
    orgId: txn.orgId,
    type,
    severity: "high",
    detail,
    currency: txn.currency,
    ledgerAmountMinor: extra.ledgerAmountMinor,
    bankAmountMinor: extra.bankAmountMinor,
    transactionId: txn.transactionId,
    provider: extra.provider ?? txn.provider,
    providerReference: extra.providerReference ?? txn.providerReference,
    status: "open",
    createdAt: Date.now(),
  });
  await notify(ctx, {
    orgId: txn.orgId,
    kind: "recon_exception",
    severity: "critical",
    title: `Reconciliation exception on ${txn.transactionId}`,
    body: detail,
    link: `/dashboard/reconciliation`,
  });
  await closeRecovery(ctx, txn._id, "escalated", type);
  await enqueueWebhooks(ctx, updated, "payment.reconciliation_exception", { exception: { type, detail } });
  return updated;
}

async function closeRecovery(ctx: MutationCtx, txnId: Id<"transactions">, status: "resolved" | "escalated" | "cancelled", note: string) {
  const jobs = await ctx.db
    .query("recoveryJobs")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
    .collect();
  for (const j of jobs) {
    if (j.status === "open") await ctx.db.patch(j._id, { status, lastResult: note, updatedAt: Date.now() });
  }
}

async function openRecovery(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  kind: Doc<"recoveryJobs">["kind"],
  providerId: string,
  connectionId: string,
  refundId?: string,
) {
  const now = Date.now();
  await ctx.db.insert("recoveryJobs", {
    orgId: txn.orgId,
    transactionId: txn._id,
    kind,
    providerId,
    connectionId,
    checksDone: 0,
    nextCheckAt: kind === "action_expiry" ? now + REQUIRES_ACTION_TTL_MS : (nextRecoveryAt(0, now) ?? now),
    deadlineAt: now + (kind === "action_expiry" ? REQUIRES_ACTION_TTL_MS : RECOVERY_DEADLINE_MS),
    status: "open",
    refundId,
    createdAt: now,
    updatedAt: now,
  });
}

/** Apply the executor's verdict for a fresh payment. */
export const applyChainOutcomeInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    decisionId: v.id("routingDecisions"),
    kind: v.string(),
    attempts: v.number(),
    failovers: v.number(),
    providerId: v.optional(v.string()),
    connectionId: v.optional(v.string()),
    providerReference: v.optional(v.string()),
    providerFeeMinor: v.optional(v.number()),
    reportedAmountMinor: v.optional(v.number()),
    reportedCurrency: v.optional(v.string()),
    nextAction: v.optional(v.any()),
    failure: v.optional(failureValidator),
  },
  handler: async (ctx, a) => {
    let txn = await mustGet(ctx, a.internalId);
    await ctx.db.patch(txn._id, { attemptCount: a.attempts, failoverCount: a.failovers });
    txn = await mustGet(ctx, a.internalId);
    const provider = a.providerId ?? "router";
    const f = a.failure ?? mkFailure("temporary_provider_failure", "unknown_failure", "Payment could not be processed.");

    let out: Doc<"transactions">;
    switch (a.kind) {
      case "successful":
        out = await finalizeSuccess(ctx, txn, {
          provider,
          connectionId: a.connectionId,
          providerReference: a.providerReference,
          providerFeeMinor: a.providerFeeMinor,
          reportedAmountMinor: a.reportedAmountMinor,
          reportedCurrency: a.reportedCurrency,
        });
        break;
      case "pending":
      case "requires_action":
      case "unknown": {
        const unknown = a.kind === "unknown";
        out = await moveTo(
          ctx,
          txn,
          "PENDING",
          "engine",
          {
            provider,
            connectionId: a.connectionId,
            providerReference: a.providerReference,
            outcomeUnknown: unknown,
            nextAction: a.nextAction,
            ...(unknown ? { failureCategory: f.category, failureCode: f.code, failureMessage: f.message, failureRetryable: true } : {}),
          },
          { kind: a.kind, nextAction: a.nextAction, failure: unknown ? f : undefined },
        );
        await openRecovery(ctx, out, a.kind === "requires_action" ? "action_expiry" : "charge_status", provider, a.connectionId ?? platformConnectionId(provider, txn.environment));
        await enqueueWebhooks(ctx, out, a.kind === "requires_action" ? "payment.requires_action" : "payment.pending", a.nextAction ? { next_action: a.nextAction } : {});
        break;
      }
      case "declined":
        out = await finalizeFailure(ctx, txn, "DECLINED", f, { provider, providerReference: a.providerReference, connectionId: a.connectionId });
        break;
      default:
        out = await finalizeFailure(ctx, txn, "FAILED", f, { provider, providerReference: a.providerReference, connectionId: a.connectionId });
    }
    await ctx.db.patch(a.decisionId, { outcome: out.status, decidedProvider: provider });
    return summarize(out);
  },
});

/**
 * Apply an outcome reported later by a provider (webhook or recovery poll).
 * Duplicate, stale and contradictory reports are recorded but never applied.
 */
export const applyProviderOutcomeInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    reported: v.string(), // TxState
    source: v.string(), // "webhook:<provider>" | "recovery"
    providerReference: v.optional(v.string()),
    amountMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    failure: v.optional(failureValidator),
    eventId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const txn = await mustGet(ctx, a.internalId);
    const reported = a.reported as TxState;
    const resolution = resolveProviderOutcome(txn.status, reported);
    await recordEvent(ctx, txn._id, {
      type: `provider_report.${resolution}`,
      fromStatus: txn.status,
      toStatus: reported,
      data: { source: a.source, eventId: a.eventId, providerReference: a.providerReference },
      actor: a.source,
    });
    if (resolution === "noop" || resolution === "stale") return { resolution, status: txn.status };
    if (resolution === "exception") {
      const out = await raiseException(ctx, txn, "late_provider_success", `Provider reported SUCCESS for a payment already ${txn.status} (via ${a.source}). Funds may have moved; verify and refund or reinstate.`, {
        providerReference: a.providerReference,
        bankAmountMinor: a.amountMinor,
        ledgerAmountMinor: txn.amountMinor,
      });
      return { resolution, status: out.status };
    }
    let out: Doc<"transactions"> = txn;
    if (reported === "SUCCESSFUL") {
      out = await finalizeSuccess(ctx, txn, {
        provider: txn.provider,
        providerReference: a.providerReference ?? txn.providerReference,
        reportedAmountMinor: a.amountMinor,
        reportedCurrency: a.currency,
        actor: a.source,
      });
    } else if (reported === "FAILED" || reported === "DECLINED" || reported === "EXPIRED" || reported === "CANCELLED") {
      out = await finalizeFailure(ctx, txn, reported, a.failure ?? mkFailure("issuer_decline", "provider_reported_failure", `Provider reported ${reported}.`), {
        providerReference: a.providerReference,
        actor: a.source,
      });
    } else if (IN_FLIGHT_STATES.has(reported)) {
      out = await moveTo(ctx, txn, reported, a.source, { providerReference: a.providerReference ?? txn.providerReference });
    }
    return { resolution, status: out.status };
  },
});

// ---------------------------------------------------------------------------
// The orchestration action
// ---------------------------------------------------------------------------
export interface ProcessResult {
  kind: "done" | "rejected";
  transaction?: TransactionSummary;
  error?: { code: string; message: string; category: string };
}

export const processPaymentInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    merchantId: v.id("merchants"),
    environment: envValidator,
    amountMinor: v.number(),
    currency: v.string(),
    reference: v.string(),
    paymentMethod: v.string(),
    country: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    customerPhone: v.optional(v.string()),
    paymentToken: v.optional(v.string()),
    returnUrl: v.optional(v.string()),
    description: v.optional(v.string()),
    metadata: v.optional(v.any()),
    idempotencyKey: v.optional(v.string()),
    requestId: v.optional(v.string()),
    actor: v.optional(v.string()),
    /** Keep the payment method for future charges (subscriptions). */
    savePaymentMethod: v.optional(v.boolean()),
    /** Merchant-initiated charge of a saved token (renewal). Requires pinnedConnectionId. */
    recurring: v.optional(v.boolean()),
    /** Saved tokens only work at the provider that issued them: route there only. */
    pinnedConnectionId: v.optional(v.string()),
    invoiceId: v.optional(v.id("invoices")),
    /** Marketplace shares: recipient ids with an amount or a percentage. */
    splits: v.optional(v.array(v.object({ recipient: v.string(), amount: v.optional(v.number()), percent: v.optional(v.number()) }))),
  },
  handler: async (ctx, args): Promise<ProcessResult> => {
    // ---- 1. Static validation (nothing persisted on failure) ----
    const reject = (code: string, message: string, category = "validation"): ProcessResult => ({ kind: "rejected", error: { code, message, category } });
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) return reject("validation_error", "amountMinor must be a positive integer of minor units.");
    if (!isSupportedCurrency(args.currency)) return reject("validation_error", `Unsupported currency '${args.currency}'.`);
    if (!(PAYMENT_METHODS as readonly string[]).includes(args.paymentMethod)) {
      return reject("validation_error", `paymentMethod must be one of: ${PAYMENT_METHODS.join(", ")}.`);
    }
    if (args.country && !isKnownCountry(args.country)) return reject("validation_error", `Unknown country '${args.country}' (use ISO 3166-1 alpha-2).`);
    const pc = await ctx.runQuery(internal.payments.paymentContextInternal, { orgId: args.orgId, merchantId: args.merchantId });
    if (!pc) return reject("validation_error", "Merchant not found for this organization.");
    if (pc.orgStatus !== "active") return reject("authorization_error", `Organization is ${pc.orgStatus}; payments are disabled.`);
    if (pc.merchantStatus !== "active") return reject("authorization_error", `Merchant is ${pc.merchantStatus}; payments are disabled.`);

    const usd = await ctx.runQuery(internal.fxrates.usdEquivalentInternal, { amountMinor: args.amountMinor, currency: args.currency });
    if (pc.maxTransactionMinor !== undefined && usd !== null && usd > pc.maxTransactionMinor) {
      return reject("validation_error", `Amount exceeds this organization's per-transaction limit (USD ${(pc.maxTransactionMinor / 100).toFixed(2)}).`);
    }

    let splits: { recipientId: Id<"recipients">; recipientRef: string; amountMinor: number; percentBps?: number }[] | undefined;
    if (args.splits && args.splits.length > 0) {
      const res = await ctx.runQuery(internal.recipients.resolveSplitsInternal, {
        orgId: args.orgId,
        merchantId: args.merchantId,
        amountMinor: args.amountMinor,
        currency: args.currency,
        splits: args.splits as SplitInput[],
      });
      if (!res.ok) return reject("validation_error", res.message);
      splits = res.splits;
    }

    // ---- 2. Create the record ----
    const { internalId, transactionId } = await ctx.runMutation(internal.payments.createTransactionInternal, {
      orgId: args.orgId,
      merchantId: args.merchantId,
      environment: args.environment,
      amountMinor: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
      paymentMethod: args.paymentMethod,
      country: args.country,
      customerEmail: args.customerEmail,
      customerName: args.customerName,
      customerPhone: args.customerPhone,
      metadata: args.metadata,
      idempotencyKey: args.idempotencyKey,
      requestId: args.requestId,
      actor: args.actor,
      savePaymentMethod: args.savePaymentMethod,
      invoiceId: args.invoiceId,
      splits,
    });

    // ---- 3. Risk + compliance ----
    const signals = await ctx.runQuery(internal.customers.riskSignalsInternal, { orgId: args.orgId, customerEmail: args.customerEmail });
    const risk = evaluatePaymentRisk({
      amountMinor: args.amountMinor,
      amountUsdMinor: usd ?? undefined,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      customerEmail: args.customerEmail,
      signals: signals as { customerTxns10m: number; customerFailed30m: number; orgTxns1m: number },
    });
    const jurisdiction = evaluateJurisdiction({
      payerCountry: args.country,
      merchantCountry: pc.orgCountry,
      currency: args.currency,
      customerName: args.customerName,
      amountMinor: args.amountMinor,
    });
    let decision: ComplianceDecision = jurisdiction.decision;
    const reasons = [...jurisdiction.reasons];
    let watchlist: unknown;
    if (decision !== "BLOCK" && args.customerName && args.environment === "production") {
      try {
        const w = await screenWatchlist(args.customerName, args.country, process.env.OPENSANCTIONS_API_KEY, fetch);
        watchlist = w;
        if (w.decision === "BLOCK" || (w.decision === "REVIEW" && decision === "ALLOW")) decision = w.decision;
        if (w.decision !== "ALLOW") reasons.push(`watchlist_${w.decision.toLowerCase()}`);
      } catch (err) {
        // Screening outage: fail closed for production payments.
        decision = decision === "BLOCK" ? "BLOCK" : "REVIEW";
        reasons.push(`watchlist_unavailable:${err instanceof Error ? err.message : "error"}`);
      }
    }
    const validated = await ctx.runMutation(internal.payments.validateInternal, {
      internalId,
      risk,
      compliance: { decision, reasons, watchlist },
    });
    if (!validated.ok) return { kind: "done", transaction: validated.summary };

    // ---- 4. Route ----
    const rc: RoutingContext = await ctx.runQuery(internal.connections.routingContextInternal, { orgId: args.orgId, environment: args.environment });
    const candidates = rc.candidates.flatMap((c) => {
      const adapter = getAdapter(c.providerId);
      return adapter ? [{ ...c, descriptor: adapter.descriptor }] : [];
    });
    const routingRequest = { country: args.country, currency: args.currency, method: args.paymentMethod, amountMinor: args.amountMinor, riskScore: risk.score };
    const decisionR = args.pinnedConnectionId
      ? pinnedDecision(args.pinnedConnectionId, candidates, rc)
      : route({ request: routingRequest, candidates, stats: rc.stats, circuits: rc.circuits, rules: rc.rules, strategy: rc.strategy, now: Date.now() });
    const saved = await ctx.runMutation(internal.payments.saveRoutingDecisionInternal, {
      orgId: args.orgId,
      internalId,
      request: routingRequest,
      chain: decisionR.chain,
      evaluations: decisionR.evaluations,
      matchedRules: decisionR.matchedRules,
      explanation: decisionR.explanation,
    });
    if (saved.summary) return { kind: "done", transaction: saved.summary };

    // ---- 5. Execute the chain ----
    const outcome = await executeChain(
      {
        transactionId,
        amountMinor: args.amountMinor,
        currency: args.currency,
        reference: args.reference,
        paymentMethod: args.paymentMethod,
        country: args.country,
        customer: { email: args.customerEmail, name: args.customerName, phone: args.customerPhone },
        paymentToken: args.paymentToken,
        returnUrl: args.returnUrl,
        description: args.description,
        metadata: args.metadata as Record<string, unknown> | undefined,
        recurring: args.recurring,
        savePaymentMethod: args.savePaymentMethod,
      },
      decisionR.chain,
      chainDeps(ctx, { orgId: args.orgId, internalId, environment: args.environment, currency: args.currency, amountMinor: args.amountMinor, country: args.country, paymentMethod: args.paymentMethod }),
    );

    const r: ChargeResult | undefined = outcome.decisive?.result;
    const summary = await ctx.runMutation(internal.payments.applyChainOutcomeInternal, {
      internalId,
      decisionId: saved.decisionId,
      kind: outcome.kind,
      attempts: outcome.attempts.length,
      failovers: outcome.failovers,
      providerId: outcome.decisive?.providerId,
      connectionId: outcome.decisive?.connectionId,
      providerReference: r?.providerReference,
      providerFeeMinor: r?.providerFeeMinor,
      reportedAmountMinor: r?.reportedAmountMinor,
      reportedCurrency: r?.reportedCurrency,
      nextAction: r?.nextAction,
      failure: outcome.failure,
    });
    // A reusable token returned with a successful first payment becomes a saved payment method.
    if (args.savePaymentMethod && r?.reusableToken && outcome.decisive && summary.status === "SUCCESSFUL" && args.customerEmail) {
      try {
        await savePaymentMethodFromAction(ctx, {
          orgId: args.orgId,
          environment: args.environment,
          customerEmail: args.customerEmail,
          providerId: outcome.decisive.providerId,
          connectionId: outcome.decisive.connectionId,
          token: r.reusableToken,
          sourceTransactionId: transactionId,
        });
      } catch (err) {
        console.error("[billing] could not save payment method", err instanceof Error ? err.message : err);
      }
    }
    return { kind: "done", transaction: summary };
  },
});

/** Saved tokens only work at the connection that issued them: no routing, no failover. */
function pinnedDecision(connectionId: string, candidates: { providerId: string; connectionId: string; enabled: boolean }[], rc: RoutingContext): RoutingDecision {
  const c = candidates.find((x) => x.connectionId === connectionId && x.enabled);
  const circuit = rc.circuits[connectionId];
  const open = circuit && circuit.state === "open";
  return {
    chain: c && !open ? [{ providerId: c.providerId, connectionId: c.connectionId }] : [],
    evaluations: [],
    matchedRules: [],
    strategy: rc.strategy ?? DEFAULT_STRATEGY,
    explanation: !c
      ? "The saved payment method's provider connection is no longer available."
      : open
        ? "The saved payment method's provider is temporarily unavailable (circuit open); the charge will be retried."
        : `Saved payment method: charged at ${c.providerId}, the provider that issued it.`,
  };
}

function chainDeps(
  ctx: ActionCtx,
  t: { orgId: Id<"organizations">; internalId: Id<"transactions">; environment: "sandbox" | "production"; currency: string; amountMinor: number; country?: string; paymentMethod: string },
) {
  return {
    now: () => Date.now(),
    gate: (s: ChainStep) => ctx.runMutation(internal.connections.gateInternal, { connectionId: s.connectionId, providerId: s.providerId }),
    resolve: (s: ChainStep) =>
      resolveConnection(s.connectionId, t.environment, (key) => ctx.runQuery(internal.connections.connectionByKeyInternal, { connectionKey: key })).then((r) => {
        if ("error" in r) return r;
        if (r.orgId && r.orgId !== t.orgId) {
          return { error: mkFailure("configuration_error", "connection_not_owned", "Connection belongs to another organization.", { safeToFailover: true }) };
        }
        return r;
      }),
    onAttempt: async (rec: AttemptRecord, circuit: "success" | "provider_failure" | "neutral") => {
      await ctx.runMutation(internal.connections.recordAttemptInternal, {
        orgId: t.orgId,
        transactionId: t.internalId,
        environment: t.environment,
        attempt: rec.attempt,
        providerId: rec.providerId,
        connectionId: rec.connectionId,
        idempotencyKey: rec.idempotencyKey,
        status: rec.result.status,
        providerReference: rec.result.providerReference,
        providerStatus: rec.result.providerStatus,
        failure: rec.result.failure ? { category: rec.result.failure.category, code: rec.result.failure.code, message: rec.result.failure.message } : undefined,
        latencyMs: rec.latencyMs,
        probe: rec.probe,
        circuit,
        currency: t.currency,
        amountMinor: t.amountMinor,
        country: t.country,
        paymentMethod: t.paymentMethod,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Refunds — one refund row per instruction; ledger posted only on success.
// ---------------------------------------------------------------------------
export const beginRefundInternal = internalMutation({
  args: {
    transactionId: v.string(),
    orgId: v.optional(v.id("organizations")),
    amountMinor: v.optional(v.number()),
    reason: v.optional(v.string()),
    requestedBy: v.string(),
  },
  handler: async (ctx, a) => {
    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_transaction_id", (q) => q.eq("transactionId", a.transactionId))
      .unique();
    if (!txn || (a.orgId && txn.orgId !== a.orgId)) throw new ConvexError("NOT_FOUND: transaction");
    if (txn.status !== "SUCCESSFUL" && txn.status !== "PARTIALLY_REFUNDED") {
      throw new ConvexError(`VALIDATION_ERROR: transaction in status ${txn.status} cannot be refunded`);
    }
    const adapter = getAdapter(txn.provider);
    if (!adapter?.descriptor.operations.refund) throw new ConvexError(`VALIDATION_ERROR: ${txn.provider} does not support refunds via API`);
    const rows = await ctx.db
      .query("refunds")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect();
    const pendingMinor = rows.filter((r) => r.status === "pending").reduce((s, r) => s + r.amountMinor, 0);
    const refundable = txn.amountMinor - (txn.refundedMinor ?? 0) - pendingMinor;
    const amountMinor = a.amountMinor ?? refundable;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new ConvexError("VALIDATION_ERROR: refund amount must be a positive integer of minor units");
    if (amountMinor > refundable) throw new ConvexError(`CONFLICT: refund of ${amountMinor} exceeds refundable ${refundable}`);
    if (amountMinor < txn.amountMinor - (txn.refundedMinor ?? 0) && !adapter.descriptor.operations.partialRefund) {
      throw new ConvexError(`VALIDATION_ERROR: ${adapter.descriptor.displayName} does not support partial refunds`);
    }
    const refundId = `rf_${Date.now().toString(36)}${randomToken(10)}`;
    await ctx.db.insert("refunds", {
      orgId: txn.orgId,
      transactionId: txn._id,
      refundId,
      amountMinor,
      currency: txn.currency,
      status: "pending",
      provider: txn.provider,
      reason: a.reason,
      requestedBy: a.requestedBy,
      createdAt: Date.now(),
    });
    await moveTo(ctx, txn, "REFUND_PENDING", a.requestedBy, {}, { refundId, amountMinor, reason: a.reason });
    return {
      refundId,
      amountMinor,
      internalId: txn._id,
      environment: txn.environment,
      provider: txn.provider,
      connectionId: txn.connectionId ?? platformConnectionId(txn.provider, txn.environment),
      providerReference: txn.providerReference,
      reference: txn.reference,
      currency: txn.currency,
    };
  },
});

export const completeRefundInternal = internalMutation({
  args: {
    refundId: v.string(),
    outcome: v.union(v.literal("successful"), v.literal("failed"), v.literal("pending")),
    providerRefundReference: v.optional(v.string()),
    failureMessage: v.optional(v.string()),
    actor: v.string(),
  },
  handler: async (ctx, a) => {
    const rf = await ctx.db
      .query("refunds")
      .withIndex("by_refund_id", (q) => q.eq("refundId", a.refundId))
      .unique();
    if (!rf) throw new ConvexError("NOT_FOUND: refund");
    let txn = await mustGet(ctx, rf.transactionId);
    if (rf.status !== "pending") return summarize(txn); // duplicate completion

    if (a.outcome === "pending") {
      await ctx.db.patch(rf._id, { providerRefundReference: a.providerRefundReference });
      const jobs = await ctx.db.query("recoveryJobs").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect();
      if (!jobs.some((j) => j.status === "open" && j.refundId === rf.refundId)) {
        await openRecovery(ctx, txn, "refund_status", rf.provider, txn.connectionId ?? platformConnectionId(rf.provider, txn.environment), rf.refundId);
      }
      await enqueueWebhooks(ctx, txn, "refund.pending", { refund: { id: rf.refundId, amount: rf.amountMinor } });
      return summarize(txn);
    }

    const prior = (txn.refundedMinor ?? 0) > 0 ? "PARTIALLY_REFUNDED" : "SUCCESSFUL";
    if (a.outcome === "failed") {
      await ctx.db.patch(rf._id, { status: "failed", failureMessage: a.failureMessage, completedAt: Date.now() });
      const stillPending = (await ctx.db.query("refunds").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect()).some(
        (r) => r.status === "pending" && r._id !== rf._id,
      );
      if (!stillPending && txn.status === "REFUND_PENDING") txn = await moveTo(ctx, txn, prior, a.actor, {}, { refundId: rf.refundId, failed: a.failureMessage });
      await enqueueWebhooks(ctx, txn, "refund.failed", { refund: { id: rf.refundId, amount: rf.amountMinor, message: a.failureMessage } });
      await logAudit(ctx, { orgId: txn.orgId, actor: a.actor, action: "refund.failed", resource: "transaction", resourceId: txn.transactionId, after: { refundId: rf.refundId, message: a.failureMessage } });
      return summarize(txn);
    }

    // successful
    await ctx.db.patch(rf._id, { status: "successful", providerRefundReference: a.providerRefundReference, completedAt: Date.now() });
    const total = (txn.refundedMinor ?? 0) + rf.amountMinor;
    const to: TxState = total >= txn.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const others = (await ctx.db.query("refunds").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect()).some(
      (r) => r.status === "pending" && r._id !== rf._id,
    );
    const target: TxState = others && to === "PARTIALLY_REFUNDED" ? "REFUND_PENDING" : to;
    if (txn.status === target) {
      await ctx.db.patch(txn._id, { refundedMinor: total, updatedAt: Date.now() });
      await recordEvent(ctx, txn._id, { type: "refund.completed", data: { refundId: rf.refundId, amountMinor: rf.amountMinor, totalRefundedMinor: total }, actor: a.actor });
      txn = await mustGet(ctx, txn._id);
    } else {
      txn = await moveTo(ctx, txn, target, a.actor, { refundedMinor: total }, { refundId: rf.refundId, amountMinor: rf.amountMinor, totalRefundedMinor: total, providerRefundReference: a.providerRefundReference });
    }

    await ctx.runMutation(internal.customers.refundCustomerVolumeInternal, {
      orgId: txn.orgId,
      email: txn.customerEmail,
      refundedMinor: rf.amountMinor,
      currency: txn.currency,
    });
    // Money returns from the merchant balance to provider clearing. Platform
    // fees are retained (documented commercial policy).
    await postDoubleEntry(ctx, {
      orgId: txn.orgId,
      ledgerRef: `RFD-${rf.refundId}`,
      transactionId: txn._id,
      postings: [
        {
          account: {
            orgId: txn.orgId,
            merchantId: txn.merchantId,
            currency: txn.currency,
            kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
            code: merchantAccountCode(txn.merchantId, txn.currency),
            name: `merchant balance ${txn.currency}`,
          },
          direction: "debit",
          amountMinor: rf.amountMinor,
          description: `Refund ${rf.refundId}`,
        },
        {
          account: {
            orgId: txn.orgId,
            currency: txn.currency,
            kind: ACCOUNT_KINDS.PROVIDER_CLEARING,
            code: providerClearingCode(txn.provider, txn.currency),
            name: `provider clearing ${txn.provider} ${txn.currency}`,
          },
          direction: "credit",
          amountMinor: rf.amountMinor,
          description: `Refund ${rf.refundId}`,
        },
      ],
    });
    await reverseSplits(ctx, txn, rf.refundId, total - rf.amountMinor, rf.amountMinor, a.actor);
    const jobs = await ctx.db.query("recoveryJobs").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect();
    for (const j of jobs) if (j.status === "open" && j.refundId === rf.refundId) await ctx.db.patch(j._id, { status: "resolved", lastResult: "refund successful", updatedAt: Date.now() });
    await enqueueWebhooks(ctx, txn, "payment.refunded", { refund: { id: rf.refundId, amount: rf.amountMinor, provider_reference: a.providerRefundReference ?? null } });
    await logAudit(ctx, { orgId: txn.orgId, actor: a.actor, action: "transaction.refunded", resource: "transaction", resourceId: txn.transactionId, after: { refundId: rf.refundId, amountMinor: rf.amountMinor, total } });
    return summarize(txn);
  },
});

export const refundInternal = internalAction({
  args: {
    transactionId: v.string(),
    orgId: v.optional(v.id("organizations")),
    amountMinor: v.optional(v.number()),
    reason: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    requestId: v.optional(v.string()),
    actor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ kind: "error" | "done"; code?: string; message?: string; transaction?: TransactionSummary; refundId?: string }> => {
    const actor = args.actor ?? "api";
    const run = async (): Promise<{ statusCode: number; body: TransactionSummary & { refundId: string } }> => {
      const b = await ctx.runMutation(internal.payments.beginRefundInternal, {
        transactionId: args.transactionId,
        orgId: args.orgId,
        amountMinor: args.amountMinor,
        reason: args.reason,
        requestedBy: actor,
      });
      const resolved = await resolveConnection(b.connectionId, b.environment, (key) => ctx.runQuery(internal.connections.connectionByKeyInternal, { connectionKey: key }));
      let outcome: "successful" | "failed" | "pending" = "failed";
      let providerRefundReference: string | undefined;
      let failureMessage: string | undefined;
      if ("error" in resolved) {
        failureMessage = resolved.error.message;
      } else {
        try {
          const r = await resolved.adapter.refund(resolved.ctx, {
            transactionId: args.transactionId,
            refundId: b.refundId,
            idempotencyKey: `${b.refundId}`,
            providerReference: b.providerReference,
            reference: b.reference,
            amountMinor: b.amountMinor,
            currency: b.currency,
            reason: args.reason,
          });
          providerRefundReference = r.providerRefundReference;
          // An unknown refund outcome must not be treated as failed: the
          // provider may have accepted it. Keep it pending for recovery.
          outcome = r.status === "successful" ? "successful" : r.status === "failed" ? "failed" : "pending";
          failureMessage = r.failure?.message;
        } catch (err) {
          outcome = "pending";
          failureMessage = err instanceof Error ? err.message : String(err);
        }
      }
      const summary = await ctx.runMutation(internal.payments.completeRefundInternal, {
        refundId: b.refundId,
        outcome,
        providerRefundReference,
        failureMessage,
        actor,
      });
      if (outcome === "failed") throw new Error(`PROVIDER_REFUND_FAILED: ${failureMessage ?? "refund failed"}`);
      return { statusCode: 200, body: { ...summary, refundId: b.refundId } };
    };

    const mapErr = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /^(?:Uncaught ConvexError: )?(IDEMPOTENCY_CONFLICT|CONFLICT|NOT_FOUND|VALIDATION_ERROR|PROVIDER_REFUND_FAILED|ILLEGAL_TRANSITION):?\s*(.*)$/s.exec(msg);
      const codes: Record<string, string> = {
        IDEMPOTENCY_CONFLICT: "idempotency_conflict",
        CONFLICT: "conflict",
        NOT_FOUND: "not_found",
        VALIDATION_ERROR: "validation_error",
        PROVIDER_REFUND_FAILED: "provider_refund_failed",
        ILLEGAL_TRANSITION: "conflict",
      };
      return { kind: "error" as const, code: m ? codes[m[1]] : "processing_error", message: m ? m[2] : msg };
    };

    try {
      if (args.idempotencyKey) {
        const txn = await ctx.runQuery(internal.payments.transactionByTransactionId, { transactionId: args.transactionId });
        if (!txn || (args.orgId && txn.orgId !== args.orgId)) return { kind: "error", code: "not_found", message: "Transaction not found." };
        const fp = await fingerprint({ transactionId: args.transactionId, amountMinor: args.amountMinor ?? null, kind: "refund" });
        const r = await withIdempotency<TransactionSummary & { refundId: string }>(ctx, { orgId: txn.orgId, key: `refund_${args.idempotencyKey}`, fp }, run);
        return { kind: "done", transaction: r.body, refundId: r.body.refundId };
      }
      const r = await run();
      return { kind: "done", transaction: r.body, refundId: r.body.refundId };
    } catch (err) {
      return mapErr(err);
    }
  },
});
