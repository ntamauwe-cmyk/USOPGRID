// USOPGRID double-entry ledger — the financial source of truth.
//
// Invariants:
//  1. Every posting group (ledgerRef) is balanced: Σdebits = Σcredits per currency.
//  2. Entries are immutable. Corrections happen through reversals/adjustments.
//  3. Every entry carries org, account, amount, currency, ledgerRef, timestamp.
//
// Account kinds (v1): merchant_balance, provider_clearing, platform_fees,
// settlement_payable, reserve, suspense.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// ---------------------------------------------------------------------------
// Account codes — stable, derived, deterministic
// ---------------------------------------------------------------------------
export const ACCOUNT_KINDS = {
  MERCHANT_BALANCE: "merchant_balance",
  PROVIDER_CLEARING: "provider_clearing",
  PLATFORM_FEES: "platform_fees",
  SETTLEMENT_PAYABLE: "settlement_payable",
  RESERVE: "reserve",
  SUSPENSE: "suspense",
  RECIPIENT_BALANCE: "recipient_balance",
} as const;

export function merchantAccountCode(merchantId: string, currency: string) {
  return `merch_${merchantId}_${currency}`;
}
export function providerClearingCode(provider: string, currency: string) {
  return `prov_${provider}_${currency}`;
}
export function feesAccountCode(currency: string) {
  return `platform_fees_${currency}`;
}
export function settlementPayableCode(merchantId: string, currency: string) {
  return `settle_pay_${merchantId}_${currency}`;
}
export function recipientAccountCode(recipientDocId: string, currency: string) {
  return `rcpt_${recipientDocId}_${currency}`;
}
export function reserveAccountCode(merchantId: string, currency: string) {
  return `reserve_${merchantId}_${currency}`;
}

// ---------------------------------------------------------------------------
// getOrCreateAccount
// ---------------------------------------------------------------------------
export async function getOrCreateAccount(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    merchantId?: Id<"merchants">;
    currency: string;
    kind: string;
    code: string;
    name: string;
  },
): Promise<{ _id: Id<"ledgerAccounts">; code: string; name: string; kind: string; currency: string }> {
  const existing = await ctx.db
    .query("ledgerAccounts")
    .withIndex("by_code", (q) => q.eq("code", args.code))
    .unique();
  if (existing) return existing;

  const id = await ctx.db.insert("ledgerAccounts", {
    orgId: args.orgId,
    merchantId: args.merchantId,
    currency: args.currency,
    kind: args.kind,
    code: args.code,
    name: args.name,
    createdAt: Date.now(),
  });
  return {
    _id: id,
    code: args.code,
    name: args.name,
    kind: args.kind,
    currency: args.currency,
  };
}

/** Credit-normal balance of one account (credits minus debits), from the entries. */
export async function accountBalanceMinor(ctx: QueryCtx | MutationCtx, code: string): Promise<number> {
  const account = await ctx.db
    .query("ledgerAccounts")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
  if (!account) return 0;
  let balance = 0;
  for await (const e of ctx.db.query("ledgerEntries").withIndex("by_account_at", (q) => q.eq("accountId", account._id))) {
    balance += e.direction === "credit" ? e.amountMinor : -e.amountMinor;
  }
  return balance;
}

// ---------------------------------------------------------------------------
// postDoubleEntry — one balanced posting group, atomically
// ---------------------------------------------------------------------------
export interface Posting {
  account: {
    orgId: Id<"organizations">;
    merchantId?: Id<"merchants">;
    currency: string;
    kind: string;
    code: string;
    name: string;
  };
  direction: "debit" | "credit";
  amountMinor: number;
  description?: string;
}

export async function postDoubleEntry(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    ledgerRef: string;
    transactionId?: Id<"transactions">;
    settlementBatchId?: Id<"settlementBatches">;
    postings: Posting[];
  },
): Promise<{ ledgerRef: string; entryCount: number }> {
  const at = Date.now();

  if (args.postings.length < 2) {
    throw new Error("double-entry: a posting group needs at least 2 entries");
  }

  // Validate balance per currency BEFORE writing anything.
  const balances = new Map<string, number>();
  for (const p of args.postings) {
    if (p.amountMinor <= 0) throw new Error("double-entry: amounts must be positive");
    const cur = p.account.currency;
    const delta = p.direction === "debit" ? p.amountMinor : -p.amountMinor;
    balances.set(cur, (balances.get(cur) ?? 0) + delta);
  }
  for (const [cur, delta] of balances) {
    if (delta !== 0) {
      throw new Error(
        `double-entry: unbalanced posting group ${args.ledgerRef} in ${cur} (delta=${delta})`,
      );
    }
  }

  for (const p of args.postings) {
    const account = await getOrCreateAccount(ctx, p.account);
    await ctx.db.insert("ledgerEntries", {
      orgId: args.orgId,
      transactionId: args.transactionId,
      settlementBatchId: args.settlementBatchId,
      ledgerRef: args.ledgerRef,
      accountId: account._id,
      accountCode: account.code,
      direction: p.direction,
      amountMinor: p.amountMinor,
      currency: p.account.currency,
      description: p.description ?? "",
      at,
    });
  }

  return { ledgerRef: args.ledgerRef, entryCount: args.postings.length };
}

// Internal mutation wrapper so HTTP actions can post ledger groups.
export const postInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    ledgerRef: v.string(),
    transactionId: v.optional(v.id("transactions")),
    settlementBatchId: v.optional(v.id("settlementBatches")),
    postings: v.array(
      v.object({
        account: v.object({
          orgId: v.id("organizations"),
          merchantId: v.optional(v.id("merchants")),
          currency: v.string(),
          kind: v.string(),
          code: v.string(),
          name: v.string(),
        }),
        direction: v.union(v.literal("debit"), v.literal("credit")),
        amountMinor: v.number(),
        description: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) =>
    postDoubleEntry(ctx, {
      orgId: args.orgId,
      ledgerRef: args.ledgerRef,
      transactionId: args.transactionId,
      settlementBatchId: args.settlementBatchId,
      postings: args.postings,
    }),
});
