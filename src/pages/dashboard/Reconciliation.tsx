import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, StatusPill, EmptyState, LoadingRows, errorMessage, NoAccess } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import { toast } from "sonner";
import { Scale, Upload, CheckCircle2 } from "lucide-react";

const TYPE_LABELS: Record<string, string> = {
  missing_settlement: "Missing settlement",
  amount_mismatch: "Amount mismatch",
  ledger_vs_bank_mismatch: "Ledger vs bank",
  unexplained_bank_entry: "Unexplained bank entry",
  duplicate: "Duplicate in report",
  missing_in_provider_report: "Not in provider report",
  missing_in_usopgrid: "Not in USOPGRID",
  currency_mismatch: "Currency mismatch",
  fee_discrepancy: "Fee discrepancy",
  status_mismatch: "Status mismatch",
  late_provider_success: "Late provider success",
  unknown_outcome_expired: "Outcome never confirmed",
};

function UploadDialog({ providers, onClose }: { providers: { id: string; displayName: string }[]; onClose: () => void }) {
  const ingest = useMutation(api.reconciliation.ingestReport);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ rows: number; matched: number; exceptions: number; parseErrors: string[] } | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file") as File | null;
    if (!file || file.size === 0) return setError("Choose the provider's settlement report (CSV).");
    if (file.size > 4_000_000) return setError("The file is larger than 4 MB. Export a shorter date range.");
    setBusy(true);
    setError(null);
    try {
      const csv = await file.text();
      const r = await ingest({
        provider: String(fd.get("provider")),
        filename: file.name,
        csv,
        amountsIn: fd.get("amountsIn") === "minor" ? "minor" : "major",
        defaultCurrency: String(fd.get("currency") ?? "").trim() || undefined,
        periodStart: Date.parse(`${fd.get("from")}T00:00:00Z`),
        periodEnd: Date.parse(`${fd.get("to")}T23:59:59Z`),
      });
      setResult(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reconcile a settlement report</DialogTitle>
          <DialogDescription>Upload the provider's settlement or balance report. Each line is matched to a payment by provider reference.</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3" role="status">
            <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-5 text-emerald-600" /> Reconciliation complete</p>
            <p className="text-sm text-muted-foreground">{result.rows} lines read, {result.matched} matched, {result.exceptions} exceptions raised.</p>
            {result.parseErrors.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer">{result.parseErrors.length} lines could not be read</summary>
                <ul className="mt-2 list-disc pl-5 text-muted-foreground">{result.parseErrors.map((e) => <li key={e}>{e}</li>)}</ul>
              </details>
            )}
            <DialogFooter><Button onClick={onClose}>Review exceptions</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="rc-p">Provider</Label>
              <select id="rc-p" name="provider" className="h-9 w-full rounded-md border bg-background px-2 text-sm" required>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label htmlFor="rc-f">From</Label><Input id="rc-f" type="date" name="from" defaultValue={weekAgo} required /></div>
              <div className="space-y-1.5"><Label htmlFor="rc-t">To</Label><Input id="rc-t" type="date" name="to" defaultValue={today} required /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rc-a">Amounts in the file are</Label>
                <select id="rc-a" name="amountsIn" className="h-9 w-full rounded-md border bg-background px-2 text-sm" defaultValue="major">
                  <option value="major">Decimals (12.50)</option>
                  <option value="minor">Minor units (1250)</option>
                </select>
              </div>
              <div className="space-y-1.5"><Label htmlFor="rc-c">Default currency</Label><Input id="rc-c" name="currency" maxLength={3} placeholder="If no currency column" /></div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc-file">Report file (CSV)</Label>
              <Input id="rc-file" name="file" type="file" accept=".csv,text/csv" required />
              <p className="text-xs text-muted-foreground">Needs a reference column (id, reference, psp_reference…) and an amount column. Fee and status columns are used when present.</p>
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy}><Upload className="size-4" /> {busy ? "Reconciling…" : "Reconcile"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({ id, onClose }: { id: Id<"reconExceptions">; onClose: () => void }) {
  const resolve = useMutation(api.reconciliation.resolveException);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go(status: "resolved" | "acknowledged") {
    setBusy(true);
    setError(null);
    try {
      await resolve({ exceptionId: id, status, resolution: note });
      toast.success(status === "resolved" ? "Exception resolved" : "Exception acknowledged");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve exception</DialogTitle>
          <DialogDescription>Record what you found and what you did. The note is kept in the audit log.</DialogDescription>
        </DialogHeader>
        <Label htmlFor="rs-note" className="sr-only">Resolution note</Label>
        <Textarea id="rs-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Provider fee corrected on 3 Nov statement; difference posted as adjustment ADJ-221." />
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void go("acknowledged")}>Acknowledge</Button>
          <Button disabled={busy || note.trim().length < 5} onClick={() => void go("resolved")}>Mark resolved</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Reconciliation() {
  const ctx = useQuery(api.orgs.getOrgContext, {});
  const canView = ctx?.permissions.includes("settlement:view");
  const canManage = ctx?.permissions.includes("reconciliation:manage") ?? false;
  const [status, setStatus] = useState<"open" | "resolved" | "acknowledged">("open");
  const runs = useQuery(api.reconciliation.listRuns, canView ? {} : "skip");
  const exceptions = useQuery(api.reconciliation.listExceptions, canView ? { status } : "skip");
  const catalog = useQuery(api.providers.catalog, {});
  const [uploading, setUploading] = useState(false);
  const [resolving, setResolving] = useState<Id<"reconExceptions"> | null>(null);
  const providers = (catalog ?? []).map((p) => ({ id: p.id, displayName: p.displayName }));

  if (ctx && !canView) return <NoAccess what="reconciliation" />;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reconciliation"
        description="Match provider settlement reports against USOPGRID's records. Every discrepancy is an exception until someone resolves it."
        actions={canManage ? <Button onClick={() => setUploading(true)}><Upload className="size-4" /> Upload report</Button> : undefined}
      />

      <section className="space-y-3" aria-labelledby="ex-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="ex-h" className="text-lg font-semibold">Exceptions</h2>
          <div className="flex gap-1" role="tablist" aria-label="Exception status">
            {(["open", "acknowledged", "resolved"] as const).map((s) => (
              <Button key={s} size="sm" role="tab" aria-selected={status === s} variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>
        </div>
        {exceptions === undefined ? (
          <LoadingRows />
        ) : exceptions.length === 0 ? (
          <EmptyState icon={<Scale className="size-5" />} title={status === "open" ? "Nothing to reconcile" : `No ${status} exceptions`} description={status === "open" ? "Upload a provider settlement report to check it against your records." : "Exceptions you close appear here with their resolution notes."} />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Raised</th><th className="px-4 py-2.5 font-medium">Type</th><th className="px-4 py-2.5 font-medium">Payment</th><th className="px-4 py-2.5 font-medium">Expected</th><th className="px-4 py-2.5 font-medium">Reported</th><th className="px-4 py-2.5 font-medium">Detail</th><th className="px-4 py-2.5" /></tr>
              </thead>
              <tbody className="divide-y">
                {exceptions.map((x) => (
                  <tr key={x._id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{new Date(x.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{TYPE_LABELS[x.type] ?? x.type}</div>
                      <div className={x.severity === "high" ? "text-xs text-red-700" : "text-xs text-muted-foreground"}>{x.severity} severity</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {x.transactionId ? <a className="text-primary hover:underline" href={`/dashboard/transactions/${x.transactionId}`}>{x.transactionId}</a> : "—"}
                      {x.providerReference && <div className="text-muted-foreground">{x.providerReference}</div>}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{x.ledgerAmountMinor !== undefined && x.currency ? formatMoney(x.ledgerAmountMinor, x.currency) : "—"}</td>
                    <td className="px-4 py-3 tabular-nums">{x.bankAmountMinor !== undefined && x.currency ? formatMoney(x.bankAmountMinor, x.currency) : "—"}</td>
                    <td className="max-w-sm px-4 py-3 text-muted-foreground">
                      {x.detail}
                      {x.resolution && <div className="mt-1 text-foreground">Resolution: {x.resolution}</div>}
                    </td>
                    <td className="px-4 py-3 text-right">{x.status === "open" && canManage && <Button size="sm" variant="outline" onClick={() => setResolving(x._id)}>Resolve</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="runs-h">
        <h2 id="runs-h" className="text-lg font-semibold">Report runs</h2>
        {runs === undefined ? (
          <LoadingRows rows={2} />
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports reconciled yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="px-4 py-2.5 font-medium">Run</th><th className="px-4 py-2.5 font-medium">Provider</th><th className="px-4 py-2.5 font-medium">Period</th><th className="px-4 py-2.5 font-medium">Lines</th><th className="px-4 py-2.5 font-medium">Matched</th><th className="px-4 py-2.5 font-medium">Exceptions</th><th className="px-4 py-2.5 font-medium">Status</th></tr>
              </thead>
              <tbody className="divide-y">
                {runs.map((r) => (
                  <tr key={r._id}>
                    <td className="px-4 py-2.5"><div>{r.source}</div><div className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</div></td>
                    <td className="px-4 py-2.5">{r.provider}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.periodStart ? new Date(r.periodStart).toLocaleDateString() : "—"} to {r.periodEnd ? new Date(r.periodEnd).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.rows}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.matched}</td>
                    <td className={r.exceptions ? "px-4 py-2.5 tabular-nums text-red-700" : "px-4 py-2.5 tabular-nums"}>{r.exceptions}</td>
                    <td className="px-4 py-2.5"><StatusPill status={r.status === "completed" ? "SETTLED" : "FAILED"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {uploading && <UploadDialog providers={providers} onClose={() => setUploading(false)} />}
      {resolving && <ResolveDialog id={resolving} onClose={() => setResolving(null)} />}
    </div>
  );
}
