// Provider settlement-report reconciliation workflow: upload a report, match
// it against USOPGRID's records, review typed exceptions and resolve them
// with an audited note. Nothing is auto-corrected.

import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePermissionFor } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { parseSettlementReport, reconcile, type ExpectedRow } from "./lib/recon";
import { getAdapter } from "./providers/index";

const MAX_REPORT_BYTES = 4_000_000;

export const ingestReport = mutation({
  args: {
    provider: v.string(),
    filename: v.string(),
    csv: v.string(),
    amountsIn: v.union(v.literal("major"), v.literal("minor")),
    defaultCurrency: v.optional(v.string()),
    periodStart: v.number(),
    periodEnd: v.number(),
  },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.RECON_MANAGE);
    if (!getAdapter(a.provider)) throw new ConvexError("Unknown provider");
    if (a.csv.length > MAX_REPORT_BYTES) throw new ConvexError("Report is too large (4 MB max). Split it by date range.");
    if (a.periodEnd <= a.periodStart) throw new ConvexError("Period end must be after period start");
    if (a.periodEnd - a.periodStart > 93 * 86_400_000) throw new ConvexError("Reconcile at most ~3 months per run");

    const parsed = parseSettlementReport(a.csv, { amountsIn: a.amountsIn, defaultCurrency: a.defaultCurrency?.toUpperCase() });
    if (parsed.rows.length === 0) throw new ConvexError(`Could not read the report: ${parsed.errors.slice(0, 5).join("; ")}`);

    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org_env_created", (q) => q.eq("orgId", oc.orgId).eq("environment", env).gte("createdAt", a.periodStart).lte("createdAt", a.periodEnd))
      .take(50_000);
    const expected: ExpectedRow[] = txns
      .filter((t) => t.provider === a.provider)
      .map((t) => ({ transactionId: t.transactionId, providerReference: t.providerReference, amountMinor: t.amountMinor, currency: t.currency, providerFeeMinor: t.providerFeeMinor, status: t.status }));
    // Report rows may reference payments created just outside the window: look them up directly.
    const known = new Set(expected.map((e) => e.providerReference));
    for (const r of parsed.rows) {
      if (known.has(r.providerReference)) continue;
      const t = await ctx.db
        .query("transactions")
        .withIndex("by_provider_reference", (q) => q.eq("provider", a.provider).eq("providerReference", r.providerReference))
        .first();
      if (t && t.orgId === oc.orgId) {
        expected.push({ transactionId: t.transactionId, providerReference: t.providerReference, amountMinor: t.amountMinor, currency: t.currency, providerFeeMinor: t.providerFeeMinor, status: t.status });
        known.add(r.providerReference);
      }
    }

    const result = reconcile(parsed.rows, expected);
    const runId = await ctx.db.insert("reconRuns", {
      orgId: oc.orgId,
      provider: a.provider,
      source: a.filename.slice(0, 200),
      periodStart: a.periodStart,
      periodEnd: a.periodEnd,
      rows: parsed.rows.length,
      matched: result.matched,
      exceptions: result.findings.length,
      totals: result.totals,
      status: "completed",
      createdBy: oc.userId,
      createdAt: Date.now(),
    });
    for (const f of result.findings.slice(0, 2000)) {
      await ctx.db.insert("reconExceptions", {
        orgId: oc.orgId,
        runId,
        batchReference: undefined,
        type: f.type,
        severity: f.severity,
        detail: f.detail,
        ledgerAmountMinor: f.expectedAmountMinor,
        bankAmountMinor: f.reportedAmountMinor,
        currency: f.currency,
        transactionId: f.transactionId,
        providerReference: f.providerReference,
        provider: a.provider,
        status: "open",
        createdAt: Date.now(),
      });
    }
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "reconciliation.run", resource: "recon_run", resourceId: runId, after: { provider: a.provider, rows: parsed.rows.length, matched: result.matched, exceptions: result.findings.length } });
    return { runId, rows: parsed.rows.length, matched: result.matched, exceptions: result.findings.length, parseErrors: parsed.errors.slice(0, 50), totals: result.totals };
  },
});

export const listRuns = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.SETTLEMENT_VIEW);
    return ctx.db.query("reconRuns").withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId)).order("desc").take(50);
  },
});

export const listExceptions = query({
  args: { status: v.optional(v.union(v.literal("open"), v.literal("resolved"), v.literal("acknowledged"))) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.SETTLEMENT_VIEW);
    return ctx.db
      .query("reconExceptions")
      .withIndex("by_org_status_created", (q) => q.eq("orgId", oc.orgId).eq("status", a.status ?? "open"))
      .order("desc")
      .take(500);
  },
});

export const resolveException = mutation({
  args: {
    exceptionId: v.id("reconExceptions"),
    status: v.union(v.literal("resolved"), v.literal("acknowledged")),
    resolution: v.string(),
  },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.RECON_MANAGE);
    const ex = await ctx.db.get(a.exceptionId);
    if (!ex || ex.orgId !== oc.orgId) throw new ConvexError("Exception not found");
    const note = a.resolution.trim();
    if (note.length < 5) throw new ConvexError("Describe how this was resolved (min 5 characters)");
    await ctx.db.patch(a.exceptionId, { status: a.status, resolution: note.slice(0, 2000), resolvedBy: oc.userId, resolvedAt: Date.now() });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: `reconciliation.exception_${a.status}`, resource: "recon_exception", resourceId: a.exceptionId, before: { status: ex.status }, after: { status: a.status, resolution: note } });
  },
});
