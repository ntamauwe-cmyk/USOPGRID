// Analytics over real records: operational overview, provider ranking,
// routing effectiveness, cost, API usage, forecasting, anomaly detection and
// CSV export. Metric definitions live in lib/analytics.ts.

import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requirePermissionFor } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { computeOverview, providerPerformance, linearForecast, anomalyScore, toCsv, dayRange, utcDay, SUCCESS_LIKE } from "./lib/analytics";
import { notify } from "./connections";
import { getAdapter } from "./providers/index";

const MAX_ROWS = 20_000;

export const dashboard = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const days = Math.min(Math.max(Math.round(a.days ?? 30), 1), 365);
    const to = Date.now();
    const from = to - days * 86_400_000;
    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";

    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org_env_created", (q) => q.eq("orgId", oc.orgId).eq("environment", env).gte("createdAt", from))
      .take(MAX_ROWS);
    const attempts = (
      await ctx.db
        .query("paymentAttempts")
        .withIndex("by_org_started", (q) => q.eq("orgId", oc.orgId).gte("startedAt", from))
        .take(MAX_ROWS)
    ).filter((x) => x.environment === env);

    const overview = computeOverview(txns, from, to);
    const providers = providerPerformance(attempts).map((p) => ({ ...p, displayName: getAdapter(p.providerId)?.descriptor.displayName ?? p.providerId }));

    // Cost per successful payment per provider per currency (provider-reported fees).
    const cost: Record<string, Record<string, { fees: number; successes: number }>> = {};
    for (const t of txns) {
      if (!SUCCESS_LIKE.has(t.status)) continue;
      const c = ((cost[t.provider] ??= {})[t.currency] ??= { fees: 0, successes: 0 });
      c.successes++;
      c.fees += t.providerFeeMinor ?? 0;
    }
    const costPerSuccess = Object.entries(cost).flatMap(([provider, byCur]) =>
      Object.entries(byCur).map(([currency, c]) => ({ provider, currency, successes: c.successes, providerFeesMinor: c.fees, perSuccessMinor: c.successes ? Math.round(c.fees / c.successes) : null })),
    );

    // Routing effectiveness: first-choice success vs recovered by failover.
    const routed = txns.filter((t) => (t.attemptCount ?? 0) > 0);
    const firstTry = routed.filter((t) => (t.failoverCount ?? 0) === 0 && SUCCESS_LIKE.has(t.status)).length;
    const recovered = routed.filter((t) => (t.failoverCount ?? 0) > 0 && SUCCESS_LIKE.has(t.status)).length;

    const dailyCounts = overview.daily.map((d) => d.payments);
    const forecast = linearForecast(dailyCounts.slice(-28), 7);
    const lastDay = overview.daily[overview.daily.length - 1]?.day ?? utcDay(to);

    // API usage (all keys of the org).
    const usageRows = await ctx.db
      .query("apiUsage")
      .withIndex("by_org_day", (q) => q.eq("orgId", oc.orgId).gte("day", utcDay(from)))
      .collect();
    const usageByDay = new Map(dayRange(from, to).map((d) => [d, { day: d, requests: 0, errors4xx: 0, errors5xx: 0 }]));
    const routes: Record<string, number> = {};
    for (const u of usageRows) {
      const b = usageByDay.get(u.day);
      if (b) {
        b.requests += u.requests;
        b.errors4xx += u.errors4xx;
        b.errors5xx += u.errors5xx;
      }
      for (const [r, n] of Object.entries(u.byRoute as Record<string, number>)) routes[r] = (routes[r] ?? 0) + n;
    }

    const webhookRows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId).gte("createdAt", from))
      .take(MAX_ROWS);
    const openExceptions = await ctx.db
      .query("reconExceptions")
      .withIndex("by_org_status_created", (q) => q.eq("orgId", oc.orgId).eq("status", "open"))
      .take(1000);
    const disputes = await ctx.db
      .query("disputes")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId).gte("createdAt", from))
      .take(MAX_ROWS);

    return {
      environment: env,
      generatedAt: to,
      dataFreshness: { latestTransactionAt: txns.reduce((m, t) => Math.max(m, t.createdAt), 0) || null, truncated: txns.length >= MAX_ROWS },
      overview,
      providers,
      costPerSuccess,
      routing: { routed: routed.length, firstChoiceSuccess: firstTry, recoveredByFailover: recovered, failoverRate: overview.totals.failoverRate },
      forecast: forecast.map((value, i) => ({ day: utcDay(Date.parse(`${lastDay}T00:00:00Z`) + (i + 1) * 86_400_000), payments: value })),
      api: {
        daily: [...usageByDay.values()],
        topRoutes: Object.entries(routes)
          .sort((x, y) => y[1] - x[1])
          .slice(0, 10)
          .map(([route, count]) => ({ route, count })),
      },
      webhooks: {
        total: webhookRows.length,
        delivered: webhookRows.filter((w) => w.status === "delivered").length,
        failing: webhookRows.filter((w) => w.status === "failed" || w.status === "pending").length,
        dead: webhookRows.filter((w) => w.status === "dead").length,
      },
      reconciliation: { openExceptions: openExceptions.length },
      disputes: { opened: disputes.length, lost: disputes.filter((d) => d.status === "LOST").length, won: disputes.filter((d) => d.status === "WON").length },
    };
  },
});

