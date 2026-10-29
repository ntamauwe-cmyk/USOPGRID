// USOPGRID payouts engine + beneficiaries.
//
// Payout lifecycle: PENDING → PROCESSING → SUCCESSFUL | FAILED | REVERSED.
// Ledger model (all balanced groups):
//   create:   Dr merchant_balance (amount+fee) / Cr payouts_payable + platform_fees
//   success:  Dr payouts_payable (amount)   / Cr provider clearing (rail out)
//   failed:   Dr payouts_payable (amount)   / Cr merchant_balance (+fee return)
//   reversed: Dr merchant_balance (amount)  / Cr provider clearing (rail back)
//
// Beneficiary account numbers are stored only AES-256-GCM sealed (bound to
// the org + account hash) and opened solely inside the payout action; the UI
// and API only ever see a masked value. Payouts go to real rails (Paystack,
// Flutterwave) in live mode and to the simulated rail in sandbox; pending or
// ambiguous outcomes are resolved by status lookup, never by re-sending.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery, query, action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { getAdapter, SANDBOX_PROVIDER_IDS } from "./providers/index";
import type { FailureInfo, PayoutResult } from "./providers/types";
import { failure as mkFailure } from "./providers/types";
import { platformConnectionId, resolveConnection, notify, type RoutingContext } from "./connections";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember, requireOrgMemberAction } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { postDoubleEntry, merchantAccountCode, providerClearingCode, feesAccountCode, recipientAccountCode, ACCOUNT_KINDS, type Posting } from "./lib/ledger";
import { logAudit } from "./lib/audit";
import { sha256Hex } from "./lib/crypto";
import { seal, open as openSealed, keyringConfigured } from "./lib/keyring";
import { isSupportedCurrency } from "../lib/money";
import { withIdempotency, fingerprint } from "./lib/idempotency";
import { payoutNeedsApproval, type ApprovalPolicy } from "./lib/approvals";
import { formatMoney } from "../lib/money";

export const PAYOUT_FEE_BPS = 20; // 0.2% payout fee, integer math
export const PAYOUT_MINOR_FEE_CAP = 100_000; // cap: 1,000.00 major units

export function payoutFee(amountMinor: number): number {
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

export const createBeneficiary = action({
  args: {
    name: v.string(),
    bankName: v.string(),
    bankCode: v.optional(v.string()),
    accountNumber: v.string(),
    currency: v.string(),
    country: v.optional(v.string()),
    accountType: v.optional(v.union(v.literal("bank_account"), v.literal("mobile_money"))),
  },
  handler: async (ctx, args): Promise<{ _id: Id<"beneficiaries"> }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.PAYMENTS_CREATE });
    const environment = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const prepared = await prepareBeneficiary(oc.orgId, environment, args);
    return await ctx.runMutation(internal.payouts.insertBeneficiaryInternal, { ...prepared, userId: oc.userId });
  },
});

export interface BeneficiaryInput {
  name: string;
  bankName: string;
  bankCode?: string;
  accountNumber: string;
  currency: string;
  country?: string;
  accountType?: "bank_account" | "mobile_money";
}

