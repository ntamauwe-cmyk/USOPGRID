// USOPGRID settlements page: batches, ledger balances, bank
// records and reconciliation — finance teams work from one transaction truth.
import { useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader, StatusPill, EmptyState, KeyValue } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Landmark,
  Loader2,
  RefreshCw,
  Building2,
  AlertOctagon,
  Wallet,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

export default function Settlements() {
  const summary = useQuery(api.services.getSettlementSummary, {});
  const batches = useQuery(api.services.listSettlementBatches, {
    paginationOpts: { numItems: 15, cursor: null },
  });
  const exceptions = useQuery(api.services.listReconExceptions, {});
  const bankRecords = useQuery(api.services.listBankRecords, {});
  const merchants = useQuery(api.orgs.listMerchants, {});

  const buildBatch = useAction(api.services.buildSettlementBatch);
  const settleBatch = useAction(api.services.settleSettlementBatch);
  const runRecon = useAction(api.services.runReconciliation);
  const resolveException = useMutation(api.services.resolveReconException);

  const [busy, setBusy] = useState<string | null>(null);

  const totalBalance = summary?.balances.reduce((acc, b) => acc + b.balanceMinor, 0) ?? 0;

  async function handleBuild(merchantId: Id<"merchants">, currency: string) {
    setBusy("build");
    try {
      const r = await buildBatch({ merchantId, currency });
      if (r.created) toast.success(`Settlement batch ${r.reference} built.`);
      else toast.info(r.reason ?? "Nothing eligible to settle yet.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to build batch");
    } finally {
      setBusy(null);
    }
  }

  async function handleSettle(batchId: Id<"settlementBatches">) {
    setBusy(batchId);
    try {
      await settleBatch({ batchId });
      toast.success("Batch marked settled and ledger moved to settlement payable.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to settle batch");
    } finally {
      setBusy(null);
    }
  }

  async function handleRecon() {
    setBusy("recon");
    try {
      const r = await runRecon({});
      toast.success(
        `Reconciliation complete: ${r.matched}/${r.checked} matched, ${r.exceptionsCreated} exceptions raised.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reconciliation failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Settlements"
        description="Separate payment success from money in the bank. Build batches, confirm settlement, and reconcile the ledger against bank records."
        actions={
          <Button variant="outline" onClick={handleRecon} disabled={busy === "recon"}>
            {busy === "recon" ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Run reconciliation
          </Button>
        }
      />

      {/* Balances straight from the double-entry ledger */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <Wallet className="size-3.5" /> Ledger balance
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {summary === undefined ? "—" : formatMoney(totalBalance, summary.balances[0]?.currency ?? "NGN")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Sum of merchant balance accounts (net of fees, before payout)
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <CheckCircle2 className="size-3.5" /> Settlement batches
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">{batches?.page.length ?? "—"}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Newest {batches?.page.length ?? 0} shown below
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <AlertOctagon className="size-3.5" /> Open exceptions
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">{exceptions?.length ?? "—"}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Unresolved reconciliation findings
          </CardContent>
        </Card>
      </div>

      {/* Merchant balances + batch builder */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Merchant balances</CardTitle>
          <CardDescription>
            Computed live from immutable ledger entries — never a stored counter.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {summary === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : summary.balances.length === 0 ? (
            <EmptyState
              icon={<Wallet className="size-5" />}
              title="No merchant accounts"
              description="A merchant account is provisioned automatically with your organization."
            />
          ) : (
            <ul className="divide-y">
              {summary.balances.map((b) => {
                const merchant = merchants?.find((m) => m._id === b.merchantId);
                return (
                  <li key={b.merchantId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-medium">{b.merchantName}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.currency} · balance from ledger
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-medium tabular-nums">
                        {formatMoney(b.balanceMinor, b.currency)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === "build" || b.balanceMinor <= 0}
                        onClick={() => handleBuild(b.merchantId, b.currency)}
                      >
                        {busy === "build" ? (
                          <Loader2 className="mr-2 size-3.5 animate-spin" />
                        ) : (
                          <Landmark className="size-3.5" />
                        )}
                        Build settlement batch
                      </Button>
                      {merchant && merchant.status !== "active" && (
                        <span className="text-xs text-muted-foreground">({merchant.status})</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Batches */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Settlement batches</CardTitle>
          <CardDescription>
            EXPECTED → PROCESSING → SETTLED. Marking a batch settled moves funds
            from the merchant balance to settlement payable in the ledger.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {batches === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : batches.page.length === 0 ? (
            <EmptyState
              icon={<Landmark className="size-5" />}
              title="No settlement batches yet"
              description="Build a batch to group successful, unsettled transactions into a payout."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Fees</TableHead>
                  <TableHead className="text-right">Reserve</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Txns</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.page.map((b) => (
                  <TableRow key={b._id}>
                    <TableCell>
                      <div className="font-mono text-xs">{b.reference}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(b.createdAt).toLocaleDateString()} · {b.currency}
                      </div>
                    </TableCell>
                    <TableCell><StatusPill status={b.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(b.grossMinor, b.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatMoney(b.feeMinor, b.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatMoney(b.reserveMinor, b.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(b.netMinor, b.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.transactionCount}</TableCell>
                    <TableCell className="text-right">
                      {(b.status === "EXPECTED" || b.status === "PROCESSING" || b.status === "PARTIALLY_SETTLED") && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === b._id}
                          onClick={() => handleSettle(b._id)}
                        >
                          {busy === b._id ? (
                            <Loader2 className="mr-2 size-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="size-3.5" />
                          )}
                          Mark settled
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Bank records */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="size-4" /> Bank records
            </CardTitle>
            <CardDescription>
              Settlement activity as seen by the bank — matched against the ledger
              by the reconciliation engine.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {bankRecords === undefined ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : bankRecords.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No bank records ingested yet. Bank statement adapters land in a later stage.
              </p>
            ) : (
              <ul className="divide-y">
                {bankRecords.slice(0, 10).map((r) => (
                  <li key={r._id} className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-mono text-xs">{r.bankReference}</p>
                      <p className="text-[11px] text-muted-foreground">
                        batch {r.batchReference} · {r.source}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium tabular-nums">
                        {formatMoney(r.amountMinor, r.currency)}
                      </span>
                      <StatusPill status={r.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Exceptions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reconciliation exceptions</CardTitle>
            <CardDescription>
              Missing settlements, amount mismatches and unexplained bank entries.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {exceptions === undefined ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : exceptions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No open exceptions. Run reconciliation after building batches to check ledger vs bank.
              </p>
            ) : (
              <ul className="divide-y">
                {exceptions.map((e) => (
                  <li key={e._id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium capitalize">
                        {e.type.replace(/_/g, " ")}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {e.severity}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            resolveException({ exceptionId: e._id, resolution: "resolved" })
                          }
                        >
                          Resolve
                        </Button>
                      </div>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{e.detail}</p>
                    {(e.ledgerAmountMinor != null || e.bankAmountMinor != null) && (
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <KeyValue label="Ledger">
                          {e.ledgerAmountMinor != null
                            ? formatMoney(e.ledgerAmountMinor, e.currency ?? "NGN")
                            : "—"}
                        </KeyValue>
                        <KeyValue label="Bank">
                          {e.bankAmountMinor != null
                            ? formatMoney(e.bankAmountMinor, e.currency ?? "NGN")
                            : "—"}
                        </KeyValue>
                        <KeyValue label="Difference">
                          {e.ledgerAmountMinor != null && e.bankAmountMinor != null
                            ? formatMoney(
                                e.ledgerAmountMinor - e.bankAmountMinor,
                                e.currency ?? "NGN",
                              )
                            : "—"}
                        </KeyValue>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
