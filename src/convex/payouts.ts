// USOPGRID payouts engine + beneficiaries.
//
// Payout lifecycle: PENDING → PROCESSING → SUCCESSFUL | FAILED | REVERSED.
// Ledger model (all balanced groups):
//   create:   Dr merchant_balance (amount+fee) / Cr payouts_payable + platform_fees
//   success:  Dr payouts_payable (amount)   / Cr provider clearing (rail out)
//   failed:   Dr payouts_payable (amount)   / Cr merchant_balance (+fee return)
//   reversed: Dr merchant_balance (amount)  / Cr provider clearing (rail back)
//
// Beneficiary account numbers are never stored — masked display + sha-256
// hash for duplicate detection only.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember, requireOrgMemberAction } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { postDoubleEntry, merchantAccountCode, providerClearingCode, feesAccountCode, ACCOUNT_KINDS } from "./lib/ledger";
import { logAudit } from "./lib/audit";
import { sha256Hex, randomToken } from "./lib/crypto";
import { isSupportedCurrency } from "../lib/money";
import { withIdempotency, fingerprint } from "./lib/idempotency";

export const PAYOUT_FEE_BPS = 20; // 0.2% payout fee, integer math
export const PAYOUT_MINOR_FEE_CAP = 100_000; // cap: 1,000.00 major units

function payoutFee(amountMinor: number): number {
  return Math.min(Math.round((amountMinor * PAYOUT_FEE_BPS) / 10_000), PAYOUT_MINOR_FEE_CAP);
}

// ---------------------------------------------------------------------------
// Beneficiaries — dashboard surface
// ---------------------------------------------------------------------------
export const listBeneficiaries = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("beneficiaries")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(100);
  },
});

export const createBeneficiary = mutation({
  args: {
    name: v.string(),
    bankName: v.string(),
    bankCode: v.optional(v.string()),
    accountNumber: v.string(),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const name = args.name.trim();
    const bankName = args.bankName.trim();
    const accountNumber = args.accountNumber.replace(/\s+/g, "");
    if (!name || !bankName) throw new ConvexError("VALIDATION_ERROR: name and bank are required");
    if (!/^\d{6,20}$/.test(accountNumber)) {
      throw new ConvexError("VALIDATION_ERROR: account number must be 6–20 digits");
    }
    if (!isSupportedCurrency(args.currency)) {
      throw new ConvexError(`VALIDATION_ERROR: unsupported currency '${args.currency}'`);
    }

    const accountHash = await sha256Hex(`${accountNumber}:${args.bankCode ?? bankName}`);
    const dup = await ctx.db
      .query("beneficiaries")
      .withIndex("by_org_hash", (q) => q.eq("orgId", oc.orgId).eq("accountHash", accountHash))
      .first();
    if (dup) {
      throw new ConvexError(`CONFLICT: this account already exists as beneficiary ${dup.name}`);
    }

    const id = await ctx.db.insert("beneficiaries", {
      orgId: oc.orgId,
      name,
      bankName,
      bankCode: args.bankCode,
      accountMasked: `••••${accountNumber.slice(-4)}`,
      accountHash,
      currency: args.currency,
      // v1 sandbox: accounts verify immediately; real verification is a
      // provider/verification-adapter concern for a later stage.
      status: "verified",
      verifiedAt: Date.now(),
      createdByUserId: oc.userId,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "beneficiary.created",
      resource: "beneficiary",
      resourceId: id,
      after: { name, bankName, accountMasked: `••••${accountNumber.slice(-4)}` },
    });
    return { _id: id };
  },
});

// ---------------------------------------------------------------------------
// Payouts — dashboard surface
// ---------------------------------------------------------------------------
export const listPayouts = query({
  args: {
    paginationOpts: v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("payouts")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// Resolve payout context for the dashboard action (permission-checked query).
export const resolvePayoutContext = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const merchant = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .first();
    if (!merchant) throw new ConvexError("No merchant configured for this organization");
    return {
      orgId: oc.orgId,
      merchantId: merchant._id,
      environment: (oc.org.environment ?? "sandbox") as "sandbox" | "production",
    };
  },
});

