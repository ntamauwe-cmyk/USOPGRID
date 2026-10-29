// Two-person approval (maker-checker) for payouts, bulk payouts and changes
// that would weaken the approval policy itself.
//
// Rules enforced here, server-side:
// - the approver is a different person from the requester;
// - the approver holds the permission for the action and has an enrolled
//   authenticator confirmed in the last 15 minutes;
// - a request is decided once (atomic claim), expires after 72 hours, and
//   executes with an idempotency key derived from its id, so a retried
//   execution can never move money twice;
// - every step is audited and the organization is notified.

import { v, ConvexError } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember, requirePermissionFor, requireStepUp, requireStrongStepUp } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { notify } from "./connections";
import { describePolicy, isLoosening, validatePolicy, type ApprovalPolicy } from "./lib/approvals";
import { formatMoney } from "../lib/money";

export const APPROVAL_TTL_MS = 72 * 3_600_000;

const policyV = v.object({
  payouts: v.union(v.literal("off"), v.literal("all"), v.literal("above")),
  payoutThresholdUsd: v.optional(v.number()),
});

async function userLabel(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<string> {
  const u = await ctx.db.get(userId);
  return u?.name || u?.email || "Team member";
}

function permissionFor(kind: Doc<"approvalRequests">["kind"]): string {
  return kind === "policy_change" ? PERMISSIONS.SECURITY_MANAGE : PERMISSIONS.PAYOUTS_APPROVE;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------
export const policy = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const p = (oc.org.approvals ?? { payouts: "off" }) as ApprovalPolicy;
    const pendingChange = await ctx.db
      .query("approvalRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", oc.orgId).eq("status", "pending"))
      .filter((q) => q.eq(q.field("kind"), "policy_change"))
      .first();
    return {
      policy: p,
      description: describePolicy(p),
      canEdit: oc.permissions.has(PERMISSIONS.SECURITY_MANAGE),
      pendingChangeId: pendingChange?._id ?? null,
    };
  },
});

/** Tightening applies at once; loosening an active policy needs a second approver. */
export const setPolicy = mutation({
  args: { policy: policyV },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.SECURITY_MANAGE);
    await requireStepUp(ctx, oc);
    const err = validatePolicy(a.policy);
    if (err) throw new ConvexError(err);
    const next: ApprovalPolicy = a.policy.payouts === "above" ? a.policy : { payouts: a.policy.payouts };
    const current = oc.org.approvals as ApprovalPolicy | undefined;
    if (isLoosening(current, next)) {
      const id = await ctx.db.insert("approvalRequests", {
        orgId: oc.orgId,
        kind: "policy_change",
        status: "pending",
        summary: `Change approval policy to: ${describePolicy(next)}`,
        payload: { policy: next },
        requestedBy: `user:${oc.userId}`,
        requestedByUserId: oc.userId,
        requestedByLabel: await userLabel(ctx, oc.userId),
        requestedAt: Date.now(),
        expiresAt: Date.now() + APPROVAL_TTL_MS,
      });
      await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "security.approval_policy_change_requested", resource: "approvalRequest", resourceId: id, before: current ?? { payouts: "off" }, after: next });
      await notify(ctx, { orgId: oc.orgId, kind: "approval_requested", severity: "warning", title: "Approval policy change needs a second approver", body: describePolicy(next), link: "/dashboard/approvals" });
      return { applied: false, approvalId: id };
    }
    await ctx.db.patch(oc.orgId, { approvals: next });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "security.approval_policy_updated", resource: "organization", resourceId: oc.orgId, before: current ?? { payouts: "off" }, after: next });
    return { applied: true, approvalId: null };
  },
});

// ---------------------------------------------------------------------------
// Creating requests (called by payouts and the API)
// ---------------------------------------------------------------------------
export const createRequestInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    kind: v.union(v.literal("payout"), v.literal("bulk_payout")),
    summary: v.string(),
    amountMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    payload: v.any(),
    requestedBy: v.string(),
    requestedByUserId: v.optional(v.id("users")),
    requestedByLabel: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ approvalId: Id<"approvalRequests">; existing: boolean }> => {
    const requestedByLabel = a.requestedByLabel ?? (a.requestedByUserId ? await userLabel(ctx, a.requestedByUserId) : a.requestedBy);
    if (a.idempotencyKey) {
      const dup = await ctx.db
        .query("approvalRequests")
        .withIndex("by_org_idem", (q) => q.eq("orgId", a.orgId).eq("idempotencyKey", a.idempotencyKey))
        .first();
      if (dup) return { approvalId: dup._id, existing: true };
    }
    const id = await ctx.db.insert("approvalRequests", { ...a, requestedByLabel, status: "pending", requestedAt: Date.now(), expiresAt: Date.now() + APPROVAL_TTL_MS });
    await logAudit(ctx, { orgId: a.orgId, actor: a.requestedBy, action: `approval.${a.kind}_requested`, resource: "approvalRequest", resourceId: id, after: { summary: a.summary } });
    await notify(ctx, { orgId: a.orgId, kind: "approval_requested", severity: "warning", title: "A payout is waiting for approval", body: a.summary, link: "/dashboard/approvals" });
    return { approvalId: id, existing: false };
  },
});

