import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { PageHeader, StatCard, LoadingRows, NoAccess, pct } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import { getCountry } from "@/lib/geo";
import { METHOD_LABELS } from "@/convex/providers/types";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

const WINDOWS = [7, 30, 90] as const;

function Breakdown({ title, rows, label }: { title: string; rows: { key: string; count: number; successRate: number | null; volumeByCurrency: Record<string, number> }[]; label: (k: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No payments in this window.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="sr-only"><tr><th>{title}</th><th>Payments</th><th>Success rate</th></tr></thead>
          <tbody>
            {rows.slice(0, 8).map((r) => (
              <tr key={r.key}>
                <td className="w-2/5 py-1.5 pr-2 truncate">{label(r.key)}</td>
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2 rounded-sm bg-primary/70" style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }} />
                    <span className="tabular-nums text-muted-foreground">{r.count}</span>
                  </div>
                </td>
                <td className="w-16 py-1.5 text-right tabular-nums">{pct(r.successRate, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Analytics() {
  const ctx = useQuery(api.orgs.getOrgContext, {});
  const allowed = ctx?.permissions.includes("analytics:view");
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const d = useQuery(api.analytics.dashboard, allowed ? { days } : "skip");

  if (ctx && !allowed) return <NoAccess what="analytics" />;

  const series =
    d?.overview.daily.map((x) => ({ day: x.day.slice(5), payments: x.payments, successRate: x.successRate === null ? null : Math.round(x.successRate * 1000) / 10 })) ?? [];
  const withForecast = [...series, ...(d?.forecast.map((f) => ({ day: f.day.slice(5), forecast: f.payments })) ?? [])];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description={d ? `${d.environment === "production" ? "Live" : "Sandbox"} data, computed from your transaction records. Updated ${new Date(d.generatedAt).toLocaleTimeString()}.` : "Computed from your transaction records."}
        actions={
          <div className="flex gap-1" role="group" aria-label="Time window">
            {WINDOWS.map((w) => (
              <Button key={w} size="sm" variant={days === w ? "default" : "outline"} aria-pressed={days === w} onClick={() => setDays(w)}>
                {w} days
              </Button>
            ))}
          </div>
        }
      />
      {d === undefined ? (
        <LoadingRows rows={6} />
      ) : (
        <>
          {d.dataFreshness.truncated && <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">This window has more than 20,000 payments; figures use the most recent 20,000. Export from Reports for the full set.</p>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <StatCard label="Payments" value={d.overview.totals.payments.toLocaleString()} />
            <StatCard label="Success rate" value={pct(d.overview.totals.successRate)} hint="excludes pending" tone={d.overview.totals.successRate !== null && d.overview.totals.successRate < 0.8 ? "warn" : undefined} />
            <StatCard label="Approval rate" value={pct(d.overview.totals.approvalRate)} hint="issuer view" />
            <StatCard label="Failover rate" value={pct(d.overview.totals.failoverRate)} hint={`${d.routing.recoveredByFailover} recovered`} />
            <StatCard label="Refund rate" value={pct(d.overview.totals.refundRate)} />
            <StatCard label="Pending" value={d.overview.totals.pending} hint={`${d.overview.totals.outcomeUnknown} unconfirmed`} tone={d.overview.totals.outcomeUnknown ? "warn" : undefined} />
            <StatCard label="Open exceptions" value={d.reconciliation.openExceptions} tone={d.reconciliation.openExceptions ? "bad" : "good"} />
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">Daily payments and success rate, with a 7-day forecast</h2>
            <div className="mt-3 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={withForecast} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis yAxisId="n" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis yAxisId="p" orientation="right" domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="n" dataKey="payments" name="Payments" fill="var(--chart-1)" radius={[2, 2, 0, 0]} />
                  <Bar yAxisId="n" dataKey="forecast" name="Forecast" fill="var(--chart-5)" fillOpacity={0.45} radius={[2, 2, 0, 0]} />
                  <Line yAxisId="p" dataKey="successRate" name="Success %" stroke="var(--chart-2)" strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">Provider performance</h2>
            {d.providers.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No provider attempts in this window.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="py-2 pr-3 font-medium">Rank</th><th className="py-2 pr-3 font-medium">Provider</th><th className="py-2 pr-3 font-medium">Attempts</th><th className="py-2 pr-3 font-medium">Success</th><th className="py-2 pr-3 font-medium">Approval</th><th className="py-2 pr-3 font-medium">Provider errors</th><th className="py-2 pr-3 font-medium">p50 / p95 latency</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {d.providers.map((p) => (
                      <tr key={p.providerId}>
                        <td className="py-2 pr-3 tabular-nums">{p.rank}</td>
                        <td className="py-2 pr-3 font-medium">{p.displayName}</td>
                        <td className="py-2 pr-3 tabular-nums">{p.attempts}</td>
                        <td className="py-2 pr-3 tabular-nums">{pct(p.successRate)}</td>
                        <td className="py-2 pr-3 tabular-nums">{pct(p.approvalRate)}</td>
                        <td className={p.providerErrorRate && p.providerErrorRate > 0.05 ? "py-2 pr-3 tabular-nums text-red-700" : "py-2 pr-3 tabular-nums"}>{pct(p.providerErrorRate)}</td>
                        <td className="py-2 pr-3 tabular-nums">{p.latencyP50Ms ?? "—"} / {p.latencyP95Ms ?? "—"} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Breakdown title="By country" rows={d.overview.byCountry} label={(k) => getCountry(k)?.name ?? (k === "unknown" ? "Not supplied" : k)} />
            <Breakdown title="By payment method" rows={d.overview.byMethod} label={(k) => METHOD_LABELS[k as keyof typeof METHOD_LABELS] ?? k} />
            <Breakdown title="By currency" rows={d.overview.byCurrency} label={(k) => k} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold">Volume and cost by currency</h2>
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1.5 font-medium">Currency</th><th className="py-1.5 text-right font-medium">Volume</th><th className="py-1.5 text-right font-medium">Your fees earned</th><th className="py-1.5 text-right font-medium">Provider cost</th></tr></thead>
                <tbody className="divide-y">
                  {Object.entries(d.overview.volumeByCurrency).map(([c, v]) => (
                    <tr key={c}>
                      <td className="py-1.5">{c}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatMoney(v, c)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatMoney(d.overview.feesByCurrency[c] ?? 0, c)}</td>
                      <td className="py-1.5 text-right tabular-nums">{d.overview.providerCostByCurrency[c] !== undefined ? formatMoney(d.overview.providerCostByCurrency[c], c) : "not reported"}</td>
                    </tr>
                  ))}
                  {Object.keys(d.overview.volumeByCurrency).length === 0 && <tr><td colSpan={4} className="py-3 text-muted-foreground">No successful payments in this window.</td></tr>}
                </tbody>
              </table>
              {d.costPerSuccess.length > 0 && (
                <>
                  <h3 className="mt-5 text-xs font-medium text-muted-foreground">Provider cost per successful payment</h3>
                  <ul className="mt-2 space-y-1 text-sm">
                    {d.costPerSuccess.map((c) => (
                      <li key={`${c.provider}-${c.currency}`} className="flex justify-between">
                        <span>{c.provider} · {c.currency}</span>
                        <span className="tabular-nums">{c.perSuccessMinor !== null ? formatMoney(c.perSuccessMinor, c.currency) : "—"} <span className="text-muted-foreground">over {c.successes}</span></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold">Why payments failed</h2>
              {d.overview.failureReasons.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No failures in this window.</p>
              ) : (
                <table className="mt-3 w-full text-sm">
                  <tbody className="divide-y">
                    {d.overview.failureReasons.map((r) => (
                      <tr key={`${r.category}-${r.code}`}>
                        <td className="py-1.5"><div>{r.category.replace(/_/g, " ")}</div><div className="font-mono text-xs text-muted-foreground">{r.code}</div></td>
                        <td className="py-1.5 text-right tabular-nums">{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <h3 className="mt-5 text-xs font-medium text-muted-foreground">Webhooks and disputes</h3>
              <p className="mt-1 text-sm">{d.webhooks.delivered} of {d.webhooks.total} webhooks delivered, {d.webhooks.failing} retrying, {d.webhooks.dead} dead-lettered. {d.disputes.opened} disputes opened ({d.disputes.won} won, {d.disputes.lost} lost).</p>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">API usage</h2>
            <div className="mt-3 grid gap-4 lg:grid-cols-[2fr_1fr]">
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={d.api.daily.map((x) => ({ ...x, day: x.day.slice(5), ok: x.requests - x.errors4xx - x.errors5xx }))} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={24} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="ok" stackId="a" name="2xx" fill="var(--chart-2)" />
                    <Bar dataKey="errors4xx" stackId="a" name="4xx" fill="var(--chart-3)" />
                    <Bar dataKey="errors5xx" stackId="a" name="5xx" fill="var(--chart-4)" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <ul className="space-y-1 text-sm">
                {d.api.topRoutes.length === 0 && <li className="text-muted-foreground">No API calls in this window.</li>}
                {d.api.topRoutes.map((r) => (
                  <li key={r.route} className="flex justify-between gap-2"><span className="truncate font-mono text-xs">{r.route}</span><span className="tabular-nums">{r.count.toLocaleString()}</span></li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
