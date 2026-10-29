// USOPGRID settlement + reconciliation engines.
//
// PAYMENT SUCCESS ≠ SETTLEMENT CONFIRMED. Money becomes payable when a
// settlement batch moves it from merchant_balance to settlement_payable; the
// recon engine ties ledger ↔ bank records together.
//
// v1 settlement model (deterministic, ledger-driven):
//   - Batches close the merchant's current available balance (refund-aware).
//   - Batch totals come from ledger postings (merchant balance movement),
//     never from denormalized transaction fields.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import { postDoubleEntry, settlementPayableCode, merchantAccountCode, ACCOUNT_KINDS } from "./lib/ledger";

// ---------------------------------------------------------------------------
// Build a settlement batch for a merchant + currency, closing the merchant's
// CURRENT available ledger balance. Idempotent: one open batch at a time per
// merchant+currency; refunds already posted reduce the settleable balance.
// ---------------------------------------------------------------------------
export const buildBatchInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    merchantId: v.id("merchants"),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    const merchant = await ctx.db.get(args.merchantId);
    if (!merchant) throw new ConvexError("merchant not found");

    const now = Date.now();
    const code = merchantAccountCode(args.merchantId, args.currency);
    const account = await ctx.db
      .query("ledgerAccounts")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();

    // Settleable balance = the merchant balance account itself, from entries.
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
    if (balanceMinor <= 0) {
      return { created: false as const, reason: "no settleable balance — successful payments land here after fees and refunds" };
    }

    // One open batch at a time per merchant+currency.
    const openBatch = await ctx.db
      .query("settlementBatches")
      .withIndex("by_merchant_created", (q) => q.eq("merchantId", args.merchantId))
      .collect();
    if (openBatch.some((b) => b.currency === args.currency && (b.status === "EXPECTED" || b.status === "PROCESSING" || b.status === "PARTIALLY_SETTLED"))) {
      return { created: false as const, reason: "a settlement batch is already open for this merchant and currency" };
    }

    const reserveMinor = Math.round((balanceMinor * (merchant.reserveBps ?? 0)) / 10_000);
    const payable = balanceMinor - reserveMinor;
    const reference = `stl_${now.toString(36)}_${args.merchantId.slice(-6)}`;

    const batchId = await ctx.db.insert("settlementBatches", {
      orgId: args.orgId,
      merchantId: args.merchantId,
      currency: args.currency,
      status: "PROCESSING",
      grossMinor: balanceMinor,
      feeMinor: 0, // fees are deducted per transaction at payment time
      reserveMinor,
      netMinor: payable,
      transactionCount: 0,
      reference,
      createdAt: now,
    });

    // Ledger: clear the merchant balance into settlement payable (+ reserve).
    // Debit merchant_balance balance; credit reserve (if any) + settlement_payable.
    const postings: Parameters<typeof postDoubleEntry>[1]["postings"] = [
      {
        account: {
          orgId: args.orgId,
          merchantId: args.merchantId,
          currency: args.currency,
          kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
          code,
          name: `merchant balance ${args.currency}`,
        },
        direction: "debit",
        amountMinor: balanceMinor,
        description: `Settlement batch ${reference}`,
      },
    ];
    if (reserveMinor > 0) {
      postings.push({
        account: {
          orgId: args.orgId,
          merchantId: args.merchantId,
          currency: args.currency,
          kind: ACCOUNT_KINDS.RESERVE,
          code: `rsv_${args.merchantId}_${args.currency}`,
          name: `reserve ${args.currency}`,
        },
        direction: "credit",
        amountMinor: reserveMinor,
        description: `Reserve held for batch ${reference}`,
      });
    }
    if (payable > 0) {
      postings.push({
        account: {
          orgId: args.orgId,
          merchantId: args.merchantId,
          currency: args.currency,
          kind: ACCOUNT_KINDS.SETTLEMENT_PAYABLE,
          code: settlementPayableCode(args.merchantId, args.currency),
          name: `settlement payable ${args.currency}`,
        },
        direction: "credit",
        amountMinor: payable,
        description: `Settlement batch ${reference}`,
      });
    }
    await postDoubleEntry(ctx, {
      orgId: args.orgId,
      ledgerRef: `STL-${reference}`,
      settlementBatchId: batchId,
      postings,
    });

    // Tag currently-unsettled successful transactions for dashboard linkage.
    const unsettled = await ctx.db
      .query("transactions")
      .withIndex("by_org_status_created", (q) =>
        q.eq("orgId", args.orgId).eq("status", "SUCCESSFUL"))
      .collect();
    let tagged = 0;
    for (const t of unsettled) {
      if (t.merchantId === args.merchantId && t.currency === args.currency && t.settlementBatchId === undefined) {
        await ctx.db.patch(t._id, { settlementBatchId: batchId });
        tagged += 1;
      }
    }
    await ctx.db.patch(batchId, { transactionCount: tagged });

    return { created: true as const, batchId, reference };
  },
});