// ---------------------------------------------------------------------------
// Listing and deciding
// ---------------------------------------------------------------------------
export const list = query({
  args: { status: v.optional(v.union(v.literal("pending"), v.literal("all"))) },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const rows =
      a.status === "pending"
        ? await ctx.db.query("approvalRequests").withIndex("by_org_status", (q) => q.eq("orgId", oc.orgId).eq("status", "pending")).order("desc").take(100)
        : await ctx.db.query("approvalRequests").withIndex("by_org_requested", (q) => q.eq("orgId", oc.orgId)).order("desc").take(100);
    const now = Date.now();
    return rows.map((r) => ({
      _id: r._id,
      kind: r.kind,
      status: r.status === "pending" && r.expiresAt <= now ? ("expired" as const) : r.status,
      summary: r.summary,
      amount: r.amountMinor !== undefined && r.currency ? formatMoney(r.amountMinor, r.currency) : null,
      requestedByLabel: r.requestedByLabel,
      requestedAt: r.requestedAt,
      expiresAt: r.expiresAt,
      decidedByLabel: r.decidedByLabel ?? null,
      decidedAt: r.decidedAt ?? null,
      note: r.note ?? null,
      error: r.error ?? null,
      result: r.result ?? null,
      isMine: r.requestedByUserId === oc.userId,
      canDecide:
        r.status === "pending" &&
        r.expiresAt > now &&
        r.requestedByUserId !== oc.userId &&
        oc.permissions.has(permissionFor(r.kind)),
    }));
  },
});

export const pendingCount = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const rows = await ctx.db.query("approvalRequests").withIndex("by_org_status", (q) => q.eq("orgId", oc.orgId).eq("status", "pending")).take(100);
    return rows.filter((r) => r.expiresAt > Date.now()).length;
  },
});

/** Checks the caller may decide this request; used by the decide action. */
export const assertCanDecide = query({
  args: { approvalId: v.id("approvalRequests") },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const r = await ctx.db.get(a.approvalId);
    if (!r || r.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: approval request");
    if (!oc.permissions.has(permissionFor(r.kind))) throw new ConvexError(`FORBIDDEN: missing permission '${permissionFor(r.kind)}'`);
    if (r.requestedByUserId === oc.userId) throw new ConvexError("FORBIDDEN: you cannot approve your own request. A second team member must decide.");
    await requireStrongStepUp(ctx, oc);
    return { userId: oc.userId, label: await userLabel(ctx, oc.userId) };
  },
});

export const claimInternal = internalMutation({
  args: { approvalId: v.id("approvalRequests"), userId: v.id("users"), label: v.string(), decision: v.union(v.literal("approved"), v.literal("rejected")), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(a.approvalId);
    if (!r) throw new ConvexError("NOT_FOUND: approval request");
    if (r.status !== "pending") throw new ConvexError(`CONFLICT: this request is already ${r.status}`);
    if (r.expiresAt <= Date.now()) {
      await ctx.db.patch(r._id, { status: "expired" });
      throw new ConvexError("CONFLICT: this request expired; ask for a new one");
    }
    if (r.requestedByUserId === a.userId) throw new ConvexError("FORBIDDEN: you cannot approve your own request");
    await ctx.db.patch(r._id, { status: a.decision, decidedByUserId: a.userId, decidedByLabel: a.label, decidedAt: Date.now(), note: a.note });
    await logAudit(ctx, { orgId: r.orgId, actor: a.userId, action: `approval.${a.decision}`, resource: "approvalRequest", resourceId: r._id, after: { summary: r.summary, note: a.note } });
    if (a.decision === "rejected") {
      await notify(ctx, { orgId: r.orgId, kind: "approval_decided", severity: "info", title: "Request rejected", body: `${r.summary}${a.note ? ` (${a.note})` : ""}`, link: "/dashboard/approvals" });
    }
    return r;
  },
});