/** Transactions export (CSV) for finance — up to 20k rows in the window. */
export const exportTransactions = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const from = Date.now() - Math.min(Math.max(a.days ?? 30, 1), 365) * 86_400_000;
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_org_env_created", (q) => q.eq("orgId", oc.orgId).eq("environment", env).gte("createdAt", from))
      .take(MAX_ROWS);
    return toCsv(
      ["transaction_id", "reference", "created_at", "status", "amount_minor", "currency", "payment_method", "country", "provider", "provider_reference", "fee_minor", "net_minor", "refunded_minor", "attempts", "failovers", "failure_category", "failure_code", "customer_email"],
      rows.map((t) => [
        t.transactionId,
        t.reference,
        new Date(t.createdAt).toISOString(),
        t.status,
        t.amountMinor,
        t.currency,
        t.paymentMethod,
        t.country ?? "",
        t.provider,
        t.providerReference ?? "",
        t.feeMinor ?? "",
        t.netMinor ?? "",
        t.refundedMinor ?? 0,
        t.attemptCount ?? 0,
        t.failoverCount ?? 0,
        t.failureCategory ?? "",
        t.failureCode ?? "",
        t.customerEmail ?? "",
      ]),
    );
  },
});

// ---------------------------------------------------------------------------
// Anomaly detection (cron): provider failure-rate spikes vs trailing 7 days.
// ---------------------------------------------------------------------------
export const healthWindowInternal = internalQuery({
  args: { sinceDay: v.string() },
  handler: async (ctx, { sinceDay }) => {
    const rows = await ctx.db.query("providerHealth").collect();
    return rows.filter((r) => r.day >= sinceDay);
  },
});

export const raiseAnomalyInternal = internalMutation({
  args: { provider: v.string(), environment: v.string(), day: v.string(), z: v.number(), rate: v.number(), baseline: v.number() },
  handler: async (ctx, a) => {
    await notify(ctx, {
      orgId: undefined,
      kind: "anomaly",
      severity: a.z > 5 ? "critical" : "warning",
      title: `${a.provider} (${a.environment}) failure rate anomaly`,
      body: `Provider-side failure rate today is ${(a.rate * 100).toFixed(1)}% vs ${(a.baseline * 100).toFixed(1)}% baseline (z=${a.z.toFixed(1)}).`,
      link: "/dashboard/operations",
      dedupeKey: `anomaly:${a.provider}:${a.environment}:${a.day}`,
    });
  },
});

export const detectAnomaliesInternal = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; flagged: number }> => {
    const since = utcDay(Date.now() - 8 * 86_400_000);
    const rows: { provider: string; environment: string; day: string; charges: number; failed: number; unknown?: number }[] = await ctx.runQuery(internal.analytics.healthWindowInternal, { sinceDay: since });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(`${r.provider}|${r.environment}`, [...(groups.get(`${r.provider}|${r.environment}`) ?? []), r]);
    let flagged = 0;
    for (const [k, g] of groups) {
      g.sort((a, b) => (a.day < b.day ? -1 : 1));
      const today = g[g.length - 1];
      if (!today || today.day !== utcDay(Date.now()) || today.charges < 20) continue;
      const series = g.map((r) => (r.charges ? (r.failed + (r.unknown ?? 0)) / r.charges : 0));
      const s = anomalyScore(series, 3);
      const rate = series[series.length - 1];
      if (s && s.z >= 3 && rate >= 0.05) {
        const [provider, environment] = k.split("|");
        await ctx.runMutation(internal.analytics.raiseAnomalyInternal, { provider, environment, day: today.day, z: s.z, rate, baseline: s.mean });
        flagged++;
      }
    }
    return { checked: groups.size, flagged };
  },
});
