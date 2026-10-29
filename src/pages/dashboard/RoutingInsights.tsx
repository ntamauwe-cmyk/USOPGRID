// Provider scorecards and the historical routing backtest. Every figure here
// states its period, sample size and method; simulated results are labelled.
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadingRows } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import { PAYMENT_METHODS, METHOD_LABELS } from "@/convex/providers/types";

const pct = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(d)}%`);
const ms = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n).toLocaleString()} ms`);

function WindowPicker({ value, onChange, id }: { value: number; onChange: (d: number) => void; id: string }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5" role="radiogroup" aria-labelledby={id}>
      {[7, 30, 90].map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={value === d}
          onClick={() => onChange(d)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${value === d ? "bg-navy text-ivory" : "text-muted-foreground hover:text-foreground"}`}
        >
          {d} days
        </button>
      ))}
    </div>
  );
}

function money(map: Record<string, number | null>) {
  const e = Object.entries(map).filter(([, v]) => v !== null) as [string, number][];
  return e.length ? e.map(([c, v]) => formatMoney(v, c)).join(" · ") : "—";
}

export function Scorecards() {
  const [days, setDays] = useState(30);
  const data = useQuery(api.routing.scorecards, { days });
  return (
    <section className="rounded-lg border bg-card p-5" aria-labelledby="sc-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sc-h" className="text-lg font-semibold">Provider scorecards</h2>
          <p className="mt-1 text-sm text-muted-foreground">Measured from your own payment attempts. Ranges are 95% confidence intervals.</p>
        </div>
        <WindowPicker id="sc-h" value={days} onChange={setDays} />
      </div>
      {data === undefined ? (
        <div className="mt-4"><LoadingRows rows={3} /></div>
      ) : (
        <>
          <p className="mt-3 rounded-md bg-muted p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Period:</strong> {new Date(data.from).toLocaleDateString()} – {new Date(data.to).toLocaleDateString()} ({data.environment}). {data.dataSource}
            {data.truncated && " Only the most recent 5,000 attempts are included."}
          </p>
          {data.cards.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No payment attempts in this period yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Provider</th>
                    <th className="py-2 pr-4 font-medium">Sample</th>
                    <th className="py-2 pr-4 font-medium">Success (95% range)</th>
                    <th className="py-2 pr-4 font-medium">Approval</th>
                    <th className="py-2 pr-4 font-medium">Provider errors</th>
                    <th className="py-2 pr-4 font-medium">Timeouts</th>
                    <th className="py-2 pr-4 font-medium">Latency p50 / p95</th>
                    <th className="py-2 font-medium">Cost per success</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.cards.map((c) => (
                    <tr key={c.connectionId} className="align-top">
                      <td className="py-2.5 pr-4">
                        <div className="font-medium">{c.displayName}</div>
                        {!c.sufficient && <span className="mt-1 inline-block rounded bg-status-attention-bg px-1.5 py-0.5 text-[11px] font-medium text-status-attention">Insufficient data</span>}
                        {c.limitations.length > 0 && (
                          <ul className="mt-1 max-w-xs list-disc pl-4 text-xs text-muted-foreground">
                            {c.limitations.map((l) => <li key={l}>{l}</li>)}
                          </ul>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">{c.decided} decided{c.probes > 0 && <div className="text-xs text-muted-foreground">+{c.probes} probes</div>}</td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {pct(c.successRate.rate)}
                        {c.successRate.low !== null && <div className="text-xs text-muted-foreground">{pct(c.successRate.low)} – {pct(c.successRate.high)}</div>}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">{pct(c.approvalRate)}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{pct(c.providerErrorRate)}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{pct(c.timeoutRate)}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{ms(c.latencyP50)} / {ms(c.latencyP95)}</td>
                      <td className="py-2.5 tabular-nums">{money(c.costPerSuccessByCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">How these scores are calculated</summary>
            <p className="mt-2 max-w-3xl">{data.method}</p>
          </details>
        </>
      )}
    </section>
  );
}

type Rule = { _id: string; name: string; enabled: boolean };
type Weights = { success: number; cost: number; latency: number };
type ExtraRule = { match: { currencies?: string[]; methods?: string[] }; action: { type: "prefer" | "exclude" | "only"; providers: string[] } };

export function Backtest({ rules, providers, weights }: { rules: Rule[]; providers: { id: string; displayName: string }[]; weights: Weights }) {
  const [days, setDays] = useState(30);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [w, setW] = useState({ success: Math.round(weights.success * 100), cost: Math.round(weights.cost * 100), latency: Math.round(weights.latency * 100) });
  const [extra, setExtra] = useState({ on: false, type: "prefer" as ExtraRule["action"]["type"], provider: providers[0]?.id ?? "", currency: "", method: "" });
  const [args, setArgs] = useState<{ days: number; disabledRuleIds: string[]; weights: Weights; extraRule?: ExtraRule } | null>(null);
  const result = useQuery(api.routing.backtest, args ?? "skip");
  const total = w.success + w.cost + w.latency || 1;
  const name = (id: string) => result?.providerNames[id] ?? providers.find((p) => p.id === id)?.displayName ?? id;

  function run() {
    const extraRule: ExtraRule | undefined =
      extra.on && extra.provider
        ? {
            match: { currencies: extra.currency.trim() ? [extra.currency.trim().toUpperCase()] : undefined, methods: extra.method ? [extra.method] : undefined },
            action: { type: extra.type, providers: [extra.provider] },
          }
        : undefined;
    setArgs({ days, disabledRuleIds: disabled, weights: w, extraRule });
  }

  return (
    <section className="rounded-lg border bg-card p-5" aria-labelledby="bt-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="bt-h" className="text-lg font-semibold">Test a policy on past payments</h2>
          <p className="mt-1 text-sm text-muted-foreground">Replay recent payments under a proposed policy and compare it with the live one. Nothing is saved and no money moves.</p>
        </div>
        <WindowPicker id="bt-h" value={days} onChange={setDays} />
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-3">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Live rules to switch off</legend>
          {rules.filter((r) => r.enabled).length === 0 && <p className="text-sm text-muted-foreground">No live rules.</p>}
          {rules.filter((r) => r.enabled).map((r) => (
            <label key={r._id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={disabled.includes(r._id)} onChange={(e) => setDisabled(e.target.checked ? [...disabled, r._id] : disabled.filter((x) => x !== r._id))} />
              {r.name}
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Proposed weights</legend>
          {(["success", "cost", "latency"] as const).map((k) => (
            <div key={k} className="flex items-center gap-2">
              <Label htmlFor={`bt-${k}`} className="w-24 text-xs font-normal">{{ success: "Success rate", cost: "Cost", latency: "Latency" }[k]}</Label>
              <input id={`bt-${k}`} type="range" min={0} max={100} value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} className="w-full accent-[var(--primary)]" />
              <span className="w-10 text-right text-xs tabular-nums">{Math.round((w[k] / total) * 100)}%</span>
            </div>
          ))}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Add a rule</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={extra.on} onChange={(e) => setExtra({ ...extra, on: e.target.checked })} /> Include a proposed rule
          </label>
          {extra.on && (
            <div className="grid grid-cols-2 gap-2">
              <select aria-label="Rule action" className="h-9 rounded-md border bg-background px-2 text-sm" value={extra.type} onChange={(e) => setExtra({ ...extra, type: e.target.value as ExtraRule["action"]["type"] })}>
                <option value="prefer">Prefer</option>
                <option value="only">Only use</option>
                <option value="exclude">Exclude</option>
              </select>
              <select aria-label="Provider" className="h-9 rounded-md border bg-background px-2 text-sm" value={extra.provider} onChange={(e) => setExtra({ ...extra, provider: e.target.value })}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
              <input aria-label="Currency (optional)" placeholder="Any currency" maxLength={3} className="h-9 rounded-md border bg-background px-2 text-sm" value={extra.currency} onChange={(e) => setExtra({ ...extra, currency: e.target.value })} />
              <select aria-label="Method (optional)" className="h-9 rounded-md border bg-background px-2 text-sm" value={extra.method} onChange={(e) => setExtra({ ...extra, method: e.target.value })}>
                <option value="">Any method</option>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
              </select>
            </div>
          )}
        </fieldset>
      </div>

      <Button className="mt-4" size="sm" onClick={run}>Run backtest</Button>

      {args && result === undefined && <div className="mt-4"><LoadingRows rows={3} /></div>}
      {result && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded bg-status-info-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-status-info">Simulated</span>
            <span className="text-muted-foreground">
              {result.payments.toLocaleString()} payments, {new Date(result.from).toLocaleDateString()} – {new Date(result.to).toLocaleDateString()} ({result.environment}). {result.dataSource}
            </span>
          </div>
          {result.payments === 0 ? (
            <p className="text-sm text-muted-foreground">No completed payments in this period to replay.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="py-2 pr-4 font-medium" /><th className="py-2 pr-4 font-medium">Live policy</th><th className="py-2 pr-4 font-medium">Proposed</th><th className="py-2 font-medium">Change</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr>
                      <td className="py-2 pr-4 font-medium">First-attempt success</td>
                      <td className="py-2 pr-4 tabular-nums">{pct(result.current.successRate)}</td>
                      <td className="py-2 pr-4 tabular-nums">{pct(result.proposed.successRate)}</td>
                      <td className="py-2 tabular-nums">{result.delta.successRatePoints === null ? "—" : `${result.delta.successRatePoints > 0 ? "+" : ""}${result.delta.successRatePoints} pts`}</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">Average latency</td>
                      <td className="py-2 pr-4 tabular-nums">{ms(result.current.avgLatencyMs)}</td>
                      <td className="py-2 pr-4 tabular-nums">{ms(result.proposed.avgLatencyMs)}</td>
                      <td className="py-2 tabular-nums">{result.delta.avgLatencyMs === null ? "—" : `${result.delta.avgLatencyMs > 0 ? "+" : ""}${result.delta.avgLatencyMs} ms`}</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">Est. fees per success</td>
                      <td className="py-2 pr-4 tabular-nums">{money(result.current.costPerSuccessByCurrency)}</td>
                      <td className="py-2 pr-4 tabular-nums">{money(result.proposed.costPerSuccessByCurrency)}</td>
                      <td className="py-2" />
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">Provider share</td>
                      <td className="py-2 pr-4 text-xs">{Object.entries(result.current.share).map(([p, n]) => `${name(p)} ${n}`).join(", ") || "—"}</td>
                      <td className="py-2 pr-4 text-xs">{Object.entries(result.proposed.share).map(([p, n]) => `${name(p)} ${n}`).join(", ") || "—"}</td>
                      <td className="py-2 tabular-nums">{result.changedDecisions} decisions change</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4 font-medium">Basis</td>
                      <td className="py-2 pr-4 text-xs">{result.current.observed} observed · {result.current.estimated} estimated</td>
                      <td className="py-2 pr-4 text-xs">{result.proposed.observed} observed · {result.proposed.estimated} estimated</td>
                      <td className="py-2" />
                    </tr>
                  </tbody>
                </table>
              </div>
              {(result.proposed.lowConfidence > 0 || result.proposed.unroutable > 0) && (
                <ul className="space-y-1 rounded-md border border-status-attention/30 bg-status-attention-bg p-3 text-sm text-status-attention">
                  {result.proposed.lowConfidence > 0 && <li>{result.proposed.lowConfidence} estimates rest on fewer than {result.minSample} attempts and are low confidence.</li>}
                  {result.proposed.unroutable > 0 && <li>{result.proposed.unroutable} payments would have no eligible provider under the proposed policy.</li>}
                </ul>
              )}
            </>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Method and limitations</summary>
            <ul className="mt-2 max-w-3xl list-disc space-y-1 pl-4">{result.method.map((m) => <li key={m}>{m}</li>)}</ul>
          </details>
        </div>
      )}
    </section>
  );
}