export const createDashboardPayout = action({
  args: {
    beneficiaryId: v.id("beneficiaries"),
    amountMinor: v.number(),
    narration: v.optional(v.string()),
    simulate: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ payoutId: string; status: string }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const beneficiary = await ctx.runQuery(internal.payouts.beneficiaryByIdInternal, {
      beneficiaryId: args.beneficiaryId,
    });
    if (!beneficiary || beneficiary.orgId !== oc.orgId) {
      throw new ConvexError("NOT_FOUND: beneficiary does not belong to this organization");
    }
    const result = await ctx.runAction(internal.payouts.payoutInternal, {
      orgId: oc.orgId,
      beneficiaryId: args.beneficiaryId,
      amountMinor: args.amountMinor,
      narration: args.narration,
      simulate: args.simulate,
      actor: oc.userId,
    });
    if (result.kind === "error") {
      throw new ConvexError(result.message ?? "Payout failed");
    }
    return { payoutId: result.payoutId!, status: result.status! };
  },
});

export const beneficiaryByIdInternal = internalQuery({
  args: { beneficiaryId: v.id("beneficiaries") },
  handler: async (ctx, args) => ctx.db.get(args.beneficiaryId),
});

export const payoutByPayoutIdInternal = internalQuery({
  args: { payoutId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query("payouts")
      .withIndex("by_payout_id", (q) => q.eq("payoutId", args.payoutId))
      .unique();
    return p ?? null;
  },
});

// ---------------------------------------------------------------------------
// Payout engine
// ---------------------------------------------------------------------------
export const payoutInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    beneficiaryId: v.id("beneficiaries"),
    amountMinor: v.number(),
    narration: v.optional(v.string()),
    simulate: v.optional(v.string()),
    actor: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    kind: "done" | "error";
    payoutId?: string;
    status?: string;
    message?: string;
  }> => {
    if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
      return { kind: "error", message: "VALIDATION_ERROR: amount must be a positive integer of minor units" };
    }

    const run = async (): Promise<{ statusCode: number; body: { payoutId: string; status: string } }> => {
      const created = await ctx.runMutation(internal.payouts.createPayoutRecordInternal, {
        orgId: args.orgId,
        beneficiaryId: args.beneficiaryId,
        amountMinor: args.amountMinor,
        narration: args.narration,
        actor: args.actor,
      });
      if (created.kind === "error") {
        throw new Error(created.message ?? "Payout failed");
      }
      const { payoutId } = created;

      await ctx.runMutation(internal.payouts.transitionPayoutInternal, {
        payoutId,
        toStatus: "PROCESSING",
        actor: "system",
      });

      // Sandbox payout rail — real payout adapters plug in here.
      const simulate = args.simulate;
      let ok = true;
      let failure: { category: string; code: string; message: string; retryable: boolean } | undefined;
      if (simulate && simulate !== "success") {
        ok = false;
        failure = {
          category: "temporary_provider_failure",
          code: `sandbox_payout_${simulate}`,
          message: `Payout failed in sandbox simulation (${simulate}).`,
          retryable: simulate !== "insufficient_funds",
        };
      }
      const providerReference = `sbxp_${randomToken(8)}`;

      if (!ok && failure) {
        await ctx.runMutation(internal.payouts.completePayoutInternal, {
          payoutId,
          outcome: "failed",
          providerReference,
          failure,
        });
        const p = await ctx.runQuery(internal.payouts.payoutByPayoutIdInternal, { payoutId });
        return { statusCode: 201, body: { payoutId, status: p?.status ?? "FAILED" } };
      }

      await ctx.runMutation(internal.payouts.completePayoutInternal, {
        payoutId,
        outcome: "successful",
        providerReference,
      });
      return { statusCode: 201, body: { payoutId, status: "SUCCESSFUL" } };
    };

    if (args.idempotencyKey) {
      const fp = await fingerprint({
        beneficiaryId: args.beneficiaryId,
        amountMinor: args.amountMinor,
        kind: "payout",
      });
      try {
        const r = await withIdempotency<{ payoutId: string; status: string }>(
          ctx,
          { orgId: args.orgId, key: `payout_${args.idempotencyKey}`, fp },
          run,
        );
        return { kind: "done", payoutId: r.body.payoutId, status: r.body.status };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Payout failed";
        return { kind: "error", message: msg };
      }
    }

    try {
      const r = await run();
      return { kind: "done", payoutId: r.body.payoutId, status: r.body.status };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : "Payout failed" };
    }
  },
});

