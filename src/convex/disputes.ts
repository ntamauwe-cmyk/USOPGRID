// USOPGRID disputes engine. Lifecycle:
//   OPEN → AWAITING_EVIDENCE → UNDER_REVIEW → WON | LOST | CANCELLED
// Ledger impact only on terminal outcomes:
//   LOST:  chargeback — money leaves merchant_balance back to the rail
//   WON:   no money moves — funds were never debited
// Opening a dispute marks the transaction DISPUTED (append-only event).

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireOrgMember } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { postDoubleEntry, merchantAccountCode, providerClearingCode, ACCOUNT_KINDS } from "./lib/ledger";
import { logAudit } from "./lib/audit";

const DISPUTE_FEE_MINOR = 150_000; // 1,500.00 major units — standard chargeback fee

// ---------------------------------------------------------------------------
// Dashboard surface
// ---------------------------------------------------------------------------
export const listDisputes = query({
  args: {
    paginationOpts: v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("disputes")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getDispute = query({
  args: { disputeId: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    const d = await ctx.db
      .query("disputes")
      .withIndex("by_dispute_id", (q) => q.eq("disputeId", args.disputeId))
      .unique();
    if (!d || d.orgId !== oc.orgId) return null;
    const events = await ctx.db
      .query("disputeEvents")
      .withIndex("by_dispute", (q) => q.eq("disputeId", d._id))
      .collect();
    events.sort((a, b) => a.at - b.at);
    const txn = await ctx.db.get(d.transactionId);
    return {
      dispute: d,
      transaction: txn
        ? {
            transactionId: txn.transactionId,
            reference: txn.reference,
            amountMinor: txn.amountMinor,
            currency: txn.currency,
            customerEmail: txn.customerEmail ?? null,
            paymentMethod: txn.paymentMethod,
          }
        : null,
      events: events.map((e) => ({ _id: e._id, type: e.type, data: e.data ?? null, actor: e.actor, at: e.at })),
    };
  },
});

// Resolve context for dashboard actions (permission-checked query).
export const resolveDisputeContext = query({
  args: { transactionId: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_transaction_id", (q) => q.eq("transactionId", args.transactionId))
      .unique();
    if (!txn || txn.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: transaction");
    return { orgId: oc.orgId, txnInternalId: txn._id, status: txn.status };
  },
});

export const openDashboardDispute = mutation({
  args: {
    transactionId: v.string(),
    reasonCode: v.string(),
    reasonDetails: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_transaction_id", (q) => q.eq("transactionId", args.transactionId))
      .unique();
    if (!txn || txn.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: transaction");
    const result = await openDispute(ctx, {
      txn,
      reasonCode: args.reasonCode,
      reasonDetails: args.reasonDetails,
      actor: oc.userId,
    });
    return { disputeId: result };
  },
});

export const addDashboardEvidence = mutation({
  args: { disputeId: v.string(), note: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const d = await ctx.db
      .query("disputes")
      .withIndex("by_dispute_id", (q) => q.eq("disputeId", args.disputeId))
      .unique();
    if (!d || d.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: dispute");
    await addEvidence(ctx, d, args.note, oc.userId);
  },
});

export const resolveDashboardDispute = mutation({
  args: {
    disputeId: v.string(),
    outcome: v.union(v.literal("won"), v.literal("lost"), v.literal("cancelled")),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const d = await ctx.db
      .query("disputes")
      .withIndex("by_dispute_id", (q) => q.eq("disputeId", args.disputeId))
      .unique();
    if (!d || d.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: dispute");
    await resolveDispute(ctx, d, args.outcome, oc.userId);
  },
});

// ---------------------------------------------------------------------------
// Engine internals
// ---------------------------------------------------------------------------
async function openDispute(
  ctx: MutationCtx,
  args: {
    txn: Doc<"transactions">;
    reasonCode: string;
    reasonDetails?: string;
    actor: string;
  },
): Promise<string> {
  if (args.txn.status !== "SUCCESSFUL" && args.txn.status !== "PARTIALLY_REFUNDED") {
    throw new ConvexError(`VALIDATION_ERROR: disputes can only be opened on successful payments (status is ${args.txn.status})`);
  }
  const existing = await ctx.db
    .query("disputes")
    .withIndex("by_transaction", (q) => q.eq("transactionId", args.txn._id))
    .collect();
  if (existing.some((d) => !["LOST", "WON", "CANCELLED"].includes(d.status))) {
    throw new ConvexError("CONFLICT: an open dispute already exists for this transaction");
  }

  const now = Date.now();
  const disputeId = `dsp_${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36).padStart(4, "0")}`;
  const docId = await ctx.db.insert("disputes", {
    orgId: args.txn.orgId,
    transactionId: args.txn._id,
    disputeId,
    status: "AWAITING_EVIDENCE",
    reasonCode: args.reasonCode,
    reasonDetails: args.reasonDetails,
    amountMinor: args.txn.amountMinor,
    currency: args.txn.currency,
    evidence: [],
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("disputeEvents", {
    disputeId: docId,
    type: "opened",
    data: { reasonCode: args.reasonCode, reasonDetails: args.reasonDetails },
    actor: args.actor,
    at: now,
  });

  // Mark the transaction DISPUTED (append-only event, no money movement yet).
  await ctx.db.patch(args.txn._id, { status: "DISPUTED" as never, updatedAt: now });
  await ctx.db.insert("transactionEvents", {
    transactionId: args.txn._id,
    type: "disputed",
    fromStatus: "SUCCESSFUL",
    toStatus: "DISPUTED",
    data: { disputeId, reasonCode: args.reasonCode },
    actor: args.actor,
    at: now,
  });

  await logAudit(ctx, {
    orgId: args.txn.orgId,
    actor: args.actor,
    action: "dispute.opened",
    resource: "dispute",
    resourceId: disputeId,
    after: { reasonCode: args.reasonCode, transactionId: args.txn.transactionId },
  });
  return disputeId;
}

async function addEvidence(ctx: MutationCtx, d: Doc<"disputes">, note: string, actor: string) {
  if (!note.trim()) throw new ConvexError("VALIDATION_ERROR: evidence note is required");
  if (["WON", "LOST", "CANCELLED"].includes(d.status)) {
    throw new ConvexError("VALIDATION_ERROR: cannot add evidence to a resolved dispute");
  }
  const now = Date.now();
  const evidence = [...(d.evidence ?? []), { note: note.trim(), addedBy: actor, addedAt: now }];
  await ctx.db.patch(d._id, { evidence, status: "UNDER_REVIEW", updatedAt: now });
  await ctx.db.insert("disputeEvents", {
    disputeId: d._id,
    type: "evidence_added",
    data: { note: note.trim(), evidenceCount: evidence.length },
    actor,
    at: now,
  });
  await logAudit(ctx, {
    orgId: d.orgId,
    actor,
    action: "dispute.evidence_added",
    resource: "dispute",
    resourceId: d.disputeId,
  });
}

async function resolveDispute(
  ctx: MutationCtx,
  d: Doc<"disputes">,
  outcome: "won" | "lost" | "cancelled",
  actor: string,
) {
  if (["WON", "LOST", "CANCELLED"].includes(d.status)) {
    throw new ConvexError(`VALIDATION_ERROR: dispute already resolved (${d.status})`);
  }
  const now = Date.now();
  const finalStatus = outcome === "won" ? "WON" : outcome === "lost" ? "LOST" : "CANCELLED";

  await ctx.db.patch(d._id, {
    status: finalStatus as never,
    resolution:
      outcome === "lost"
        ? `Chargeback upheld — ${d.amountMinor} minor units returned to the cardholder plus a ${DISPUTE_FEE_MINOR} dispute fee.`
        : outcome === "won"
          ? "Dispute resolved in the merchant's favor — no funds returned."
          : "Dispute withdrawn by the merchant.",
    resolvedAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("disputeEvents", {
    disputeId: d._id,
    type: "resolved",
    data: { outcome },
    actor,
    at: now,
  });

  const txn = await ctx.db.get(d.transactionId);
  if (txn) {
    if (outcome === "lost") {
      // Chargeback: money leaves the merchant balance back to the rail,
      // plus a dispute fee to platform fees. Balanced group.
      const debitTotal = d.amountMinor + DISPUTE_FEE_MINOR;
      await postDoubleEntry(ctx, {
        orgId: d.orgId,
        ledgerRef: `DSP-${d.disputeId}`,
        transactionId: d.transactionId,
        postings: [
          {
            account: {
              orgId: d.orgId,
              merchantId: txn.merchantId,
              currency: d.currency,
              kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
              code: merchantAccountCode(txn.merchantId, d.currency),
              name: `merchant balance ${d.currency}`,
            },
            direction: "debit",
            amountMinor: debitTotal,
            description: `Chargeback ${d.disputeId} (amount + fee)`,
          },
          {
            account: {
              orgId: d.orgId,
              currency: d.currency,
              kind: ACCOUNT_KINDS.PROVIDER_CLEARING,
              code: providerClearingCode(txn.provider, d.currency),
              name: `provider clearing ${txn.provider} ${d.currency}`,
            },
            direction: "credit",
            amountMinor: d.amountMinor,
            description: `Chargeback ${d.disputeId}`,
          },
          {
            account: {
              orgId: d.orgId,
              currency: d.currency,
              kind: ACCOUNT_KINDS.PLATFORM_FEES,
              code: `platform_fees_${d.currency}`,
              name: `USOPGRID fees ${d.currency}`,
            },
            direction: "credit",
            amountMinor: DISPUTE_FEE_MINOR,
            description: `Dispute fee ${d.disputeId}`,
          },
        ],
      });
      await ctx.db.patch(txn._id, { status: "REVERSED" as never, updatedAt: now });
    } else if (outcome === "cancelled") {
      await ctx.db.patch(txn._id, { status: "SUCCESSFUL" as never, updatedAt: now });
    } else {
      // WON: transaction stays SUCCESSFUL; funds were never moved.
      await ctx.db.patch(txn._id, { status: "SUCCESSFUL" as never, updatedAt: now });
    }
    await ctx.db.insert("transactionEvents", {
      transactionId: txn._id,
      type: "dispute.resolved",
      fromStatus: "DISPUTED",
      toStatus: outcome === "lost" ? "REVERSED" : "SUCCESSFUL",
      data: { disputeId: d.disputeId, outcome },
      actor,
      at: now,
    });
  }

  await logAudit(ctx, {
    orgId: d.orgId,
    actor,
    action: "dispute.resolved",
    resource: "dispute",
    resourceId: d.disputeId,
    after: { outcome },
  });
}

// Internal mutations used by provider webhook flows (provider-initiated
// chargebacks/updates). Kept internal so external systems can never touch
// disputes without going through USOPGRID's engine + tenant checks.
export const openDisputeInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
    reasonCode: v.string(),
    reasonDetails: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn || txn.orgId !== args.orgId) throw new ConvexError("NOT_FOUND");
    return openDispute(ctx, {
      txn,
      reasonCode: args.reasonCode,
      reasonDetails: args.reasonDetails,
      actor: "provider_webhook",
    });
  },
});

export const resolveDisputeInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    disputeId: v.string(),
    outcome: v.union(v.literal("won"), v.literal("lost"), v.literal("cancelled")),
    actor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db
      .query("disputes")
      .withIndex("by_dispute_id", (q) => q.eq("disputeId", args.disputeId))
      .unique();
    if (!d || d.orgId !== args.orgId) throw new ConvexError("NOT_FOUND");
    await resolveDispute(ctx, d, args.outcome, args.actor ?? "provider_webhook");
    return { disputeId: args.disputeId, outcome: args.outcome };
  },
});
