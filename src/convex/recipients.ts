// USOPGRID marketplace recipients and split payments.
//
// A recipient is a seller or partner on the merchant's platform. Payments
// can name recipients in `splits`; when a payment succeeds each share moves
// from the merchant's net into the recipient's own ledger balance, refunds
// reverse shares in proportion, and the recipient is paid out from its
// balance to its own payout account (through the same payout engine, fees
// and two-person approval rules as every other payout).
//
// A recipient balance can go negative if a payment is refunded after the
// recipient was paid out; it is then owed back and new payouts wait until
// later shares cover it.

import { v, ConvexError } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember, requireOrgMemberAction, requireSensitive } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { accountBalanceMinor, recipientAccountCode } from "./lib/ledger";
import { computeFees } from "./lib/fees";
import { resolveShares, SplitError, type SplitInput } from "./lib/splits";
import { logAudit } from "./lib/audit";
import { randomToken } from "./lib/crypto";
import { approvalGate, payoutFee, prepareBeneficiary, type BeneficiaryInput } from "./payouts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RecipientView {
  id: string;
  _id: Id<"recipients">;
  name: string;
  email: string | null;
  currency: string;
  status: "active" | "disabled";
  balanceMinor: number;
  payoutAccount: { name: string; bank: string; account: string; country: string | null } | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

async function view(ctx: QueryCtx | MutationCtx, r: Doc<"recipients">): Promise<RecipientView> {
  const b = await ctx.db.get(r.beneficiaryId);
  return {
    id: r.recipientId,
    _id: r._id,
    name: r.name,
    email: r.email ?? null,
    currency: r.currency,
    status: r.status,
    balanceMinor: await accountBalanceMinor(ctx, recipientAccountCode(r._id, r.currency)),
    payoutAccount: b ? { name: b.name, bank: b.bankName, account: b.accountMasked, country: b.country ?? null } : null,
    metadata: (r.metadata as Record<string, unknown> | undefined) ?? null,
    createdAt: r.createdAt,
  };
}

/** Largest payout amount whose amount + payout fee fits the balance. */
export function maxPayoutFor(balanceMinor: number): number {
  if (balanceMinor <= 0) return 0;
  let amount = Math.floor((balanceMinor * 10_000) / 10_020);
  while (amount > 0 && amount + payoutFee(amount) > balanceMinor) amount--;
  while (amount + 1 + payoutFee(amount + 1) <= balanceMinor) amount++;
  return amount;
}

// ---------------------------------------------------------------------------
// Payment-time resolution
// ---------------------------------------------------------------------------
export const resolveSplitsInternal = internalQuery({
  args: {
    orgId: v.id("organizations"),
    merchantId: v.id("merchants"),
    amountMinor: v.number(),
    currency: v.string(),
    splits: v.array(v.object({ recipient: v.string(), amount: v.optional(v.number()), percent: v.optional(v.number()) })),
  },
  handler: async (
    ctx,
    a,
  ): Promise<
    | { ok: true; splits: { recipientId: Id<"recipients">; recipientRef: string; amountMinor: number; percentBps?: number }[] }
    | { ok: false; message: string }
  > => {
    const merchant = await ctx.db.get(a.merchantId);
    if (!merchant || merchant.orgId !== a.orgId) return { ok: false, message: "Merchant not found." };
    const { netMinor } = computeFees(merchant, a.amountMinor, a.currency);
    let shares;
    try {
      shares = resolveShares(a.splits as SplitInput[], a.amountMinor, netMinor);
    } catch (err) {
      if (err instanceof SplitError) return { ok: false, message: err.message };
      throw err;
    }
    const out = [];
    for (const sh of shares) {
      const r = await ctx.db
        .query("recipients")
        .withIndex("by_recipient_id", (q) => q.eq("recipientId", sh.recipient))
        .unique();
      if (!r || r.orgId !== a.orgId) return { ok: false, message: `Recipient ${sh.recipient} was not found.` };
      if (r.status !== "active") return { ok: false, message: `Recipient ${sh.recipient} is disabled.` };
      if (r.currency !== a.currency) return { ok: false, message: `Recipient ${sh.recipient} is paid in ${r.currency}; this payment is in ${a.currency}.` };
      out.push({ recipientId: r._id, recipientRef: r.recipientId, amountMinor: sh.amountMinor, percentBps: sh.percentBps });
    }
    return { ok: true, splits: out };
  },
});

