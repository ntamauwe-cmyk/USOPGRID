// Bulk payouts: upload a CSV, validate every row, then (after two-person
// approval when the organization requires it) pay each row through the normal
// payout engine. Each row has its own idempotency key, so retrying a batch
// can never pay anyone twice. Account numbers are sealed like any beneficiary.

import { v, ConvexError } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireOrgMember, requireOrgMemberAction } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { sha256Hex } from "./lib/crypto";
import { keyringConfigured, seal } from "./lib/keyring";
import { BULK_TEMPLATE, parseBulkPayoutCsv } from "./lib/bulk";
import { bulkNeedsApproval, type ApprovalPolicy } from "./lib/approvals";
import { formatMoney } from "../lib/money";

const CHUNK = 20;

export const template = query({ args: {}, handler: async () => BULK_TEMPLATE });

/** Validate without creating anything: lets the user fix a file before submitting. */
export const validate = action({
  args: { csv: v.string() },
  handler: async (ctx, a) => {
    await requireOrgMemberAction(ctx);
    if (a.csv.length > 2_000_000) throw new ConvexError("The file is larger than 2 MB.");
    const r = parseBulkPayoutCsv(a.csv);
    return { valid: r.errors.length === 0, rows: r.rows.length, errors: r.errors.slice(0, 50), totals: Object.entries(r.totalsByCurrency).map(([c, m]) => formatMoney(m, c)) };
  },
});

export const submit = action({
  args: { csv: v.string(), name: v.string() },
  handler: async (ctx, a): Promise<{ batchId: Id<"payoutBatches">; status: string; count: number }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    await ctx.runQuery(api.providers.assertSensitive, { permission: PERMISSIONS.PAYMENTS_CREATE });
    if (a.csv.length > 2_000_000) throw new ConvexError("The file is larger than 2 MB.");
    const parsed = parseBulkPayoutCsv(a.csv);
    if (parsed.errors.length) throw new ConvexError(`VALIDATION_ERROR: ${parsed.errors.length} row(s) need fixing; nothing was created. First: line ${parsed.errors[0].line}: ${parsed.errors[0].message}`);
    const environment = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const encryption = keyringConfigured();
    if (!encryption && environment === "production") throw new ConvexError("Payout accounts cannot be stored securely: the encryption key is not configured.");

    // Seal account numbers here (actions hold the key), then write in one mutation.
    const items = [];
    for (const r of parsed.rows) {
      const accountHash = await sha256Hex(`${r.accountNumber}:${r.bankCode ?? r.bankName}`);
      items.push({
        line: r.line,
        name: r.name,
        bankName: r.bankName,
        bankCode: r.bankCode,
        accountHash,
        accountMasked: `••••${r.accountNumber.slice(-4)}`,
        sealedAccount: encryption ? await seal(r.accountNumber, `beneficiary:${oc.orgId}:${accountHash}`) : undefined,
        currency: r.currency,
        country: r.country,
        accountType: r.accountType,
        amountMinor: r.amountMinor,
        narration: r.narration,
        reference: r.reference,
      });
    }
    const created: { batchId: Id<"payoutBatches">; needsApproval: boolean } = await ctx.runMutation(internal.bulkPayouts.createBatchInternal, {
      orgId: oc.orgId,
      userId: oc.userId,
      name: a.name.trim().slice(0, 80) || `Bulk payout ${new Date().toISOString().slice(0, 10)}`,
      totals: parsed.totalsByCurrency,
      items,
    });
    if (!created.needsApproval) {
      await ctx.runAction(internal.bulkPayouts.executeBatchInternal, { batchId: created.batchId, actor: `user:${oc.userId}` });
      return { batchId: created.batchId, status: "processing", count: items.length };
    }
    return { batchId: created.batchId, status: "pending_approval", count: items.length };
  },
});

