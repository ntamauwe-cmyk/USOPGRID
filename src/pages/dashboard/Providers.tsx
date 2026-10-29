import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, StatusPill, EmptyState, LoadingRows, errorMessage, pct } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { toast } from "sonner";
import { Network, Plus, Copy, ExternalLink, Search } from "lucide-react";

type Catalog = NonNullable<ReturnType<typeof useQuery<typeof api.providers.catalog>>>;
type ProviderInfo = Catalog[number];

function coverageText(p: ProviderInfo) {
  const c = p.countries === "global" ? "Global" : `${p.countries.length} countries`;
  const cur = p.currencies === "all" ? "all currencies" : `${p.currencies.length} currencies`;
  return `${c}, ${cur}`;
}

function AddConnectionDialog({ provider, environment, onClose }: { provider: ProviderInfo; environment: "sandbox" | "production"; onClose: () => void }) {
  const create = useAction(api.providers.createConnection);
  const sensitive = useSensitive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const credentials: Record<string, string> = {};
    for (const c of provider.credentials) {
      const v = String(fd.get(c.key) ?? "").trim();
      if (v) credentials[c.key] = v;
    }
    const pctBps = String(fd.get("pctBps") ?? "").trim();
    const fixedMinor = String(fd.get("fixedMinor") ?? "").trim();
    const fixedCurrency = String(fd.get("fixedCurrency") ?? "").trim().toUpperCase();
    setBusy(true);
    setError(null);
    try {
      await sensitive(() =>
        create({
          providerId: provider.id,
          environment,
          label: String(fd.get("label") ?? ""),
          priority: Number(fd.get("priority") ?? 0) || 0,
          credentials,
          pricing: pctBps ? { pctBps: Math.round(Number(pctBps) * 100), fixedMinor: Math.round(Number(fixedMinor || 0)), fixedCurrency: fixedCurrency || "USD" } : undefined,
        }),
      );
      toast.success(`${provider.displayName} connected. Run a connection test next.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {provider.displayName}</DialogTitle>
          <DialogDescription>
            Credentials are encrypted before they are stored and are never shown again. This connection is for the {environment === "production" ? "live" : "sandbox"} environment.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="label">Name</Label>
            <Input id="label" name="label" defaultValue={`${provider.displayName} ${environment === "production" ? "live" : "test"}`} maxLength={80} />
          </div>
          {provider.credentials.map((c) => (
            <div className="space-y-1.5" key={c.key}>
              <Label htmlFor={`cred-${c.key}`}>
                {c.label}
                {!c.required && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
              </Label>
              <Input id={`cred-${c.key}`} name={c.key} type={c.secret ? "password" : "text"} autoComplete="off" required={c.required} spellCheck={false} />
              {c.help && <p className="text-xs text-muted-foreground">{c.help}</p>}
            </div>
          ))}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="priority">Priority</Label>
              <Input id="priority" name="priority" type="number" min={-100} max={100} defaultValue={0} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pctBps">Agreed fee %</Label>
              <Input id="pctBps" name="pctBps" type="number" step="0.01" min={0} max={50} placeholder={(provider.pricing.pctBps / 100).toFixed(2)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fixedMinor">Fixed (minor)</Label>
              <Input id="fixedMinor" name="fixedMinor" type="number" min={0} placeholder={String(provider.pricing.fixedMinor)} />
            </div>
          </div>
          <input type="hidden" name="fixedCurrency" value={provider.pricing.fixedCurrency} />
          <p className="text-xs text-muted-foreground">Leave pricing blank to use list pricing ({provider.pricing.notes}). Agreed pricing makes cost-aware routing accurate.</p>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Connecting…" : "Connect provider"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Providers() {
  const ctx = useQuery(api.orgs.getOrgContext, {});
  const catalog = useQuery(api.providers.catalog, {});
  const conns = useQuery(api.providers.listConnections, {});
  const update = useMutation(api.providers.updateConnection);
  const remove = useMutation(api.providers.deleteConnection);
  const test = useAction(api.providers.testConnection);
  const sensitive = useSensitive();
  const [adding, setAdding] = useState<ProviderInfo | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const canManage = ctx?.permissions.includes("providers:manage") ?? false;

  const visibleCatalog = useMemo(
    () => (catalog ?? []).filter((p) => p.category !== "sandbox" && `${p.displayName} ${p.description}`.toLowerCase().includes(q.toLowerCase())),
    [catalog, q],
  );

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await sensitive(fn);
      toast.success(label);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const env = conns?.environment ?? "sandbox";
  return (
    <div className="space-y-8">
      <PageHeader
        title="Providers"
        description={`Payment providers available to the router in the ${env === "production" ? "live" : "sandbox"} environment. Switch environment under Organization.`}
      />

      <section aria-labelledby="conn-h" className="space-y-3">
        <h2 id="conn-h" className="text-lg font-semibold">Connections</h2>
        {conns === undefined ? (
          <LoadingRows />
        ) : conns.connections.length === 0 ? (
          <EmptyState icon={<Network className="size-5" />} title="No providers connected" description="Connect a provider below to start routing live payments in this environment." />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Connection</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Circuit</th>
                  <th className="px-4 py-2.5 font-medium">Today</th>
                  <th className="px-4 py-2.5 font-medium">Priority</th>
                  <th className="px-4 py-2.5 font-medium">Routing</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {conns.connections.map((c) => (
                  <tr key={c.connectionKey} className="align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{c.displayName}</div>
                      <div className="text-xs text-muted-foreground">{c.label}</div>
                      {Object.entries(c.credentialHints).length > 0 && (
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">{Object.values(c.credentialHints).join("  ")}</div>
                      )}
                      {c.webhookUrl && (
                        <button
                          className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          onClick={() => {
                            void navigator.clipboard.writeText(c.webhookUrl!);
                            toast.success("Webhook URL copied. Paste it into the provider's dashboard.");
                          }}
                        >
                          <Copy className="size-3" /> Copy webhook URL
                        </button>
                      )}
                      {c.lastError && <div className="mt-1 max-w-xs text-xs text-destructive">{c.lastError}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={c.status} />
                      <div className="mt-1 text-xs text-muted-foreground">{c.source === "platform" ? "Platform" : "Your account"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={c.circuit.state} />
                      {c.circuit.state !== "closed" && c.circuit.reason && <div className="mt-1 max-w-[14rem] text-xs text-muted-foreground">{c.circuit.reason}</div>}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {c.today ? (
                        <>
                          <div>{c.today.attempts} attempts</div>
                          <div className="text-xs text-muted-foreground">
                            {pct(c.today.successRate)} ok, {c.today.avgLatencyMs ?? "—"} ms
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">No traffic</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.source === "organization" && canManage ? (
                        <Input
                          aria-label={`Priority for ${c.label}`}
                          type="number"
                          min={-100}
                          max={100}
                          defaultValue={c.priority}
                          className="h-8 w-20"
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== c.priority) void run("Priority updated", () => update({ connectionKey: c.connectionKey, priority: v }));
                          }}
                        />
                      ) : (
                        <span className="tabular-nums">{c.priority}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.source === "organization" ? (
                        <Switch
                          checked={c.enabled}
                          disabled={!canManage}
                          aria-label={`${c.enabled ? "Disable" : "Enable"} ${c.label}`}
                          onCheckedChange={(v: boolean) => void run(v ? "Connection enabled" : "Connection disabled", () => update({ connectionKey: c.connectionKey, enabled: v }))}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">Always on</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {c.source === "organization" && canManage && (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={testing === c.connectionKey}
                            onClick={async () => {
                              setTesting(c.connectionKey);
                              try {
                                const r = await test({ connectionKey: c.connectionKey });
                                if (r.ok) toast.success(r.message);
                                else toast.error(r.message);
                              } catch (err) {
                                toast.error(errorMessage(err));
                              } finally {
                                setTesting(null);
                              }
                            }}
                          >
                            {testing === c.connectionKey ? "Testing…" : "Test"}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRevoking(c.connectionKey)}>
                            Revoke
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="cat-h" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="cat-h" className="text-lg font-semibold">Add a provider</h2>
            <p className="text-sm text-muted-foreground">Use your own merchant account with any provider below. The router includes it automatically.</p>
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search providers" placeholder="Search providers" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {catalog === undefined ? (
          <LoadingRows rows={3} />
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            {visibleCatalog.map((p) => (
              <div key={p.id} className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="min-w-0 max-w-2xl">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.displayName}</span>
                    <a href={p.docsUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label={`${p.displayName} API documentation`}>
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{p.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {coverageText(p)}. {p.methods.map((m) => m.label).join(", ")}.
                  </p>
                </div>
                <Button size="sm" disabled={!canManage} onClick={() => setAdding(p)} title={canManage ? undefined : "You need the providers permission"}>
                  <Plus className="size-4" /> Connect
                </Button>
              </div>
            ))}
            {visibleCatalog.length === 0 && <p className="p-6 text-sm text-muted-foreground">No provider matches “{q}”.</p>}
          </div>
        )}
      </section>

      {adding && <AddConnectionDialog provider={adding} environment={env} onClose={() => setAdding(null)} />}
      <AlertDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              Its stored credentials are destroyed and the router stops using it immediately. Past payments keep their history. Refunds for payments it processed will need a new connection to the same provider account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connection</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const key = revoking!;
                setRevoking(null);
                void run("Connection revoked", () => remove({ connectionKey: key }));
              }}
            >
              Revoke connection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