// ---------------------------------------------------------------------------
// Internal operations shared by the dashboard and the API
// ---------------------------------------------------------------------------
export const createInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    email: v.optional(v.string()),
    beneficiaryId: v.id("beneficiaries"),
    metadata: v.optional(v.any()),
    actor: v.string(),
  },
  handler: async (ctx, a): Promise<RecipientView> => {
    const name = a.name.trim();
    if (!name || name.length > 120) throw new ConvexError("VALIDATION_ERROR: name is required (at most 120 characters)");
    const email = a.email?.trim().toLowerCase() || undefined;
    if (email && (email.length > 254 || !EMAIL.test(email))) throw new ConvexError("VALIDATION_ERROR: email is not valid");
    const b = await ctx.db.get(a.beneficiaryId);
    if (!b || b.orgId !== a.orgId) throw new ConvexError("NOT_FOUND: payout account not found in this organization");
    if (b.status !== "verified") throw new ConvexError(`VALIDATION_ERROR: payout account is ${b.status}`);
    const taken = await ctx.db
      .query("recipients")
      .withIndex("by_org_beneficiary", (q) => q.eq("orgId", a.orgId).eq("beneficiaryId", a.beneficiaryId))
      .first();
    if (taken) throw new ConvexError(`CONFLICT: this payout account already belongs to recipient ${taken.recipientId}`);
    const now = Date.now();
    const recipientId = `rcp_${now.toString(36)}${randomToken(10).toLowerCase().replace(/[^a-z0-9]/g, "0")}`;
    const id = await ctx.db.insert("recipients", {
      orgId: a.orgId,
      recipientId,
      name,
      email,
      beneficiaryId: a.beneficiaryId,
      currency: b.currency,
      status: "active",
      metadata: a.metadata,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, { orgId: a.orgId, actor: a.actor, action: "recipient.created", resource: "recipient", resourceId: recipientId, after: { name, currency: b.currency, account: b.accountMasked } });
    return view(ctx, (await ctx.db.get(id))!);
  },
});

export const listInternal = internalQuery({
  args: { orgId: v.id("organizations"), limit: v.optional(v.number()) },
  handler: async (ctx, a): Promise<RecipientView[]> => {
    const rows = await ctx.db
      .query("recipients")
      .withIndex("by_org_created", (q) => q.eq("orgId", a.orgId))
      .order("desc")
      .take(Math.min(Math.max(a.limit ?? 100, 1), 200));
    return Promise.all(rows.map((r) => view(ctx, r)));
  },
});

export const getInternal = internalQuery({
  args: { orgId: v.id("organizations"), recipientId: v.string() },
  handler: async (ctx, a): Promise<RecipientView | null> => {
    const r = await ctx.db
      .query("recipients")
      .withIndex("by_recipient_id", (q) => q.eq("recipientId", a.recipientId))
      .unique();
    if (!r || r.orgId !== a.orgId) return null;
    return view(ctx, r);
  },
});

export const payoutContextInternal = internalQuery({
  args: { orgId: v.id("organizations"), recipientDocId: v.id("recipients") },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(a.recipientDocId);
    if (!r || r.orgId !== a.orgId) return null;
    const beneficiary = await ctx.db.get(r.beneficiaryId);
    if (!beneficiary) return null;
    return { recipient: r, beneficiary, balanceMinor: await accountBalanceMinor(ctx, recipientAccountCode(r._id, r.currency)) };
  },
});

