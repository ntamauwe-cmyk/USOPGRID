// Public status: a health sample every 5 minutes, a daily rollup, and the
// data behind usopgrid.com/status (GET /api/v1/status, no key needed).
//
// Core components (API, webhook delivery, recovery queue) decide uptime.
// Third-party providers are shown separately and only when there was enough
// live traffic in the last 30 minutes to measure them; we never publish a
// provider state we have no evidence for.

import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAdapter } from "./providers/index";
import { jsonOk, requestIdFrom } from "./lib/httpservice";
import {
  HISTORY_DAYS,
  OVERDUE_MS,
  PROVIDER_WINDOW_MS,
  dayUptime,
  isProviderFault,
  providerState,
  queueState,
  utcDay,
  worst,
  type ComponentState,
} from "./lib/status";

const SCAN_LIMIT = 2_000;

export const recordSampleInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Webhook deliveries that should have been attempted 10+ minutes ago.
    const lateWebhooks = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_next", (q) => q.eq("status", "pending").lt("nextAttemptAt", now - OVERDUE_MS))
      .take(100);
    const lateRecovery = await ctx.db
      .query("recoveryJobs")
      .withIndex("by_status_next", (q) => q.eq("status", "open").lt("nextCheckAt", now - OVERDUE_MS))
      .take(100);

    // Live provider health from real production attempts (probes excluded).
    const attempts = await ctx.db
      .query("paymentAttempts")
      .withIndex("by_env_started", (q) => q.eq("environment", "production").gte("startedAt", now - PROVIDER_WINDOW_MS))
      .take(SCAN_LIMIT);
    const per = new Map<string, { n: number; faults: number }>();
    for (const a of attempts) {
      if (a.probe) continue;
      const p = per.get(a.providerId) ?? { n: 0, faults: 0 };
      p.n++;
      if (isProviderFault(a.status, a.failureCategory)) p.faults++;
      per.set(a.providerId, p);
    }
    const providers = [...per]
      .flatMap(([providerId, p]) => {
        const state = providerState(p.n, p.faults);
        return state ? [{ providerId, state }] : [];
      })
      .sort((a, b) => a.providerId.localeCompare(b.providerId));

    const components = { api: "operational" as ComponentState, webhooks: queueState(lateWebhooks.length), recovery: queueState(lateRecovery.length) };
    const overall = worst(components.api, components.webhooks, components.recovery);
    const ok = overall === "operational";
    await ctx.db.insert("statusSamples", { at: now, ok, components, webhookOverdue: lateWebhooks.length, recoveryOverdue: lateRecovery.length, providers });

    const day = utcDay(now);
    const roll = await ctx.db.query("statusDays").withIndex("by_day", (q) => q.eq("day", day)).unique();
    if (roll) {
      await ctx.db.patch(roll._id, { samples: roll.samples + 1, okSamples: roll.okSamples + (ok ? 1 : 0), worst: worst(roll.worst, overall), lastAt: now });
    } else {
      await ctx.db.insert("statusDays", { day, samples: 1, okSamples: ok ? 1 : 0, worst: overall, firstAt: now, lastAt: now });
    }

    // Retention: samples 2 days, rollups 90 days (bounded per run).
    for (const old of await ctx.db.query("statusSamples").withIndex("by_at", (q) => q.lt("at", now - 2 * 86_400_000)).take(50)) await ctx.db.delete(old._id);
    for (const old of await ctx.db.query("statusDays").withIndex("by_day", (q) => q.lt("day", utcDay(now - (HISTORY_DAYS + 1) * 86_400_000))).take(10)) await ctx.db.delete(old._id);
  },
});

export interface PublicStatus {
  status: ComponentState;
  updated_at: string | null;
  components: { id: string; name: string; state: ComponentState }[];
  providers: { id: string; name: string; state: ComponentState }[];
  history: { day: string; uptime: number | null; worst: ComponentState | null }[];
  uptime_90d: number | null;
  monitoring_since: string | null;
}

export const publicStatusInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<PublicStatus> => {
    const now = Date.now();
    const latest = await ctx.db.query("statusSamples").withIndex("by_at").order("desc").first();
    const days = await ctx.db
      .query("statusDays")
      .withIndex("by_day", (q) => q.gte("day", utcDay(now - (HISTORY_DAYS - 1) * 86_400_000)))
      .take(HISTORY_DAYS + 1);
    const byDay = new Map(days.map((d) => [d.day, d]));
    const first = await ctx.db.query("statusDays").withIndex("by_day").order("asc").first();
    const sinceAt = first?.firstAt ?? now;

    // A missing or stale sample means the platform could not check itself.
    const stale = !latest || now - latest.at > 15 * 60_000;
    const c = latest?.components;
    const components = [
      { id: "api", name: "Payments API", state: (stale ? "degraded" : c!.api) as ComponentState },
      { id: "webhooks", name: "Webhook delivery", state: (stale ? "degraded" : c!.webhooks) as ComponentState },
      { id: "recovery", name: "Payment confirmation and recovery", state: (stale ? "degraded" : c!.recovery) as ComponentState },
    ];

    const history: PublicStatus["history"] = [];
    let ok = 0;
    let expectedTotal = 0;
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const day = utcDay(now - i * 86_400_000);
      const r = byDay.get(day);
      const up = first ? dayUptime(r?.okSamples ?? 0, day, now, sinceAt) : null;
      history.push({ day, uptime: up, worst: r?.worst ?? (up === null ? null : "outage") });
      if (up !== null) {
        const start = Date.parse(`${day}T00:00:00Z`);
        const span = Math.min(start + 86_400_000, now) - Math.max(start, sinceAt);
        expectedTotal += span;
        ok += up * span;
      }
    }

    return {
      status: worst(...components.map((x) => x.state)),
      updated_at: latest ? new Date(latest.at).toISOString() : null,
      components,
      providers: stale ? [] : (latest?.providers ?? []).map((p) => ({ id: p.providerId, name: getAdapter(p.providerId)?.descriptor.displayName ?? p.providerId, state: p.state })),
      history,
      uptime_90d: expectedTotal > 0 ? ok / expectedTotal : null,
      monitoring_since: first ? new Date(sinceAt).toISOString() : null,
    };
  },
});

/** GET /api/v1/status — public, cacheable for 30 seconds. */
export const publicStatus = httpAction(async (ctx, request) => {
  const body: PublicStatus = await ctx.runQuery(internal.status.publicStatusInternal, {});
  const res = jsonOk(body, 200, requestIdFrom(request));
  res.headers.set("Cache-Control", "public, max-age=30");
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
});