/** Validate payout account details and seal the account number. Never stores it in clear. */
export async function prepareBeneficiary(orgId: Id<"organizations">, environment: "sandbox" | "production", args: BeneficiaryInput) {
  const name = args.name.trim();
  const bankName = args.bankName.trim();
  const accountNumber = args.accountNumber.replace(/[\s-]+/g, "");
  if (!name || name.length > 120 || !bankName || bankName.length > 120) throw new ConvexError("VALIDATION_ERROR: name and bank are required");
  if (!/^\+?\d{6,34}$/.test(accountNumber)) {
    throw new ConvexError("VALIDATION_ERROR: account or wallet number must be 6–34 digits");
  }
  if (!isSupportedCurrency(args.currency)) {
    throw new ConvexError(`VALIDATION_ERROR: unsupported currency '${args.currency}'`);
  }
  if (args.country !== undefined && args.country !== "" && !/^[A-Za-z]{2}$/.test(args.country)) {
    throw new ConvexError("VALIDATION_ERROR: country must be an ISO 3166-1 alpha-2 code");
  }
  const accountHash = await sha256Hex(`${accountNumber}:${args.bankCode ?? bankName}`);
  const encryption = keyringConfigured();
  if (!encryption && environment === "production") {
    throw new ConvexError("Payout accounts cannot be stored securely: the encryption key is not configured.");
  }
  const sealedAccount = encryption ? await seal(accountNumber, `beneficiary:${orgId}:${accountHash}`) : undefined;
  return {
    orgId,
    name,
    bankName,
    bankCode: args.bankCode?.trim() || undefined,
    accountMasked: `••••${accountNumber.slice(-4)}`,
    accountHash,
    sealedAccount,
    currency: args.currency.toUpperCase(),
    country: args.country?.toUpperCase() || undefined,
    accountType: args.accountType ?? ("bank_account" as const),
  };
}

export const insertBeneficiaryInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.optional(v.id("users")),
    name: v.string(),
    bankName: v.string(),
    bankCode: v.optional(v.string()),
    accountMasked: v.string(),
    accountHash: v.string(),
    sealedAccount: v.optional(v.string()),
    currency: v.string(),
    country: v.optional(v.string()),
    accountType: v.union(v.literal("bank_account"), v.literal("mobile_money")),
  },
  handler: async (ctx, a) => {
    const dup = await ctx.db
      .query("beneficiaries")
      .withIndex("by_org_hash", (q) => q.eq("orgId", a.orgId).eq("accountHash", a.accountHash))
      .first();
    if (dup) throw new ConvexError(`CONFLICT: this account already exists as beneficiary ${dup.name}`);
    const id = await ctx.db.insert("beneficiaries", {
      orgId: a.orgId,
      name: a.name,
      bankName: a.bankName,
      bankCode: a.bankCode,
      accountMasked: a.accountMasked,
      accountHash: a.accountHash,
      sealedAccount: a.sealedAccount,
      accountType: a.accountType,
      country: a.country,
      currency: a.currency,
      // Account-name verification is performed by the payout provider at
      // transfer time (recipient creation rejects invalid accounts).
      status: "verified",
      verifiedAt: Date.now(),
      createdByUserId: a.userId,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      orgId: a.orgId,
      actor: a.userId ?? "api",
      action: "beneficiary.created",
      resource: "beneficiary",
      resourceId: id,
      after: { name: a.name, bankName: a.bankName, accountMasked: a.accountMasked, currency: a.currency },
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
  handler: async (ctx, args): Promise<{ payoutId: string; status: string; approvalId?: string }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    // Moving money out is a sensitive action: MFA step-up when enabled/required.
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.PAYMENTS_CREATE });
    const beneficiary = await ctx.runQuery(internal.payouts.beneficiaryByIdInternal, {
      beneficiaryId: args.beneficiaryId,
    });
    if (!beneficiary || beneficiary.orgId !== oc.orgId) {
      throw new ConvexError("NOT_FOUND: beneficiary does not belong to this organization");
    }
    const gate = await approvalGate(ctx, {
      orgId: oc.orgId,
      beneficiary,
      amountMinor: args.amountMinor,
      narration: args.narration,
      simulate: args.simulate,
      requestedBy: `user:${oc.userId}`,
      requestedByUserId: oc.userId,
    });
    if (gate) return { payoutId: "", status: "PENDING_APPROVAL", approvalId: gate };
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

/**
 * Two-person approval gate. Returns an approval request id when the payout
 * must wait for a second approver, or null to proceed now.
 */
export async function approvalGate(
  ctx: ActionCtx,
  a: {
    orgId: Id<"organizations">;
    beneficiary: Doc<"beneficiaries">;
    amountMinor: number;
    narration?: string;
    simulate?: string;
    requestedBy: string;
    requestedByUserId?: Id<"users">;
    requestedByLabel?: string;
    idempotencyKey?: string;
    /** Paying a marketplace recipient from its own balance. */
    recipient?: { _id: Id<"recipients">; recipientId: string };
  },
): Promise<string | null> {
  const policy: ApprovalPolicy = await ctx.runQuery(internal.approvals.orgPolicyInternal, { orgId: a.orgId });
  if (policy.payouts === "off") return null;
  const usd: number | null = await ctx.runQuery(internal.fxrates.usdEquivalentInternal, { amountMinor: a.amountMinor, currency: a.beneficiary.currency });
  if (!payoutNeedsApproval(policy, usd)) return null;
  if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) throw new ConvexError("VALIDATION_ERROR: amount must be a positive integer of minor units");
  const r: { approvalId: Id<"approvalRequests"> } = await ctx.runMutation(internal.approvals.createRequestInternal, {
    orgId: a.orgId,
    kind: "payout",
    summary: `Pay ${formatMoney(a.amountMinor, a.beneficiary.currency)}${a.recipient ? ` from recipient ${a.recipient.recipientId}'s balance` : ""} to ${a.beneficiary.name} (${a.beneficiary.bankName} ${a.beneficiary.accountMasked})${a.narration ? `: ${a.narration}` : ""}`,
    amountMinor: a.amountMinor,
    currency: a.beneficiary.currency,
    payload: { beneficiaryId: a.beneficiary._id, amountMinor: a.amountMinor, narration: a.narration, simulate: a.simulate, recipientId: a.recipient?._id },
    requestedBy: a.requestedBy,
    requestedByUserId: a.requestedByUserId,
    requestedByLabel: a.requestedByLabel,
    idempotencyKey: a.idempotencyKey,
  });
  return r.approvalId;
}

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
export const payoutContextInternal = internalQuery({
  args: { orgId: v.id("organizations"), beneficiaryId: v.id("beneficiaries") },
  handler: async (ctx, a) => {
    const org = await ctx.db.get(a.orgId);
    const b = await ctx.db.get(a.beneficiaryId);
    if (!org || !b || b.orgId !== a.orgId) return null;
    return { environment: (org.environment ?? "sandbox") as "sandbox" | "production", orgStatus: org.status ?? "active", beneficiary: b };
  },
});

