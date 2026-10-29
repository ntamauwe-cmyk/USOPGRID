import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, StatusPill, EmptyState, LoadingRows, errorMessage } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Route as RouteIcon, Trash2, Pencil } from "lucide-react";
import { PAYMENT_METHODS, METHOD_LABELS } from "@/convex/providers/types";
import { decimalToMinor, formatMoney, currencyDecimals } from "@/lib/money";

type RuleRow = NonNullable<ReturnType<typeof useQuery<typeof api.routing.listRules>>>["rules"][number];

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

const orUndef = (a: string[]) => (a.length ? a : undefined);

function describeRule(r: RuleRow) {
  const m = r.match;
  const parts: string[] = [];
  if (m.countries?.length) parts.push(`country ${m.countries.join(", ")}`);
  if (m.currencies?.length) parts.push(`currency ${m.currencies.join(", ")}`);
  if (m.methods?.length) parts.push(`method ${m.methods.map((x) => METHOD_LABELS[x as keyof typeof METHOD_LABELS] ?? x).join(", ")}`);
  if (m.minAmountMinor !== undefined) parts.push(`amount ≥ ${m.minAmountMinor}`);
  if (m.maxAmountMinor !== undefined) parts.push(`amount ≤ ${m.maxAmountMinor}`);
  if (m.minRiskScore !== undefined) parts.push(`risk ≥ ${m.minRiskScore}`);
  const verb = { prefer: "Prefer", exclude: "Exclude", only: "Use only" }[r.action.type];
  return `${verb} ${r.action.providers.join(", ")} ${parts.length ? `when ${parts.join(" and ")}` : "for every payment"}`;
}