export const finishInternal = internalMutation({
  args: { approvalId: v.id("approvalRequests"), ok: v.boolean(), result: v.optional(v.any()), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(a.approvalId);
    if (!r) return;
    await ctx.db.patch(a.approvalId, { status: a.ok ? "executed" : "failed", result: a.result, error: a.error });
    if (r.kind === "policy_change" && a.ok) {
      const before = (await ctx.db.get(r.orgId))?.approvals;
      await ctx.db.patch(r.orgId, { approvals: r.payload.policy });
      await logAudit(ctx, { orgId: r.orgId, actor: r.decidedByUserId ?? "system", action: "security.approval_policy_updated", resource: "organization", resourceId: r.orgId, before: before ?? { payouts: "off" }, after: r.payload.policy });
    }
    await notify(ctx, {
      orgId: r.orgId,
      kind: "approval_decided",
      severity: a.ok ? "info" : "warning",
      title: a.ok ? "Approved request carried out" : "Approved request could not be completed",
      body: a.ok ? r.summary : `${r.summary}: ${a.error ?? "failed"}`,
      link: "/dashboard/approvals",
    });
  },
});

export const decide = action({
  args: { approvalId: v.id("approvalRequests"), decision: v.union(v.literal("approve"), v.literal("reject")), note: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ status: string; detail?: string }> => {
    const who: { userId: Id<"users">; label: string } = await ctx.runQuery(api.approvals.assertCanDecide, { approvalId: a.approvalId });
    const note = a.note?.trim().slice(0, 500) || undefined;
    const r: Doc<"approvalRequests"> = await ctx.runMutation(internal.approvals.claimInternal, {
      approvalId: a.approvalId,
      userId: who.userId,
      label: who.label,
      decision: a.decision === "approve" ? "approved" : "rejected",
      note,
    });
    if (a.decision === "reject") return { status: "rejected" };
    try {
      if (r.kind === "payout") {
        const p = r.payload as { beneficiaryId: Id<"beneficiaries">; amountMinor: number; narration?: string; simulate?: string };
        const out = await ctx.runAction(internal.payouts.payoutInternal, {
          orgId: r.orgId,
          beneficiaryId: p.beneficiaryId,
          amountMinor: p.amountMinor,
          narration: p.narration,
          simulate: p.simulate,
          actor: `approved:${who.userId}`,
          idempotencyKey: `approval_${r._id}`,
        });
        if (out.kind === "error") throw new Error(out.message ?? "Payout failed");
        await ctx.runMutation(internal.approvals.finishInternal, { approvalId: r._id, ok: true, result: { payoutId: out.payoutId, status: out.status } });
        return { status: "executed", detail: `Payout ${out.payoutId}: ${out.status}` };
      }
      if (r.kind === "bulk_payout") {
        const out: { queued: number } = await ctx.runAction(internal.bulkPayouts.executeBatchInternal, { batchId: r.payload.batchId, actor: `approved:${who.userId}` });
        await ctx.runMutation(internal.approvals.finishInternal, { approvalId: r._id, ok: true, result: out });
        return { status: "executed", detail: `${out.queued} payouts are being sent` };
      }
      await ctx.runMutation(internal.approvals.finishInternal, { approvalId: r._id, ok: true });
      return { status: "executed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Execution failed";
      await ctx.runMutation(internal.approvals.finishInternal, { approvalId: r._id, ok: false, error: message });
      return { status: "failed", detail: message };
    }
  },
});

export const cancel = mutation({
  args: { approvalId: v.id("approvalRequests") },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const r = await ctx.db.get(a.approvalId);
    if (!r || r.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND: approval request");
    if (r.status !== "pending") throw new ConvexError(`CONFLICT: this request is already ${r.status}`);
    if (r.requestedByUserId !== oc.userId && !oc.permissions.has(PERMISSIONS.SECURITY_MANAGE)) throw new ConvexError("FORBIDDEN: only the requester or a security manager can cancel");
    await ctx.db.patch(r._id, { status: "cancelled", decidedByUserId: oc.userId, decidedByLabel: await userLabel(ctx, oc.userId), decidedAt: Date.now() });
    if (r.kind === "bulk_payout") await ctx.db.patch(r.payload.batchId as Id<"payoutBatches">, { status: "cancelled", updatedAt: Date.now() });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "approval.cancelled", resource: "approvalRequest", resourceId: r._id });
  },
});

/** Cron: mark stale requests expired so nothing old can be approved by accident. */
export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("approvalRequests").withIndex("by_status_expires", (q) => q.eq("status", "pending").lt("expiresAt", Date.now())).take(200);
    for (const r of rows) {
      await ctx.db.patch(r._id, { status: "expired" });
      if (r.kind === "bulk_payout") await ctx.db.patch(r.payload.batchId as Id<"payoutBatches">, { status: "cancelled", updatedAt: Date.now() });
    }
    return rows.length;
  },
});

export const orgPolicyInternal = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, a) => ((await ctx.db.get(a.orgId))?.approvals ?? { payouts: "off" }) as ApprovalPolicy,
});

export const byIdInternal = internalQuery({
  args: { approvalId: v.id("approvalRequests") },
  handler: async (ctx, a) => ctx.db.get(a.approvalId),
});