/** Payout-capable connections for this org/environment/currency, best first. */
async function payoutChain(ctx: ActionCtx, orgId: Id<"organizations">, environment: "sandbox" | "production", currency: string) {
  if (environment === "sandbox") return [{ providerId: "sandbox", connectionId: platformConnectionId("sandbox", "sandbox") }];
  const rc: RoutingContext = await ctx.runQuery(internal.connections.routingContextInternal, { orgId, environment });
  return rc.candidates
    .filter((c) => {
      const d = getAdapter(c.providerId)?.descriptor;
      const circuit = rc.circuits[c.connectionId];
      return c.enabled && !!d?.operations.payouts && (d.payoutCurrencies ?? []).includes(currency) && !SANDBOX_PROVIDER_IDS.has(c.providerId) && (!circuit || circuit.state === "closed");
    })
    .sort((x, y) => y.priority - x.priority)
    .slice(0, 2)
    .map((c) => ({ providerId: c.providerId, connectionId: c.connectionId }));
}

const railReference = (payoutId: string) => `USOPGRID${payoutId.replace(/[^a-zA-Z0-9]/g, "")}`.slice(0, 64);

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
    /** Debit this marketplace recipient's balance instead of the merchant's. */
    recipientId: v.optional(v.id("recipients")),
  },
  handler: async (ctx, args): Promise<{
    kind: "done" | "error";
    payoutId?: string;
    status?: string;
    message?: string;
  }> => {
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
      return { kind: "error", message: "VALIDATION_ERROR: amount must be a positive integer of minor units" };
    }
    const pc = await ctx.runQuery(internal.payouts.payoutContextInternal, { orgId: args.orgId, beneficiaryId: args.beneficiaryId });
    if (!pc) return { kind: "error", message: "NOT_FOUND: beneficiary" };
    if (pc.orgStatus !== "active") return { kind: "error", message: `FORBIDDEN: organization is ${pc.orgStatus}; payouts are disabled` };
    const b = pc.beneficiary;

    const run = async (): Promise<{ statusCode: number; body: { payoutId: string; status: string } }> => {
      // Decide where the money will go BEFORE reserving funds.
      const chain = await payoutChain(ctx, args.orgId, pc.environment, b.currency);
      if (chain.length === 0) {
        throw new Error(`VALIDATION_ERROR: no payout provider is connected for ${b.currency} in the ${pc.environment === "production" ? "live" : "sandbox"} environment. Connect Paystack or Flutterwave under Providers.`);
      }
      let accountNumber = "";
      if (pc.environment === "production") {
        if (!b.sealedAccount || !keyringConfigured()) throw new Error("VALIDATION_ERROR: this beneficiary was saved before secure account storage. Add it again to pay it out.");
        accountNumber = await openSealed(b.sealedAccount, `beneficiary:${args.orgId}:${b.accountHash}`);
      }

      const created = await ctx.runMutation(internal.payouts.createPayoutRecordInternal, {
        orgId: args.orgId,
        beneficiaryId: args.beneficiaryId,
        amountMinor: args.amountMinor,
        narration: args.narration,
        actor: args.actor,
        recipientId: args.recipientId,
      });
      if (created.kind === "error") throw new Error(created.message ?? "Payout failed");
      const { payoutId } = created;
      const reference = railReference(payoutId);

      let last: { providerId: string; connectionId: string; providerReference?: string; failure?: FailureInfo } | null = null;
      for (let i = 0; i < chain.length; i++) {
        const step = chain[i];
        const res = await resolveConnection(step.connectionId, pc.environment, (k) => ctx.runQuery(internal.connections.connectionByKeyInternal, { connectionKey: k }));
        if ("error" in res || !res.adapter.payout) {
          last = { ...step, failure: "error" in res ? res.error : mkFailure("unsupported", "payout_unsupported", "Provider cannot pay out.", { safeToFailover: true }) };
          continue;
        }
        await ctx.runMutation(internal.payouts.markProcessingInternal, { payoutId, provider: step.providerId, connectionId: step.connectionId, railReference: reference });
        let r: PayoutResult;
        try {
          r = await res.adapter.payout(res.ctx, {
            payoutId,
            reference,
            amountMinor: args.amountMinor,
            currency: b.currency,
            narration: args.narration,
            beneficiary: { name: b.name, accountNumber, bankCode: b.bankCode, bankName: b.bankName, country: b.country, type: b.accountType ?? "bank_account" },
            metadata: pc.environment === "sandbox" && args.simulate ? { simulate: args.simulate } : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          r = /missing credential/i.test(msg)
            ? { status: "failed", failure: mkFailure("configuration_error", "provider_misconfigured", msg, { safeToFailover: true }) }
            : { status: "unknown", failure: mkFailure("temporary_provider_failure", "adapter_exception", msg, { retryable: true }) };
        }
        if (r.status === "successful" || r.status === "failed") {
          if (r.status === "failed" && r.failure?.safeToFailover && i < chain.length - 1) {
            last = { ...step, providerReference: r.providerReference, failure: r.failure };
            continue;
          }
          await ctx.runMutation(internal.payouts.completePayoutInternal, {
            payoutId,
            outcome: r.status,
            provider: step.providerId,
            providerReference: r.providerReference ?? reference,
            failure: r.failure ? { category: r.failure.category, code: r.failure.code, message: r.failure.message, retryable: r.failure.retryable } : undefined,
          });
        } else {
          // pending or unknown: money may be moving. Never re-send; recover by lookup.
          await ctx.runMutation(internal.payouts.markInFlightInternal, { payoutId, providerReference: r.providerReference, unknown: r.status === "unknown" });
        }
        const p = await ctx.runQuery(internal.payouts.payoutByPayoutIdInternal, { payoutId });
        return { statusCode: 201, body: { payoutId, status: p?.status ?? "PROCESSING" } };
      }
      // Every candidate refused before sending anything: release the funds.
      await ctx.runMutation(internal.payouts.completePayoutInternal, {
        payoutId,
        outcome: "failed",
        provider: last?.providerId ?? "none",
        providerReference: last?.providerReference ?? reference,
        failure: last?.failure ? { category: last.failure.category, code: last.failure.code, message: last.failure.message, retryable: last.failure.retryable } : { category: "unsupported", code: "no_payout_route", message: "No payout provider accepted this payout.", retryable: false },
      });
      return { statusCode: 201, body: { payoutId, status: "FAILED" } };
    };

    if (args.idempotencyKey) {
      const fp = await fingerprint({ beneficiaryId: args.beneficiaryId, amountMinor: args.amountMinor, kind: "payout", recipientId: args.recipientId ?? null });
      try {
        const r = await withIdempotency<{ payoutId: string; status: string }>(ctx, { orgId: args.orgId, key: `payout_${args.idempotencyKey}`, fp }, run);
        return { kind: "done", payoutId: r.body.payoutId, status: r.body.status };
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : "Payout failed" };
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

export const markProcessingInternal = internalMutation({
  args: { payoutId: v.string(), provider: v.string(), connectionId: v.string(), railReference: v.string() },
  handler: async (ctx, a) => {
    const p = await ctx.db.query("payouts").withIndex("by_payout_id", (q) => q.eq("payoutId", a.payoutId)).unique();
    if (!p || (p.status !== "PENDING" && p.status !== "PROCESSING")) return;
    await ctx.db.patch(p._id, { status: "PROCESSING", provider: a.provider, connectionId: a.connectionId, railReference: a.railReference, updatedAt: Date.now() });
  },
});

export const markInFlightInternal = internalMutation({
  args: { payoutId: v.string(), providerReference: v.optional(v.string()), unknown: v.boolean() },
  handler: async (ctx, a) => {
    const p = await ctx.db.query("payouts").withIndex("by_payout_id", (q) => q.eq("payoutId", a.payoutId)).unique();
    if (!p || p.status !== "PROCESSING") return;
    await ctx.db.patch(p._id, { providerReference: a.providerReference ?? p.providerReference, outcomeUnknown: a.unknown, updatedAt: Date.now() });
  },
});

export const payoutByRailReferenceInternal = internalQuery({
  args: { railReference: v.string() },
  handler: async (ctx, a) => ctx.db.query("payouts").withIndex("by_rail_reference", (q) => q.eq("railReference", a.railReference)).unique(),
});

export const inFlightPayoutsInternal = internalQuery({
  args: { before: v.number() },
  handler: async (ctx, a) =>
    ctx.db
      .query("payouts")
      .withIndex("by_status_updated", (q) => q.eq("status", "PROCESSING").lt("updatedAt", a.before))
      .take(25),
});

export const touchRecoveryInternal = internalMutation({
  args: { payoutId: v.string(), escalate: v.boolean(), note: v.string() },
  handler: async (ctx, a) => {
    const p = await ctx.db.query("payouts").withIndex("by_payout_id", (q) => q.eq("payoutId", a.payoutId)).unique();
    if (!p) return;
    const checks = (p.recoveryChecks ?? 0) + 1;
    await ctx.db.patch(p._id, { recoveryChecks: checks, updatedAt: Date.now(), ...(a.escalate && !p.escalatedAt ? { escalatedAt: Date.now() } : {}) });
    if (a.escalate && !p.escalatedAt) {
      await ctx.db.insert("reconExceptions", {
        orgId: p.orgId,
        type: "unknown_outcome_expired",
        severity: "high",
        detail: `Payout ${p.payoutId} via ${p.provider ?? "?"} unconfirmed after ${checks} checks (${a.note}). Verify at the provider before releasing or re-sending funds.`,
        currency: p.currency,
        ledgerAmountMinor: p.amountMinor,
        provider: p.provider,
        providerReference: p.providerReference,
        status: "open",
        createdAt: Date.now(),
      });
      await notify(ctx, { orgId: p.orgId, kind: "recon_exception", severity: "critical", title: `Payout ${p.payoutId} needs manual confirmation`, body: a.note, link: "/dashboard/reconciliation" });
    }
  },
});

/** Cron: resolve in-flight payouts by asking the same provider (never re-sending). */
export const recoverPayouts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number }> => {
    const now = Date.now();
    const rows: Doc<"payouts">[] = await ctx.runQuery(internal.payouts.inFlightPayoutsInternal, { before: now - 60_000 });
    for (const p of rows) {
      const age = now - p.createdAt;
      const backoff = Math.min(3_600_000, 60_000 * 2 ** Math.min(p.recoveryChecks ?? 0, 6));
      if (now - p.updatedAt < backoff) continue;
      const result = await checkPayout(ctx, p);
      // A provider may not index a just-sent transfer immediately: "not found" is
      // only final once the payout is old enough that it can't still be landing.
      const tooEarly = result?.failure?.code === "not_found_at_provider" && age < 30 * 60_000;
      if (result && !tooEarly && (result.status === "successful" || result.status === "failed")) {
        await ctx.runMutation(internal.payouts.completePayoutInternal, {
          payoutId: p.payoutId,
          outcome: result.status,
          provider: p.provider ?? "unknown",
          providerReference: result.providerReference ?? p.providerReference ?? p.railReference ?? p.payoutId,
          failure: result.failure ? { category: result.failure.category, code: result.failure.code, message: result.failure.message, retryable: result.failure.retryable } : undefined,
        });
      } else {
        await ctx.runMutation(internal.payouts.touchRecoveryInternal, { payoutId: p.payoutId, escalate: age > 72 * 3_600_000, note: result?.failure?.message ?? "status unavailable" });
      }
    }
    return { checked: rows.length };
  },
});