async function setStatusImpl(ctx: MutationCtx, orgId: Id<"organizations">, recipientDocId: Id<"recipients">, status: "active" | "disabled", actor: string) {
  const r = await ctx.db.get(recipientDocId);
  if (!r || r.orgId !== orgId) throw new ConvexError("NOT_FOUND: recipient");
  if (r.status === status) return;
  await ctx.db.patch(r._id, { status, updatedAt: Date.now() });
  await logAudit(ctx, { orgId, actor, action: `recipient.${status === "active" ? "enabled" : "disabled"}`, resource: "recipient", resourceId: r.recipientId, before: { status: r.status }, after: { status } });
}

export const setStatusInternal = internalMutation({
  args: { orgId: v.id("organizations"), recipientDocId: v.id("recipients"), status: v.union(v.literal("active"), v.literal("disabled")), actor: v.string() },
  handler: async (ctx, a) => setStatusImpl(ctx, a.orgId, a.recipientDocId, a.status, a.actor),
});

export type RecipientPayoutResult =
  | { kind: "paid"; payoutId: string; status: string; amountMinor: number }
  | { kind: "pending_approval"; approvalId: string; amountMinor: number };

/**
 * Pay a recipient from its balance to its payout account. Amount defaults
 * to everything available after the payout fee. Goes through the same
 * two-person approval rule as any payout.
 */
export async function payRecipient(
  ctx: ActionCtx,
  a: {
    orgId: Id<"organizations">;
    recipientDocId: Id<"recipients">;
    amountMinor?: number;
    narration?: string;
    simulate?: string;
    requestedBy: string;
    requestedByUserId?: Id<"users">;
    requestedByLabel?: string;
    idempotencyKey?: string;
    actor: string;
  },
): Promise<RecipientPayoutResult> {
  const pc = await ctx.runQuery(internal.recipients.payoutContextInternal, { orgId: a.orgId, recipientDocId: a.recipientDocId });
  if (!pc) throw new ConvexError("NOT_FOUND: recipient");
  if (pc.recipient.status !== "active") throw new ConvexError("VALIDATION_ERROR: recipient is disabled");
  const available = maxPayoutFor(pc.balanceMinor);
  const amountMinor = a.amountMinor ?? available;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ConvexError(
      pc.balanceMinor < 0
        ? `VALIDATION_ERROR: recipient owes ${-pc.balanceMinor} from refunds; it is recovered from new shares before any payout`
        : "VALIDATION_ERROR: nothing available to pay out",
    );
  }
  if (amountMinor > available) {
    throw new ConvexError(`VALIDATION_ERROR: insufficient recipient balance — at most ${available} can be paid out after the payout fee`);
  }
  const recipient = { _id: pc.recipient._id, recipientId: pc.recipient.recipientId };
  const gate = await approvalGate(ctx, {
    orgId: a.orgId,
    beneficiary: pc.beneficiary,
    amountMinor,
    narration: a.narration,
    simulate: a.simulate,
    requestedBy: a.requestedBy,
    requestedByUserId: a.requestedByUserId,
    requestedByLabel: a.requestedByLabel,
    idempotencyKey: a.idempotencyKey,
    recipient,
  });
  if (gate) return { kind: "pending_approval", approvalId: gate, amountMinor };
  const out = await ctx.runAction(internal.payouts.payoutInternal, {
    orgId: a.orgId,
    beneficiaryId: pc.beneficiary._id,
    recipientId: pc.recipient._id,
    amountMinor,
    narration: a.narration,
    simulate: a.simulate,
    actor: a.actor,
    idempotencyKey: a.idempotencyKey,
  });
  if (out.kind === "error") throw new ConvexError(out.message ?? "Payout failed");
  return { kind: "paid", payoutId: out.payoutId!, status: out.status!, amountMinor };
}