export const createBatchInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    name: v.string(),
    totals: v.any(),
    items: v.array(
      v.object({
        line: v.number(),
        name: v.string(),
        bankName: v.string(),
        bankCode: v.optional(v.string()),
        accountHash: v.string(),
        accountMasked: v.string(),
        sealedAccount: v.optional(v.string()),
        currency: v.string(),
        country: v.optional(v.string()),
        accountType: v.union(v.literal("bank_account"), v.literal("mobile_money")),
        amountMinor: v.number(),
        narration: v.optional(v.string()),
        reference: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, a): Promise<{ batchId: Id<"payoutBatches">; needsApproval: boolean }> => {
    const org = await ctx.db.get(a.orgId);
    if (!org) throw new ConvexError("NOT_FOUND: organization");
    const user = await ctx.db.get(a.userId);
    const label = user?.name || user?.email || "Team member";
    const needsApproval = bulkNeedsApproval(org.approvals as ApprovalPolicy | undefined);
    const now = Date.now();
    const batchId = await ctx.db.insert("payoutBatches", {
      orgId: a.orgId,
      name: a.name,
      status: needsApproval ? "pending_approval" : "processing",
      count: a.items.length,
      totals: a.totals,
      createdByUserId: a.userId,
      createdByLabel: label,
      createdAt: now,
      updatedAt: now,
    });
    for (const it of a.items) {
      // Reuse an existing beneficiary for the same account, else create it.
      let b = await ctx.db
        .query("beneficiaries")
        .withIndex("by_org_hash", (q) => q.eq("orgId", a.orgId).eq("accountHash", it.accountHash))
        .first();
      if (!b) {
        const id = await ctx.db.insert("beneficiaries", {
          orgId: a.orgId,
          name: it.name,
          bankName: it.bankName,
          bankCode: it.bankCode,
          accountMasked: it.accountMasked,
          accountHash: it.accountHash,
          sealedAccount: it.sealedAccount,
          accountType: it.accountType,
          country: it.country,
          currency: it.currency,
          status: "verified",
          verifiedAt: now,
          createdByUserId: a.userId,
          createdAt: now,
        });
        b = (await ctx.db.get(id))!;
      }
      if (b.currency !== it.currency) throw new ConvexError(`VALIDATION_ERROR: line ${it.line}: this account is saved for ${b.currency}, not ${it.currency}`);
      await ctx.db.insert("payoutBatchItems", {
        batchId,
        orgId: a.orgId,
        line: it.line,
        beneficiaryId: b._id,
        beneficiaryName: b.name,
        accountMasked: b.accountMasked,
        amountMinor: it.amountMinor,
        currency: it.currency,
        narration: it.narration,
        reference: it.reference,
        status: "queued",
      });
    }
    const totals = Object.entries(a.totals as Record<string, number>).map(([c, m]) => formatMoney(m, c)).join(" + ");
    await logAudit(ctx, { orgId: a.orgId, actor: a.userId, action: "payout_batch.created", resource: "payoutBatch", resourceId: batchId, after: { name: a.name, count: a.items.length, totals } });
    if (needsApproval) {
      const approvalId = await ctx.db.insert("approvalRequests", {
        orgId: a.orgId,
        kind: "bulk_payout",
        status: "pending",
        summary: `Bulk payout “${a.name}”: ${a.items.length} payouts, ${totals}`,
        payload: { batchId },
        requestedBy: `user:${a.userId}`,
        requestedByUserId: a.userId,
        requestedByLabel: label,
        requestedAt: now,
        expiresAt: now + 72 * 3_600_000,
      });
      await ctx.db.patch(batchId, { approvalId });
      await ctx.db.insert("notifications", {
        orgId: a.orgId,
        kind: "approval_requested",
        severity: "warning",
        title: "A bulk payout is waiting for approval",
        body: `${a.name}: ${a.items.length} payouts, ${totals}`,
        link: "/dashboard/approvals",
        readBy: [],
        createdAt: now,
      });
    }
    return { batchId, needsApproval };
  },
});

export const markBatchInternal = internalMutation({
  args: { batchId: v.id("payoutBatches"), status: v.union(v.literal("processing"), v.literal("completed"), v.literal("cancelled")) },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.batchId, { status: a.status, updatedAt: Date.now() });
    if (a.status === "cancelled") {
      const queued = await ctx.db.query("payoutBatchItems").withIndex("by_batch_status", (q) => q.eq("batchId", a.batchId).eq("status", "queued")).collect();
      for (const it of queued) await ctx.db.patch(it._id, { status: "cancelled" });
    }
  },
});

/** Start (or resume) paying a batch. Returns the number of rows queued. */
export const executeBatchInternal = internalAction({
  args: { batchId: v.id("payoutBatches"), actor: v.string() },
  handler: async (ctx, a): Promise<{ queued: number }> => {
    const queued: number = await ctx.runQuery(internal.bulkPayouts.queuedCountInternal, { batchId: a.batchId });
    await ctx.runMutation(internal.bulkPayouts.markBatchInternal, { batchId: a.batchId, status: "processing" });
    await ctx.scheduler.runAfter(0, internal.bulkPayouts.processChunkInternal, { batchId: a.batchId, actor: a.actor });
    return { queued };
  },
});