async function checkPayout(ctx: ActionCtx, p: Doc<"payouts">): Promise<PayoutResult | null> {
  if (!p.provider || !p.connectionId || !p.railReference) return null;
  const org = await ctx.runQuery(internal.apiInternal.orgInfoInternal, { orgId: p.orgId });
  if (!org) return null;
  const env = p.connectionId.startsWith("platform:") ? (p.connectionId.endsWith(":sandbox") ? "sandbox" : "production") : org.environment;
  const res = await resolveConnection(p.connectionId, env, (k) => ctx.runQuery(internal.connections.connectionByKeyInternal, { connectionKey: k }));
  if ("error" in res || !res.adapter.getPayoutStatus) return null;
  try {
    return await res.adapter.getPayoutStatus(res.ctx, { reference: p.railReference, providerReference: p.providerReference, currency: p.currency });
  } catch {
    return null;
  }
}

/** Provider webhook for a payout: re-confirm with the provider, then apply. */
export const applyPayoutEventInternal = internalAction({
  args: { railReference: v.string(), reported: v.string(), connectionKey: v.string() },
  handler: async (ctx, a): Promise<string> => {
    const p: Doc<"payouts"> | null = await ctx.runQuery(internal.payouts.payoutByRailReferenceInternal, { railReference: a.railReference });
    if (!p) return "unmatched";
    if (p.connectionId && p.connectionId !== a.connectionKey) return "rejected";
    if (a.reported === "payout_reversed") {
      if (p.status !== "SUCCESSFUL") return "stale";
      const check = await checkPayout(ctx, p);
      if (!check || (check.status !== "failed" && check.providerStatus?.toLowerCase() !== "reversed")) return "awaiting_confirmation";
      await ctx.runMutation(internal.payouts.completePayoutInternal, { payoutId: p.payoutId, outcome: "reversed", provider: p.provider ?? "unknown", providerReference: p.providerReference ?? a.railReference });
      return "applied";
    }
    if (p.status !== "PROCESSING") return "noop";
    // Webhook bodies are only as trustworthy as their signature scheme; confirm by lookup.
    const confirmed = await checkPayout(ctx, p);
    const status = confirmed?.status;
    if (status !== "successful" && status !== "failed") return "awaiting_confirmation";
    await ctx.runMutation(internal.payouts.completePayoutInternal, {
      payoutId: p.payoutId,
      outcome: status,
      provider: p.provider ?? "unknown",
      providerReference: confirmed?.providerReference ?? p.providerReference ?? a.railReference,
      failure: confirmed?.failure ? { category: confirmed.failure.category, code: confirmed.failure.code, message: confirmed.failure.message, retryable: confirmed.failure.retryable } : undefined,
    });
    return "applied";
  },
});