// Mark a batch settled and record the corresponding bank credit (simulated
// bank feed adapter — replaced by a real statement feed later).
export const settleBatchInternal = internalMutation({
  args: { batchId: v.id("settlementBatches") },
  handler: async (ctx, args) => {
    const batch = await ctx.db.get(args.batchId);
    if (!batch) throw new ConvexError("batch not found");
    if (batch.status === "SETTLED") return batch;

    await ctx.db.patch(args.batchId, { status: "SETTLED", settledAt: Date.now() });

    const bankRef = `bnk_${batch.reference.slice(-10)}_${Math.floor(Math.random() * 1e6)
      .toString()
      .padStart(6, "0")}`;
    await ctx.db.insert("bankRecords", {
      orgId: batch.orgId,
      merchantId: batch.merchantId,
      batchReference: batch.reference,
      bankReference: bankRef,
      amountMinor: batch.netMinor,
      currency: batch.currency,
      direction: "credit",
      valueDate: Date.now(),
      source: "simulated_bank_feed",
      status: "matched",
      createdAt: Date.now(),
    });

    return await ctx.db.get(args.batchId);
  },
});

// ---------------------------------------------------------------------------
// Reconciliation engine: ledger settlements vs bank records.
// Detects: missing bank credit, amount mismatch, unexplained bank entries.
// ---------------------------------------------------------------------------
export const reconcileInternal = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const batches = await ctx.db
      .query("settlementBatches")
      .withIndex("by_org_created", (q) => q.eq("orgId", args.orgId))
      .collect();

    const bankRecords = await ctx.db
      .query("bankRecords")
      .withIndex("by_org_created", (q) => q.eq("orgId", args.orgId))
      .collect();

    const byBatchRef = new Map(bankRecords.map((r) => [r.batchReference, r]));
    const findings: { type: string; severity: string; detail: string }[] = [];
    let checked = 0;
    let matched = 0;

    for (const batch of batches) {
      checked += 1;
      const record = byBatchRef.get(batch.reference);
      if (!record) {
        if (batch.status === "SETTLED") {
          findings.push({
            type: "missing_settlement",
            severity: "high",
            detail: `Settled batch ${batch.reference} has no matching bank credit.`,
          });
        }
        continue;
      }
      matched += 1;
      if (record.amountMinor !== batch.netMinor) {
        findings.push({
          type: "amount_mismatch",
          severity: "high",
          detail: `Batch ${batch.reference}: ledger net ${batch.netMinor} vs bank ${record.amountMinor}.`,
        });
      }
    }

    const batchRefs = new Set(batches.map((b) => b.reference));
    for (const record of bankRecords) {
      if (!batchRefs.has(record.batchReference)) {
        findings.push({
          type: "unexplained_bank_entry",
          severity: "medium",
          detail: `Bank credit ${record.bankReference} does not match any settlement batch.`,
        });
      }
    }

    // Persist new exceptions (dedupe by batchReference + type, open only).
    const open = await ctx.db
      .query("reconExceptions")
      .withIndex("by_org_status_created", (q) => q.eq("orgId", args.orgId).eq("status", "open"))
      .collect();
    const openKeys = new Set(open.map((e) => `${e.type}:${e.batchReference ?? "-"}`));

    let created = 0;
    for (const f of findings) {
      const key = `${f.type}:${"-"}${f.detail.slice(0, 24)}`;
      if (openKeys.has(key)) continue;
      await ctx.db.insert("reconExceptions", {
        orgId: args.orgId,
        type: f.type as never,
        severity: f.severity as never,
        detail: f.detail,
        status: "open",
        createdAt: Date.now(),
      });
      created += 1;
    }

    return { checked, matched, findings: findings.length, exceptionsCreated: created };
  },
});