export const queuedCountInternal = internalQuery({
  args: { batchId: v.id("payoutBatches") },
  handler: async (ctx, a) => (await ctx.db.query("payoutBatchItems").withIndex("by_batch_status", (q) => q.eq("batchId", a.batchId).eq("status", "queued")).collect()).length,
});

export const nextChunkInternal = internalQuery({
  args: { batchId: v.id("payoutBatches") },
  handler: async (ctx, a) => {
    const batch = await ctx.db.get(a.batchId);
    if (!batch || batch.status !== "processing") return { batch: null, items: [] };
    const items = await ctx.db.query("payoutBatchItems").withIndex("by_batch_status", (q) => q.eq("batchId", a.batchId).eq("status", "queued")).take(CHUNK);
    return { batch, items };
  },
});

export const recordItemInternal = internalMutation({
  args: { itemId: v.id("payoutBatchItems"), ok: v.boolean(), payoutId: v.optional(v.string()), payoutStatus: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.itemId, { status: a.ok ? "submitted" : "refused", payoutId: a.payoutId, payoutStatus: a.payoutStatus, error: a.error });
  },
});

export const finishBatchInternal = internalMutation({
  args: { batchId: v.id("payoutBatches") },
  handler: async (ctx, a) => {
    const items = await ctx.db.query("payoutBatchItems").withIndex("by_batch_line", (q) => q.eq("batchId", a.batchId)).collect();
    const submitted = items.filter((i) => i.status === "submitted").length;
    const refused = items.filter((i) => i.status === "refused").length;
    const batch = await ctx.db.get(a.batchId);
    await ctx.db.patch(a.batchId, { status: "completed", submitted, refused, updatedAt: Date.now() });
    if (batch) {
      await ctx.db.insert("notifications", {
        orgId: batch.orgId,
        kind: "payout_batch_completed",
        severity: refused ? "warning" : "info",
        title: `Bulk payout “${batch.name}” processed`,
        body: `${submitted} submitted, ${refused} refused.`,
        link: "/dashboard/payouts",
        readBy: [],
        createdAt: Date.now(),
      });
    }
  },
});

export const processChunkInternal = internalAction({
  args: { batchId: v.id("payoutBatches"), actor: v.string() },
  handler: async (ctx, a) => {
    const { batch, items } = await ctx.runQuery(internal.bulkPayouts.nextChunkInternal, { batchId: a.batchId });
    if (!batch) return;
    if (items.length === 0) {
      await ctx.runMutation(internal.bulkPayouts.finishBatchInternal, { batchId: a.batchId });
      return;
    }
    for (const it of items) {
      const out = await ctx.runAction(internal.payouts.payoutInternal, {
        orgId: batch.orgId,
        beneficiaryId: it.beneficiaryId,
        amountMinor: it.amountMinor,
        narration: it.narration ?? it.reference,
        actor: a.actor,
        idempotencyKey: `batch_${a.batchId}_${it.line}`,
      });
      await ctx.runMutation(internal.bulkPayouts.recordItemInternal, {
        itemId: it._id,
        ok: out.kind === "done",
        payoutId: out.payoutId,
        payoutStatus: out.status,
        error: out.kind === "error" ? (out.message ?? "Payout failed").replace(/^[A-Z_]+: /, "") : undefined,
      });
    }
    await ctx.scheduler.runAfter(0, internal.bulkPayouts.processChunkInternal, a);
  },
});

export const listBatches = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const rows = await ctx.db.query("payoutBatches").withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId)).order("desc").take(20);
    return rows.map((b) => ({
      _id: b._id,
      name: b.name,
      status: b.status,
      count: b.count,
      totals: Object.entries(b.totals as Record<string, number>).map(([c, m]) => formatMoney(m, c)),
      createdByLabel: b.createdByLabel,
      createdAt: b.createdAt,
      submitted: b.submitted ?? null,
      refused: b.refused ?? null,
    }));
  },
});

export const batchItems = query({
  args: { batchId: v.id("payoutBatches") },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const b = await ctx.db.get(a.batchId);
    if (!b || b.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: batch");
    const items = await ctx.db.query("payoutBatchItems").withIndex("by_batch_line", (q) => q.eq("batchId", a.batchId)).take(1000);
    return items.map((i) => ({ line: i.line, name: i.beneficiaryName, account: i.accountMasked, amount: formatMoney(i.amountMinor, i.currency), reference: i.reference ?? null, status: i.status, payoutId: i.payoutId ?? null, payoutStatus: i.payoutStatus ?? null, error: i.error ?? null }));
  },
});