export const createPayoutRecordInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    beneficiaryId: v.id("beneficiaries"),
    amountMinor: v.number(),
    narration: v.optional(v.string()),
    actor: v.optional(v.string()),
    recipientId: v.optional(v.id("recipients")),
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

    let recipient: Doc<"recipients"> | null = null;
    if (args.recipientId) {
      recipient = await ctx.db.get(args.recipientId);
      if (!recipient || recipient.orgId !== args.orgId) return { kind: "error", message: "NOT_FOUND: recipient" };
      if (recipient.beneficiaryId !== args.beneficiaryId) return { kind: "error", message: "VALIDATION_ERROR: a recipient can only be paid to its own payout account" };
      if (recipient.currency !== currency) return { kind: "error", message: "VALIDATION_ERROR: recipient currency does not match its payout account" };
    }
    const source = sourceAccount(args.orgId, merchant, currency, recipient);

    // Balance check straight from the ledger.
    const accountCode = source.code;
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
      recipientId: recipient?._id,
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
          account: source,
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

/** The balance a payout is paid from: the merchant's, or a marketplace recipient's. */
function sourceAccount(orgId: Id<"organizations">, merchant: Doc<"merchants">, currency: string, recipient: Doc<"recipients"> | null): Posting["account"] {
  if (recipient) {
    return {
      orgId,
      currency,
      kind: ACCOUNT_KINDS.RECIPIENT_BALANCE,
      code: recipientAccountCode(recipient._id, currency),
      name: `Recipient ${recipient.recipientId} balance ${currency}`,
    };
  }
  return {
    orgId,
    merchantId: merchant._id,
    currency,
    kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
    code: merchantAccountCode(merchant._id, currency),
    name: `${merchant.name} balance ${currency}`,
  };
}

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
    provider: v.optional(v.string()),
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
    // Idempotent; the only transition out of a final state is SUCCESSFUL → REVERSED.
    if (p.status === "FAILED" || p.status === "REVERSED") return;
    if (p.status === "SUCCESSFUL" && args.outcome !== "reversed") return;
    if (args.outcome === "reversed" && p.status !== "SUCCESSFUL") return;
    const rail = args.provider ?? p.provider ?? "sandbox";

    const merchant = await ctx.db.get(p.merchantId);
    if (!merchant) throw new ConvexError("merchant not found");
    const recipient = p.recipientId ? await ctx.db.get(p.recipientId) : null;
    const source = sourceAccount(p.orgId, merchant, p.currency, recipient);

    const now = Date.now();
    await ctx.db.patch(p._id, {
      status: (args.outcome === "successful" ? "SUCCESSFUL" : args.outcome === "failed" ? "FAILED" : "REVERSED") as never,
      provider: rail,
      providerReference: args.providerReference,
      outcomeUnknown: false,
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
              code: providerClearingCode(`${rail}_payouts`, p.currency),
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
            account: source,
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
              code: providerClearingCode(`${rail}_payouts`, p.currency),
              name: `Payout rail clearing ${p.currency}`,
            },
            direction: "debit",
            amountMinor: p.amountMinor,
            description: `Payout ${p.payoutId} reversed`,
          },
          {
            account: source,
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
