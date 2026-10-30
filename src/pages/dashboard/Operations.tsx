import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, StatusPill, StatCard, LoadingRows, errorMessage, isStepUpError, pct } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { formatMoney } from "@/lib/money";
import { toast } from "sonner";
import { CheckCircle2, XCircle } from "lucide-react";

/** Operator writes always require a fresh authenticator code (step-up). */
function useAct() {
  const sensitive = useSensitive();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await sensitive(fn);
      toast.success(ok);
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    }
  };
}

function Health() {
  const h = useQuery(api.ops.systemHealth, {});
  const reset = useMutation(api.ops.resetCircuit);
  const act = useAct();
  if (h === undefined) return <LoadingRows rows={6} />;
  return (
    <div className="space-y-6">
      <ul className="divide-y rounded-lg border bg-card">
        {h.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-3 p-3">
            {c.ok ? <CheckCircle2 className="mt-0.5 size-5 text-status-success" aria-label="Healthy" /> : <XCircle className="mt-0.5 size-5 text-status-failed" aria-label="Needs attention" />}
            <div><div className="text-sm font-medium">{c.label}</div><div className="text-sm text-muted-foreground">{c.detail}</div></div>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <StatCard label="Recovery open" value={h.queues.recoveryOpen} />
        <StatCard label="Recovery overdue" value={h.queues.recoveryOverdue} tone={h.queues.recoveryOverdue ? "bad" : "good"} />
        <StatCard label="Webhooks pending" value={h.queues.webhooksPending} />
        <StatCard label="Webhooks retrying" value={h.queues.webhooksRetrying} tone={h.queues.webhooksRetrying ? "warn" : undefined} />
        <StatCard label="Dead letters" value={h.queues.webhooksDead} tone={h.queues.webhooksDead ? "bad" : "good"} />
        <StatCard label="Rejected provider events (24h)" value={h.queues.rejectedProviderEvents24h} tone={h.queues.rejectedProviderEvents24h ? "warn" : undefined} />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="px-4 py-2.5 font-medium">Provider</th><th className="px-4 py-2.5 font-medium">Attempts today</th><th className="px-4 py-2.5 font-medium">Success</th><th className="px-4 py-2.5 font-medium">Errors</th><th className="px-4 py-2.5 font-medium">Avg latency</th><th className="px-4 py-2.5 font-medium">Circuits</th></tr>
          </thead>
          <tbody className="divide-y">
            {h.providers.map((p) => (
              <tr key={p.id} className="align-top">
                <td className="px-4 py-2.5"><div className="font-medium">{p.name}</div>{p.lastError && <div className="max-w-xs text-xs text-muted-foreground">Last error: {p.lastError}</div>}</td>
                <td className="px-4 py-2.5 tabular-nums">{p.attemptsToday}</td>
                <td className="px-4 py-2.5 tabular-nums">{pct(p.successRate)}</td>
                <td className={p.errorRate && p.errorRate > 0.05 ? "px-4 py-2.5 tabular-nums text-status-failed" : "px-4 py-2.5 tabular-nums"}>{pct(p.errorRate)}</td>
                <td className="px-4 py-2.5 tabular-nums">{p.avgLatencyMs ?? "—"} ms</td>
                <td className="px-4 py-2.5">
                  {p.circuits.length === 0 ? <span className="text-muted-foreground">—</span> : (
                    <ul className="space-y-1">
                      {p.circuits.map((c) => (
                        <li key={c.connectionId} className="flex items-center gap-2">
                          <StatusPill status={c.state} />
                          <span className="max-w-[10rem] truncate font-mono text-[11px] text-muted-foreground" title={c.connectionId}>{c.connectionId}</span>
                          {c.state !== "closed" && <Button size="sm" variant="ghost" onClick={() => void act(() => reset({ connectionId: c.connectionId }), "Circuit closed")}>Reset</Button>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">FX: {h.fx ? `${h.fx.source}, ${h.fx.currencies} currencies, rates from ${new Date(h.fx.sourceTimestamp).toLocaleString()}` : "no snapshot yet"}. Generated {new Date(h.generatedAt).toLocaleTimeString()}.</p>
    </div>
  );
}

type RecoveryRow = NonNullable<FunctionReturnType<typeof api.ops.recoveryQueue>>["open"][number];

function RecoveryRows({ rows, canExpedite, onExpedite }: { rows: RecoveryRow[]; canExpedite: boolean; onExpedite: (id: Id<"recoveryJobs">) => void }) {
  return (

    rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Empty.</p> : (
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2 font-medium">Payment</th><th className="px-4 py-2 font-medium">Kind</th><th className="px-4 py-2 font-medium">Provider</th><th className="px-4 py-2 font-medium">Checks</th><th className="px-4 py-2 font-medium">Next / deadline</th><th className="px-4 py-2 font-medium">Last result</th><th /></tr></thead>
        <tbody className="divide-y">
          {rows.map((j) => (
            <tr key={j._id}>
              <td className="px-4 py-2"><span className="font-mono text-xs">{j.transactionId}</span><div className="text-xs text-muted-foreground">{j.amountMinor !== null && j.currency ? formatMoney(j.amountMinor, j.currency) : ""} {j.txStatus}</div></td>
              <td className="px-4 py-2">{j.kind.replace(/_/g, " ")}</td>
              <td className="px-4 py-2">{j.providerId}</td>
              <td className="px-4 py-2 tabular-nums">{j.checksDone}</td>
              <td className="px-4 py-2 text-xs text-muted-foreground">{new Date(j.nextCheckAt).toLocaleString()}<br />{new Date(j.deadlineAt).toLocaleString()}</td>
              <td className="max-w-xs px-4 py-2 text-xs text-muted-foreground">{j.lastResult ?? "—"}</td>
              <td className="px-4 py-2 text-right">{canExpedite && <Button size="sm" variant="outline" onClick={() => onExpedite(j._id as Id<"recoveryJobs">)}>Check now</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ));
}

function Recovery() {
  const q = useQuery(api.ops.recoveryQueue, {});
  const expedite = useMutation(api.ops.expediteRecovery);
  const act = useAct();
  if (q === undefined) return <LoadingRows />;
  return (
    <div className="space-y-6">
      <section><h3 className="mb-2 text-sm font-semibold">Open ({q.open.length})</h3><div className="overflow-x-auto rounded-lg border bg-card"><RecoveryRows rows={q.open} canExpedite onExpedite={(id) => void act(() => expedite({ jobId: id }), "Check scheduled now")} /></div></section>
      <section><h3 className="mb-2 text-sm font-semibold">Escalated to finance</h3><div className="overflow-x-auto rounded-lg border bg-card"><RecoveryRows rows={q.escalated} canExpedite={false} onExpedite={() => undefined} /></div></section>
    </div>
  );
}

function DeadLetters() {
  const rows = useQuery(api.ops.deadLetters, {});
  const replay = useMutation(api.ops.replayDeadLetter);
  const act = useAct();
  if (rows === undefined) return <LoadingRows />;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No dead-lettered webhooks.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2 font-medium">Event</th><th className="px-4 py-2 font-medium">Organization</th><th className="px-4 py-2 font-medium">Endpoint</th><th className="px-4 py-2 font-medium">Attempts</th><th className="px-4 py-2 font-medium">Last error</th><th /></tr></thead>
        <tbody className="divide-y">
          {rows.map((d) => (
            <tr key={d._id}>
              <td className="px-4 py-2 font-mono text-xs">{d.event}</td>
              <td className="px-4 py-2">{d.org}</td>
              <td className="max-w-[16rem] truncate px-4 py-2 text-xs" title={d.url}>{d.url}</td>
              <td className="px-4 py-2 tabular-nums">{d.attempts}</td>
              <td className="px-4 py-2 text-xs text-muted-foreground">{d.responseStatus ? `HTTP ${d.responseStatus}` : d.lastError}</td>
              <td className="px-4 py-2 text-right"><Button size="sm" variant="outline" onClick={() => void act(() => replay({ deliveryId: d._id }), "Delivery re-queued")}>Replay</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProviderEvents() {
  const [outcome, setOutcome] = useState<string>("");
  const rows = useQuery(api.ops.providerEvents, outcome ? { outcome } : {});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {["", "applied", "noop", "stale", "exception", "unmatched", "rejected"].map((o) => (
          <Button key={o || "all"} size="sm" variant={outcome === o ? "default" : "outline"} onClick={() => setOutcome(o)}>{o || "All"}</Button>
        ))}
      </div>
      {rows === undefined ? <LoadingRows /> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No inbound provider events.</p> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2 font-medium">Received</th><th className="px-4 py-2 font-medium">Provider</th><th className="px-4 py-2 font-medium">Type</th><th className="px-4 py-2 font-medium">Verified</th><th className="px-4 py-2 font-medium">Outcome</th><th className="px-4 py-2 font-medium">Detail</th></tr></thead>
            <tbody className="divide-y">
              {rows.map((e) => (
                <tr key={e._id}>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">{new Date(e.receivedAt).toLocaleString()}</td>
                  <td className="px-4 py-2">{e.providerId}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.rawType}</td>
                  <td className="px-4 py-2">{e.verified ? "Yes" : <span className="text-status-failed">No</span>}</td>
                  <td className="px-4 py-2">{e.outcome}</td>
                  <td className="max-w-sm px-4 py-2 text-xs text-muted-foreground">{e.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Orgs() {
  const orgs = useQuery(api.ops.organizations, {});
  const setStatus = useMutation(api.ops.setOrgStatus);
  const act = useAct();
  const leads = useQuery(api.contact.listLeads, {});
  if (orgs === undefined) return <LoadingRows />;
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2 font-medium">Organization</th><th className="px-4 py-2 font-medium">Country</th><th className="px-4 py-2 font-medium">Env</th><th className="px-4 py-2 font-medium">Members</th><th className="px-4 py-2 font-medium">Last payment</th><th className="px-4 py-2 font-medium">Status</th></tr></thead>
          <tbody className="divide-y">
            {orgs.map((o) => (
              <tr key={o._id}>
                <td className="px-4 py-2"><div className="font-medium">{o.name}</div><div className="font-mono text-[11px] text-muted-foreground">{o.slug}</div></td>
                <td className="px-4 py-2">{o.country ?? "—"}</td>
                <td className="px-4 py-2">{o.environment}</td>
                <td className="px-4 py-2 tabular-nums">{o.members}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{o.lastPaymentAt ? new Date(o.lastPaymentAt).toLocaleString() : "—"}</td>
                <td className="px-4 py-2">
                  <select
                    aria-label={`Status for ${o.name}`}
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={o.status}
                    onChange={(e) => {
                      const status = e.target.value as "active" | "restricted" | "suspended";
                      const reason = window.prompt(`Reason for setting ${o.name} to ${status}`);
                      if (reason) void act(() => setStatus({ orgId: o._id, status, reason }), "Organization status updated");
                    }}
                  >
                    <option value="active">active</option><option value="restricted">restricted</option><option value="suspended">suspended</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Enterprise enquiries</h3>
        {leads === undefined ? <LoadingRows rows={2} /> : leads.length === 0 ? <p className="text-sm text-muted-foreground">No enquiries yet.</p> : (
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {leads.map((l) => (
              <li key={l._id} className="p-3"><div className="font-medium">{l.company} <span className="font-normal text-muted-foreground">{l.name} &lt;{l.email}&gt;</span></div><div className="text-xs text-muted-foreground">{new Date(l.createdAt).toLocaleString()} {l.country ?? ""} {l.volume ?? ""}</div>{l.message && <p className="mt-1">{l.message}</p>}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Flags() {
  const flags = useQuery(api.ops.listFlags, {});
  const setFlag = useMutation(api.ops.setFlag);
  const act = useAct();
  const [key, setKey] = useState("");
  return (
    <div className="space-y-4">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => setFlag({ key, enabled: false, description: "" }), "Flag created"); setKey(""); }}>
        <Input aria-label="New flag key" placeholder="new.flag_key" value={key} onChange={(e) => setKey(e.target.value)} className="max-w-xs" />
        <Button type="submit" variant="outline" disabled={!key}>Add flag</Button>
      </form>
      {flags === undefined ? <LoadingRows rows={2} /> : flags.length === 0 ? <p className="text-sm text-muted-foreground">No feature flags.</p> : (
        <ul className="divide-y rounded-lg border bg-card">
          {flags.map((f) => (
            <li key={f._id} className="flex items-center justify-between gap-3 p-3">
              <div><div className="font-mono text-sm">{f.key}</div><div className="text-xs text-muted-foreground">{f.description || "No description"}{f.updatedBy ? `, last changed by ${f.updatedBy}` : ""}</div></div>
              <Switch checked={f.enabled} aria-label={`Toggle ${f.key}`} onCheckedChange={(v: boolean) => void act(() => setFlag({ key: f.key, enabled: v }), v ? "Flag on" : "Flag off")} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Audit() {
  const rows = useQuery(api.ops.platformAudit, {});
  const alerts = useQuery(api.ops.platformAlerts, {});
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Platform alerts</h3>
        {alerts === undefined ? <LoadingRows rows={3} /> : alerts.length === 0 ? <p className="text-sm text-muted-foreground">No alerts.</p> : (
          <ul className="divide-y rounded-lg border bg-card text-sm">{alerts.map((a) => <li key={a._id} className="p-3"><div className="font-medium">{a.title}</div><div className="text-muted-foreground">{a.body}</div><div className="text-xs text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</div></li>)}</ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Operator and security audit</h3>
        {rows === undefined ? <LoadingRows rows={3} /> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No entries.</p> : (
          <ul className="divide-y rounded-lg border bg-card text-sm">{rows.map((r) => <li key={r._id} className="p-3"><span className="font-mono text-xs">{r.action}</span> <span className="text-muted-foreground">by {r.actor}</span><div className="text-xs text-muted-foreground">{new Date(r.at).toLocaleString()}</div></li>)}</ul>
        )}
      </section>
    </div>
  );
}

type KeyReport = { activeKeyId: string; byKey: Record<string, number>; resealed: number; failed: number; skipped: number };

function RateLimits() {
  const setLimit = useMutation(api.ops.setApiKeyRateLimit);
  const act = useAct();
  const [prefix, setPrefix] = useState("");
  const [limit, setLimit_] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-4 text-sm">
      <p className="max-w-2xl text-muted-foreground">
        Every API key may make 120 requests a minute. Raise it for an enterprise customer or a load-test key, or set it back to the default. Customers cannot change this themselves.
      </p>
      <form
        className="grid max-w-xl gap-3 sm:grid-cols-[1fr_8rem]"
        onSubmit={(e) => {
          e.preventDefault();
          const perMinute = limit.trim() === "" ? null : Number(limit);
          void act(() => setLimit({ keyPrefix: prefix, perMinute, reason }), perMinute === null ? "Back to the default 120 a minute" : `Limit set to ${perMinute} a minute`);
        }}
      >
        <Input aria-label="Key prefix" placeholder="Key prefix, e.g. sk_sandbox_ab12cd" value={prefix} onChange={(e) => setPrefix(e.target.value)} className="font-mono" />
        <Input aria-label="Requests per minute" inputMode="numeric" placeholder="per minute" value={limit} onChange={(e) => setLimit_(e.target.value.replace(/\D/g, ""))} />
        <Input aria-label="Reason" placeholder="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} className="sm:col-span-2" />
        <Button type="submit" disabled={!prefix || reason.trim().length < 5} className="sm:w-fit">Save limit</Button>
      </form>
      <p className="text-xs text-muted-foreground">Leave the limit empty to restore the default. Allowed range: 10 to 6,000 a minute.</p>
    </div>
  );
}

function Keys() {
  const status = useAction(api.keyRotation.status);
  const reseal = useAction(api.keyRotation.resealAll);
  const sensitive = useSensitive();
  const [report, setReport] = useState<KeyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<KeyReport>) => {
    setBusy(true);
    try {
      setReport(await sensitive(fn));
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const stale = report ? Object.entries(report.byKey).filter(([k]) => k !== report.activeKeyId).reduce((n, [, c]) => n + c, 0) : 0;
  return (
    <div className="space-y-4 text-sm">
      <p className="max-w-2xl text-muted-foreground">
        Provider credentials, authenticator secrets and payout account numbers are encrypted with the active key. To rotate: add a new key to
        <code className="mx-1 rounded bg-muted px-1">USOPGRID_ENCRYPTION_KEYS</code>, set
        <code className="mx-1 rounded bg-muted px-1">USOPGRID_ENCRYPTION_KEY_ID</code> to it, re-encrypt here, then remove the old key when nothing is left on it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void run(() => status({}))}>Check key usage</Button>
        <Button disabled={busy} onClick={() => void run(() => reseal({}))}>Re-encrypt with active key</Button>
      </div>
      {report && (
        <div className="rounded-lg border p-4">
          <p>
            Active key: <span className="font-mono">{report.activeKeyId}</span>
            {report.resealed + report.failed + report.skipped > 0 && <> · re-encrypted {report.resealed}, failed {report.failed}, changed during run {report.skipped}</>}
          </p>
          <ul className="mt-2 space-y-1">
            {Object.entries(report.byKey).map(([k, n]) => (
              <li key={k} className="font-mono text-xs">{k}: {n} secret{n === 1 ? "" : "s"}{k === report.activeKeyId ? " (active)" : ""}</li>
            ))}
          </ul>
          <p className={`mt-2 text-xs ${stale ? "text-status-pending" : "text-status-success"}`}>
            {stale ? `${stale} secret(s) still on an older key. Keep that key configured until this reaches zero.` : "Everything is on the active key. Older keys can be removed."}
          </p>
        </div>
      )}
    </div>
  );
}

export default function Operations() {
  const who = useQuery(api.ops.whoami, {});
  if (who === undefined) return <LoadingRows />;
  if (!who.isPlatformAdmin) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm font-semibold">The operations console is for USOPGRID staff</p>
        <p className="mt-1 text-sm text-muted-foreground">Platform operators are configured with USOPGRID_PLATFORM_ADMINS on the deployment.</p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Operations console" description={`Platform-wide health and controls. Signed in as ${who.email}; every action is audited.`} />
      <Tabs defaultValue="health">
        <TabsList className="flex-wrap">
          <TabsTrigger value="health">System health</TabsTrigger>
          <TabsTrigger value="recovery">Recovery queue</TabsTrigger>
          <TabsTrigger value="webhooks">Dead letters</TabsTrigger>
          <TabsTrigger value="events">Provider events</TabsTrigger>
          <TabsTrigger value="orgs">Organizations</TabsTrigger>
          <TabsTrigger value="flags">Feature flags</TabsTrigger>
          <TabsTrigger value="audit">Alerts & audit</TabsTrigger>
          <TabsTrigger value="keys">Encryption keys</TabsTrigger>
          <TabsTrigger value="limits">API rate limits</TabsTrigger>
        </TabsList>
        <TabsContent value="health" className="pt-4"><Health /></TabsContent>
        <TabsContent value="recovery" className="pt-4"><Recovery /></TabsContent>
        <TabsContent value="webhooks" className="pt-4"><DeadLetters /></TabsContent>
        <TabsContent value="events" className="pt-4"><ProviderEvents /></TabsContent>
        <TabsContent value="orgs" className="pt-4"><Orgs /></TabsContent>
        <TabsContent value="flags" className="pt-4"><Flags /></TabsContent>
        <TabsContent value="audit" className="pt-4"><Audit /></TabsContent>
        <TabsContent value="keys" className="pt-4"><Keys /></TabsContent>
        <TabsContent value="limits" className="pt-4"><RateLimits /></TabsContent>
      </Tabs>
    </div>
  );
}