export const createPayoutRecordInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    beneficiaryId: v.id("beneficiaries"),
    amountMinor: v.number(),
    narration: v.optional(v.string()),
    actor: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "ok"; payoutId: string } | { kind: "error"; message: string }> => {
    const beneficiary = await ctx.db.get(args.beneficiaryId);
    if (!beneficiary || beneficiary.orgId !== args.orgId) {
      return { kind: "error", message: "NOT_FOUND: beneficiary" };
    }
    if (beneficiary.status !== "verified") {
      return { kind: "error", message: `VALIDATION_ERROR: beneficiary is ${beneficiary.status}` };
    }

    const merchant = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (!merchant) return { kind: "error", message: "VALIDATION_ERROR: no merchant configured" };

    const currency = beneficiary.currency;
    const feeMinor = payoutFee(args.amountMinor);
    const debitTotal = args.amountMinor + feeMinor;

    // Balance check straight from the ledger.
    const accountCode = merchantAccountCode(merchant._id, currency);
    const account = await ctx.db
      .query("ledgerAccounts")
      .withIndex("by_code", (q) => q.eq("code", accountCode))
      .unique();
    let balanceMinor = 0;
    if (account) {
      const entries = await ctx.db
        .query("ledgerEntries")
        .withIndex("by_account_at", (q) => q.eq("accountId", account._id))
        .collect();
      for (const e of entries) balanceMinor += e.direction === "credit" ? e.amountMinor : -e.amountMinor;
    }
    if (balanceMinor < debitTotal) {
      return {
        kind: "error",
        message: `VALIDATION_ERROR: insufficient balance — available ${balanceMinor}, needed ${debitTotal} (amount + fee). Settle a batch first or reduce the amount.`,
      };
    }

    const now = Date.now();
    const payoutId = `po_${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36).padStart(4, "0")}`;
    const reference = `payout_${payoutId}`;

    await ctx.db.insert("payouts", {
      orgId: args.orgId,
      merchantId: merchant._id,
      beneficiaryId: args.beneficiaryId,
      payoutId,
      reference,
      amountMinor: args.amountMinor,
      feeMinor,
      currency,
      status: "PENDING",
      narration: args.narration,
      createdAt: now,
      updatedAt: now,
    });

    // Ledger: reserve funds out of merchant balance into payouts payable.
    await postDoubleEntry(ctx, {
      orgId: args.orgId,
      ledgerRef: `PO-${payoutId}`,
      postings: [
        {
          account: {
            orgId: args.orgId,
            merchantId: merchant._id,
            currency,
            kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
            code: accountCode,
            name: `${merchant.name} balance ${currency}`,
          },
          direction: "debit",
          amountMinor: debitTotal,
          description: `Payout ${payoutId} to ${beneficiary.accountMasked}`,
        },
        {
          account: {
            orgId: args.orgId,
            merchantId: merchant._id,
            currency,
            kind: "payouts_payable",
            code: `payouts_payable_${merchant._id}_${currency}`,
            name: `payouts payable ${currency}`,
          },
          direction: "credit",
          amountMinor: args.amountMinor,
          description: `Payout ${payoutId} payable`,
        },
        ...(feeMinor > 0
          ? [
              {
                account: {
                  orgId: args.orgId,
                  currency,
                  kind: ACCOUNT_KINDS.PLATFORM_FEES,
                  code: feesAccountCode(currency),
                  name: `USOPGRID fees ${currency}`,
                },
                direction: "credit" as const,
                amountMinor: feeMinor,
                description: `Payout fee ${payoutId}`,
              },
            ]
          : []),
      ],
    });

    await logAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor ?? "api",
      action: "payout.created",
      resource: "payout",
      resourceId: payoutId,
      after: { amountMinor: args.amountMinor, feeMinor, currency },
    });

    return { kind: "ok", payoutId };
  },
});

export const transitionPayoutInternal = internalMutation({
  args: { payoutId: v.string(), toStatus: v.string(), actor: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query("payouts")
      .withIndex("by_payout_id", (q) => q.eq("payoutId", args.payoutId))
      .unique();
    if (!p) throw new ConvexError("payout not found");
    await ctx.db.patch(p._id, { status: args.toStatus as never, updatedAt: Date.now() });
  },
});