function RuleDialog({ rule, providers, onClose }: { rule: RuleRow | null; providers: { id: string; displayName: string }[]; onClose: () => void }) {
  const upsert = useMutation(api.routing.upsertRule);
  const sensitive = useSensitive();
  const [type, setType] = useState<"prefer" | "exclude" | "only">(rule?.action.type ?? "prefer");
  const [chosen, setChosen] = useState<string[]>(rule?.action.providers ?? []);
  const [methods, setMethods] = useState<string[]>(rule?.match.methods ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const num = (k: string) => {
      const v = String(fd.get(k) ?? "").trim();
      return v === "" ? undefined : Math.round(Number(v));
    };
    setBusy(true);
    setError(null);
    try {
      await sensitive(() =>
        upsert({
          ruleId: rule?._id,
          name: String(fd.get("name") ?? ""),
          enabled: rule?.enabled ?? true,
          match: {
            countries: orUndef(list(String(fd.get("countries") ?? ""))),
            currencies: orUndef(list(String(fd.get("currencies") ?? ""))),
            methods: methods.length ? methods : undefined,
            minAmountMinor: num("min"),
            maxAmountMinor: num("max"),
            minRiskScore: num("risk"),
          },
          action: { type, providers: chosen },
        }),
      );
      toast.success(rule ? "Rule saved" : "Rule added");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit routing rule" : "Add routing rule"}</DialogTitle>
          <DialogDescription>Rules apply in order before scoring. Leave a condition empty to match everything.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="r-name">Name</Label>
            <Input id="r-name" name="name" defaultValue={rule?.name} placeholder="Prefer local rails in Nigeria" required maxLength={80} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Action</legend>
            <div className="flex flex-wrap gap-2">
              {(["prefer", "exclude", "only"] as const).map((t) => (
                <Button key={t} type="button" size="sm" variant={type === t ? "default" : "outline"} onClick={() => setType(t)} aria-pressed={type === t}>
                  {{ prefer: "Prefer", exclude: "Exclude", only: "Use only" }[t]}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {providers.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent">
                  <input type="checkbox" className="accent-[var(--primary)]" checked={chosen.includes(p.id)} onChange={() => toggle(chosen, setChosen, p.id)} />
                  {p.displayName}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-c">Payer countries</Label>
              <Input id="r-c" name="countries" defaultValue={rule?.match.countries?.join(", ")} placeholder="NG, GH" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-cur">Currencies</Label>
              <Input id="r-cur" name="currencies" defaultValue={rule?.match.currencies?.join(", ")} placeholder="NGN" />
            </div>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Payment methods</legend>
            <div className="flex flex-wrap gap-1.5">
              {PAYMENT_METHODS.map((m) => (
                <label key={m} className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs has-[:checked]:border-primary has-[:checked]:bg-accent">
                  <input type="checkbox" checked={methods.includes(m)} onChange={() => toggle(methods, setMethods, m)} />
                  {METHOD_LABELS[m]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-min">Min amount (minor)</Label>
              <Input id="r-min" name="min" type="number" min={0} defaultValue={rule?.match.minAmountMinor} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-max">Max amount (minor)</Label>
              <Input id="r-max" name="max" type="number" min={0} defaultValue={rule?.match.maxAmountMinor} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-risk">Min risk score</Label>
              <Input id="r-risk" name="risk" type="number" min={0} max={100} defaultValue={rule?.match.minRiskScore} />
            </div>
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || chosen.length === 0}>{busy ? "Saving…" : rule ? "Save rule" : "Add rule"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Strategy({ initial, canEdit }: { initial: { weights: { success: number; cost: number; latency: number }; maxAttempts: number }; canEdit: boolean }) {
  const save = useMutation(api.routing.updateStrategy);
  const sensitive = useSensitive();
  const [w, setW] = useState({ success: Math.round(initial.weights.success * 100), cost: Math.round(initial.weights.cost * 100), latency: Math.round(initial.weights.latency * 100) });
  const [max, setMax] = useState(initial.maxAttempts);
  const total = w.success + w.cost + w.latency || 1;
  return (
    <div className="rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold">Scoring strategy</h2>
      <p className="mt-1 text-sm text-muted-foreground">How much each factor counts when ranking eligible providers. Weights are normalized to 100%.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        {(["success", "cost", "latency"] as const).map((k) => (
          <div key={k} className="space-y-1.5">
            <Label htmlFor={`w-${k}`}>{{ success: "Success rate", cost: "Cost", latency: "Latency" }[k]}</Label>
            <div className="flex items-center gap-2">
              <input id={`w-${k}`} type="range" min={0} max={100} value={w[k]} disabled={!canEdit} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} className="w-full accent-[var(--primary)]" />
              <span className="w-10 text-right text-sm tabular-nums">{Math.round((w[k] / total) * 100)}%</span>
            </div>
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="w-max">Providers per payment</Label>
          <Input id="w-max" type="number" min={1} max={5} value={max} disabled={!canEdit} onChange={(e) => setMax(Number(e.target.value))} />
        </div>
      </div>
      {canEdit && (
        <Button
          className="mt-4"
          size="sm"
          onClick={async () => {
            try {
              await sensitive(() => save({ success: w.success, cost: w.cost, latency: w.latency, maxAttempts: max }));
              toast.success("Strategy saved");
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          Save strategy
        </Button>
      )}
    </div>
  );
}

function Simulator() {
  const [form, setForm] = useState({ amount: "100.00", currency: "USD", method: "card", country: "US" });
  const [args, setArgs] = useState<{ amountMinor: number; currency: string; method: string; country?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const result = useQuery(api.routing.simulate, args ?? "skip");
  return (
    <div className="rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold">Simulate a payment</h2>
      <p className="mt-1 text-sm text-muted-foreground">See which provider your current configuration would choose, and why. No money moves.</p>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const cur = form.currency.trim().toUpperCase();
            setArgs({ amountMinor: decimalToMinor(form.amount, cur), currency: cur, method: form.method, country: form.country.trim().toUpperCase() || undefined });
            setErr(null);
          } catch {
            setErr(`Enter an amount with at most ${currencyDecimals(form.currency.toUpperCase())} decimals.`);
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="s-amt">Amount</Label>
          <Input id="s-amt" value={form.amount} inputMode="decimal" onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="s-cur">Currency</Label>
          <Input id="s-cur" value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="s-m">Method</Label>
          <select id="s-m" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="s-c">Payer country</Label>
          <Input id="s-c" value={form.country} maxLength={2} onChange={(e) => setForm({ ...form, country: e.target.value })} />
        </div>
        <div className="flex items-end">
          <Button type="submit" className="w-full">Run</Button>
        </div>
      </form>
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
      {args && result === undefined && <div className="mt-4"><LoadingRows rows={2} /></div>}
      {result && (
        <div className="mt-5 space-y-3">
          <p className="rounded-md bg-muted p-3 text-sm">{result.explanation}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-2 pr-4 font-medium">Provider</th><th className="py-2 pr-4 font-medium">Score</th><th className="py-2 pr-4 font-medium">Success</th><th className="py-2 pr-4 font-medium">Est. fee</th><th className="py-2 font-medium">Verdict</th></tr>
              </thead>
              <tbody className="divide-y">
                {[...result.evaluations].sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score).map((e) => (
                  <tr key={e.connectionId} className={e.eligible ? "" : "text-muted-foreground"}>
                    <td className="py-2 pr-4 font-medium">{e.displayName}</td>
                    <td className="py-2 pr-4 tabular-nums">{e.eligible ? e.score.toFixed(3) : "—"}</td>
                    <td className="py-2 pr-4 tabular-nums">{(e.components.success * 100).toFixed(1)}%</td>
                    <td className="py-2 pr-4 tabular-nums">{e.estimatedFeeMinor !== null && args ? formatMoney(e.estimatedFeeMinor, args.currency) : "—"}</td>
                    <td className="py-2">{e.reasons.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Routing() {
  const data = useQuery(api.routing.listRules, {});
  const catalog = useQuery(api.providers.catalog, {});
  const decisions = useQuery(api.routing.recentDecisions, { limit: 25 });
  const del = useMutation(api.routing.deleteRule);
  const move = useMutation(api.routing.moveRule);
  const upsert = useMutation(api.routing.upsertRule);
  const sensitive = useSensitive();
  const [editing, setEditing] = useState<RuleRow | null | "new">(null);
  const providers = (catalog ?? []).map((p) => ({ id: p.id, displayName: p.displayName }));

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await sensitive(fn);
      toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Routing"
        description="Control how payments are matched to providers. Every decision is recorded with its reasons."
        actions={data?.canEdit ? <Button onClick={() => setEditing("new")}><Plus className="size-4" /> Add rule</Button> : undefined}
      />

      <section className="space-y-3" aria-labelledby="rules-h">
        <h2 id="rules-h" className="text-lg font-semibold">Rules</h2>
        {data === undefined ? (
          <LoadingRows rows={3} />
        ) : data.rules.length === 0 ? (
          <EmptyState icon={<RouteIcon className="size-5" />} title="No rules yet" description="Without rules, payments go to the best-scoring eligible provider. Add a rule to prefer, exclude or restrict providers for specific traffic." />
        ) : (
          <ol className="divide-y rounded-lg border bg-card">
            {data.rules.map((r, i) => (
              <li key={r._id} className="flex flex-wrap items-center gap-3 p-4">
                <span className="w-6 text-sm tabular-nums text-muted-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{r.name}</div>
                  <div className="text-sm text-muted-foreground">{describeRule(r)}</div>
                </div>
                {data.canEdit && (
                  <div className="flex items-center gap-1">
                    <Switch
                      checked={r.enabled}
                      aria-label={r.enabled ? `Disable ${r.name}` : `Enable ${r.name}`}
                      onCheckedChange={(v: boolean) => void act(() => upsert({ ruleId: r._id, name: r.name, enabled: v, match: r.match, action: r.action }), v ? "Rule enabled" : "Rule disabled")}
                    />
                    <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => void act(() => move({ ruleId: r._id as Id<"routingRules">, direction: "up" }), "Order updated")}><ArrowUp className="size-4" /></Button>
                    <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === data.rules.length - 1} onClick={() => void act(() => move({ ruleId: r._id as Id<"routingRules">, direction: "down" }), "Order updated")}><ArrowDown className="size-4" /></Button>
                    <Button size="icon" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Pencil className="size-4" /></Button>
                    <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} className="text-destructive" onClick={() => void act(() => del({ ruleId: r._id as Id<"routingRules"> }), "Rule deleted")}><Trash2 className="size-4" /></Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {data && <Strategy initial={data.strategy} canEdit={data.canEdit} />}
      <Simulator />

      <section className="space-y-3" aria-labelledby="dec-h">
        <h2 id="dec-h" className="text-lg font-semibold">Recent decisions</h2>
        {decisions === undefined ? (
          <LoadingRows rows={3} />
        ) : decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Decisions appear here as payments are routed.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Time</th><th className="px-4 py-2.5 font-medium">Payment</th><th className="px-4 py-2.5 font-medium">Chain</th><th className="px-4 py-2.5 font-medium">Outcome</th><th className="px-4 py-2.5 font-medium">Why</th></tr>
              </thead>
              <tbody className="divide-y">
                {decisions.map((d) => (
                  <tr key={`${d.at}-${d.transactionId}`} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{new Date(d.at).toLocaleString()}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{d.transactionId ? <a className="text-primary hover:underline" href={`/dashboard/transactions/${d.transactionId}`}>{d.transactionId}</a> : "—"}</td>
                    <td className="px-4 py-2.5">{d.chain.join(" → ") || "none"}{d.failovers > 0 && <span className="ml-1 text-xs text-amber-700">({d.failovers} failover)</span>}</td>
                    <td className="px-4 py-2.5">{d.outcome ? <StatusPill status={d.outcome} /> : "—"}</td>
                    <td className="max-w-md px-4 py-2.5 text-muted-foreground">{d.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && <RuleDialog rule={editing === "new" ? null : editing} providers={providers} onClose={() => setEditing(null)} />}
    </div>
  );
}