// ---------------------------------------------------------------------------
// Dashboard surface
// ---------------------------------------------------------------------------
export const list = query({
  args: {},
  handler: async (ctx): Promise<RecipientView[]> => {
    const oc = await requireOrgMember(ctx);
    const rows = await ctx.db
      .query("recipients")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(200);
    return Promise.all(rows.map((r) => view(ctx, r)));
  },
});

export const create = action({
  args: {
    name: v.string(),
    email: v.optional(v.string()),
    /** Use a payout account already saved under Payouts… */
    beneficiaryId: v.optional(v.id("beneficiaries")),
    /** …or add a new one. */
    account: v.optional(
      v.object({
        holderName: v.string(),
        bankName: v.string(),
        bankCode: v.optional(v.string()),
        accountNumber: v.string(),
        currency: v.string(),
        country: v.optional(v.string()),
        accountType: v.optional(v.union(v.literal("bank_account"), v.literal("mobile_money"))),
      }),
    ),
  },
  handler: async (ctx, a): Promise<RecipientView> => {
    const oc = await requireOrgMemberAction(ctx);
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.PAYMENTS_CREATE });
    if (!!a.beneficiaryId === !!a.account) throw new ConvexError("VALIDATION_ERROR: choose a saved payout account or enter a new one");
    let beneficiaryId = a.beneficiaryId;
    if (a.account) {
      const environment = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
      const prepared = await prepareBeneficiary(oc.orgId, environment, { ...a.account, name: a.account.holderName } as BeneficiaryInput);
      beneficiaryId = (await ctx.runMutation(internal.payouts.insertBeneficiaryInternal, { ...prepared, userId: oc.userId }))._id;
    }
    return await ctx.runMutation(internal.recipients.createInternal, { orgId: oc.orgId, name: a.name, email: a.email, beneficiaryId: beneficiaryId!, actor: oc.userId });
  },
});

export const setStatus = mutation({
  args: { recipientId: v.id("recipients"), status: v.union(v.literal("active"), v.literal("disabled")) },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.PAYMENTS_CREATE);
    await setStatusImpl(ctx, oc.orgId, a.recipientId, a.status, oc.userId);
  },
});

export const payout = action({
  args: { recipientId: v.id("recipients"), amountMinor: v.optional(v.number()), narration: v.optional(v.string()), simulate: v.optional(v.string()) },
  handler: async (ctx, a): Promise<RecipientPayoutResult> => {
    const oc = await requireOrgMemberAction(ctx);
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.PAYMENTS_CREATE });
    return payRecipient(ctx, {
      orgId: oc.orgId,
      recipientDocId: a.recipientId,
      amountMinor: a.amountMinor,
      narration: a.narration?.trim().slice(0, 140) || undefined,
      simulate: a.simulate,
      requestedBy: `user:${oc.userId}`,
      requestedByUserId: oc.userId,
      actor: oc.userId,
    });
  },
});

/** Recent payments that carried shares for one recipient (dashboard drill-down). */
export const sharesFor = query({
  args: { recipientId: v.id("recipients") },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const r = await ctx.db.get(a.recipientId);
    if (!r || r.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: recipient");
    const account = await ctx.db
      .query("ledgerAccounts")
      .withIndex("by_code", (q) => q.eq("code", recipientAccountCode(r._id, r.currency)))
      .unique();
    if (!account) return [];
    const entries = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_account_at", (q) => q.eq("accountId", account._id))
      .order("desc")
      .take(50);
    return Promise.all(
      entries.map(async (e) => {
        const txn = e.transactionId ? await ctx.db.get(e.transactionId) : null;
        return {
          at: e.at,
          ledgerRef: e.ledgerRef,
          description: e.description,
          amountMinor: e.direction === "credit" ? e.amountMinor : -e.amountMinor,
          currency: e.currency,
          transactionId: txn?.transactionId ?? null,
        };
      }),
    );
  },
});