export const completePayoutInternal = internalMutation({
  args: {
    payoutId: v.string(),
    outcome: v.union(v.literal("successful"), v.literal("failed"), v.literal("reversed")),
    providerReference: v.string(),
    failure: v.optional(
      v.object({
        category: v.string(),
        code: v.string(),
        message: v.string(),
        retryable: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query("payouts")
      .withIndex("by_payout_id", (q) => q.eq("payoutId", args.payoutId))
      .unique();
    if (!p) throw new ConvexError("payout not found");
    if (p.status === "SUCCESSFUL" || p.status === "FAILED" || p.status === "REVERSED") return; // idempotent

    const merchant = await ctx.db.get(p.merchantId);
    if (!merchant) throw new ConvexError("merchant not found");

    const now = Date.now();
    await ctx.db.patch(p._id, {
      status: (args.outcome === "successful" ? "SUCCESSFUL" : args.outcome === "failed" ? "FAILED" : "REVERSED") as never,
      provider: "sandbox",
      providerReference: args.providerReference,
      failureCategory: args.failure?.category,
      failureCode: args.failure?.code,
      failureMessage: args.failure?.message,
      failureRetryable: args.failure?.retryable,
      completedAt: now,
      updatedAt: now,
    });

    if (args.outcome === "successful") {
      // Rail the money out: clear payouts payable through provider clearing.
      await postDoubleEntry(ctx, {
        orgId: p.orgId,
        ledgerRef: `PO-OUT-${p.payoutId}`,
        postings: [
          {
            account: {
              orgId: p.orgId,
              merchantId: p.merchantId,
              currency: p.currency,
              kind: "payouts_payable",
              code: `payouts_payable_${p.merchantId}_${p.currency}`,
              name: `payouts payable ${p.currency}`,
            },
            direction: "debit",
            amountMinor: p.amountMinor,
            description: `Payout ${p.payoutId} sent`,
          },
          {
            account: {
              orgId: p.orgId,
              currency: p.currency,
              kind: ACCOUNT_KINDS.PROVIDER_CLEARING,
              code: providerClearingCode("sandbox_payouts", p.currency),
              name: `Payout rail clearing ${p.currency}`,
            },
            direction: "credit",
            amountMinor: p.amountMinor,
            description: `Payout ${p.payoutId} disbursed`,
          },
        ],
      });
    } else if (args.outcome === "failed") {
      // Money (and fee) returns to the merchant balance.
      await postDoubleEntry(ctx, {
        orgId: p.orgId,
        ledgerRef: `PO-FAIL-${p.payoutId}`,
        postings: [
          {
            account: {
              orgId: p.orgId,
              merchantId: p.merchantId,
              currency: p.currency,
              kind: "payouts_payable",
              code: `payouts_payable_${p.merchantId}_${p.currency}`,
              name: `payouts payable ${p.currency}`,
            },
            direction: "debit",
            amountMinor: p.amountMinor,
            description: `Payout ${p.payoutId} failed — return`,
          },
          {
            account: {
              orgId: p.orgId,
              merchantId: p.merchantId,
              currency: p.currency,
              kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
              code: merchantAccountCode(p.merchantId, p.currency),
              name: `${merchant.name} balance ${p.currency}`,
            },
            direction: "credit",
            amountMinor: p.amountMinor + p.feeMinor,
            description: `Payout ${p.payoutId} failed — refund incl. fee`,
          },
          ...(p.feeMinor > 0
            ? [
                {
                  account: {
                    orgId: p.orgId,
                    currency: p.currency,
                    kind: ACCOUNT_KINDS.PLATFORM_FEES,
                    code: feesAccountCode(p.currency),
                    name: `USOPGRID fees ${p.currency}`,
                  },
                  direction: "debit" as const,
                  amountMinor: p.feeMinor,
                  description: `Payout fee reversal ${p.payoutId}`,
                },
              ]
            : []),
        ],
      });
    } else {
      // Reversed after success: money comes back from the rail.
      await postDoubleEntry(ctx, {
        orgId: p.orgId,
        ledgerRef: `PO-REV-${p.payoutId}`,
        postings: [
          {
            account: {
              orgId: p.orgId,
              currency: p.currency,
              kind: ACCOUNT_KINDS.PROVIDER_CLEARING,
              code: providerClearingCode("sandbox_payouts", p.currency),
              name: `Payout rail clearing ${p.currency}`,
            },
            direction: "debit",
            amountMinor: p.amountMinor,
            description: `Payout ${p.payoutId} reversed`,
          },
          {
            account: {
              orgId: p.orgId,
              merchantId: p.merchantId,
              currency: p.currency,
              kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
              code: merchantAccountCode(p.merchantId, p.currency),
              name: `${merchant.name} balance ${p.currency}`,
            },
            direction: "credit",
            amountMinor: p.amountMinor,
            description: `Payout ${p.payoutId} reversed to balance`,
          },
        ],
      });
    }

    await logAudit(ctx, {
      orgId: p.orgId,
      actor: "system",
      action: `payout.${args.outcome}`,
      resource: "payout",
      resourceId: p.payoutId,
      after: { providerReference: args.providerReference, failure: args.failure },
    });
  },
});
