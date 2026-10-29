// USOPGRID payouts page — beneficiaries, payout creation and
// the payout status pipeline (PENDING → PROCESSING → SUCCESSFUL | FAILED).
import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader, EmptyState, StatusPill, errorMessage, isStepUpError } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { formatMoney, decimalToMinor, currencyDecimals } from "@/lib/money";
import {
  Landmark,
  Loader2,
  UserPlus,
  Send,
  Wallet,
  FileSpreadsheet,
} from "lucide-react";
import { toast } from "sonner";

const BANKS = [
  "Access Bank", "Citibank", "Ecobank", "Fidelity Bank", "First Bank",
  "GTBank", "Heritage Bank", "Keystone Bank", "Kuda MFB", "Moniepoint MFB",
  "Opay", "Polaris Bank", "Providus Bank", "Stanbic IBTC", "Standard Chartered",
  "Sterling Bank", "Union Bank", "UBA", "Wema Bank", "Zenith Bank",
];

// Currencies with at least one payout-capable provider adapter, and a default country.
const PAYOUT_CURRENCIES: [string, string][] = [
  ["NGN", "NG"], ["GHS", "GH"], ["KES", "KE"], ["ZAR", "ZA"], ["UGX", "UG"], ["TZS", "TZ"],
  ["RWF", "RW"], ["ZMW", "ZM"], ["XAF", "CM"], ["XOF", "SN"], ["EGP", "EG"], ["ETB", "ET"],
  ["USD", "US"], ["EUR", "DE"], ["GBP", "GB"],
];

const SIMULATIONS = [
  { value: "success", label: "Successful payout" },
  { value: "timeout", label: "Provider timeout (reversible)" },
  { value: "insufficient_funds", label: "Rail insufficient funds" },
];

export default function Payouts() {
  const beneficiaries = useQuery(api.payouts.listBeneficiaries, {});
  const payouts = useQuery(api.payouts.listPayouts, {
    paginationOpts: { numItems: 10, cursor: null },
  });

  const orgContext = useQuery(api.orgs.getOrgContext, {});
  const environment = orgContext?.org?.environment ?? "sandbox";
  const createBeneficiary = useAction(api.payouts.createBeneficiary);
  const sensitive = useSensitive();
  const createPayout = useAction(api.payouts.createDashboardPayout);
  const [bulkOpen, setBulkOpen] = useState(false);

  const [benOpen, setBenOpen] = useState(false);
  const [bName, setBName] = useState("");
  const [bBank, setBBank] = useState("");
  const [bAccount, setBAccount] = useState("");
  const [bCurrency, setBCurrency] = useState("NGN");
  const [bBankCode, setBBankCode] = useState("");
  const [bType, setBType] = useState<"bank_account" | "mobile_money">("bank_account");
  const [bCountry, setBCountry] = useState("NG");
  const [savingBen, setSavingBen] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  const [pBeneficiary, setPBeneficiary] = useState("");
  const [pAmount, setPAmount] = useState("");
  const [pNarration, setPNarration] = useState("");
  const [pSimulate, setPSimulate] = useState("success");
  const [sending, setSending] = useState(false);

  async function handleCreateBeneficiary() {
    setSavingBen(true);
    try {
      await sensitive(() =>
        createBeneficiary({
          name: bName,
          bankName: bBank,
          bankCode: bBankCode.trim() || undefined,
          accountNumber: bAccount.replace(/\s+/g, ""),
          currency: bCurrency,
          country: bCountry || undefined,
          accountType: bType,
        }),
      );
      toast.success("Beneficiary added. The account number is stored encrypted.");
      setBenOpen(false);
      setBName("");
      setBBank("");
      setBAccount("");
      setBBankCode("");
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setSavingBen(false);
    }
  }

  async function handleSendPayout() {
    if (!pBeneficiary) {
      toast.error("Choose a beneficiary.");
      return;
    }
    const ben = verifiedBens.find((b) => b._id === pBeneficiary);
    let amountMinor = NaN;
    try {
      amountMinor = decimalToMinor(pAmount.trim(), ben?.currency ?? "NGN");
    } catch {
      amountMinor = NaN;
    }
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    setSending(true);
    try {
      const r = await sensitive(() =>
        createPayout({
          beneficiaryId: pBeneficiary as never,
          amountMinor,
          narration: pNarration || undefined,
          simulate: environment === "sandbox" ? pSimulate : undefined,
        }),
      );
      if (r.status === "PENDING_APPROVAL") toast.success("Sent for approval. A second team member must approve it under Approvals before money moves.");
      else toast.success(`Payout ${r.payoutId} — ${r.status.toLowerCase().replace(/_/g, " ")}.`);
      setPayOpen(false);
      setPAmount("");
      setPNarration("");
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const verifiedBens = (beneficiaries ?? []).filter((b) => b.status === "verified");

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Payouts"
        description="Move money from your balance to any bank account — with a full ledger trail for every payout and status."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setBulkOpen(true)}>
              <FileSpreadsheet className="size-4" /> Bulk payout
            </Button>
            <Button variant="outline" onClick={() => setBenOpen(true)}>
              <UserPlus className="size-4" /> Add beneficiary
            </Button>
            <Button onClick={() => setPayOpen(true)} disabled={verifiedBens.length === 0}>
              <Send className="size-4" /> Send payout
            </Button>
          </div>
        }
      />

      {/* Beneficiaries */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Beneficiaries</CardTitle>
          <CardDescription>
            Account numbers are stored encrypted (AES-256-GCM) and only ever shown
            masked. They are decrypted solely to instruct the payout provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {beneficiaries === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : beneficiaries.length === 0 ? (
            <EmptyState
              icon={<UserPlus className="size-5" />}
              title="No beneficiaries yet"
              description="Add a bank account to send payouts to."
            />
          ) : (
            <div className="flex flex-wrap gap-3">
              {beneficiaries.map((b) => (
                <div
                  key={b._id}
                  className={`rounded-lg border p-3 ${b.status === "verified" ? "" : "opacity-60"}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Landmark className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">{b.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.bankName} · {b.accountMasked}
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {b.status} · {b.currency}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <BatchesCard />

      {/* Payout history */}
      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Payout history</CardTitle>
            <CardDescription>PENDING → PROCESSING → SUCCESSFUL | FAILED | REVERSED</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {payouts === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : payouts.page.length === 0 ? (
            <EmptyState
              icon={<Wallet className="size-5" />}
              title="No payouts yet"
              description="Send your first payout — funds come straight from your settled ledger balance."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payout</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.page.map((p) => (
                  <TableRow key={p._id}>
                    <TableCell>
                      <div className="font-mono text-xs">{p.payoutId}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {p.narration ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(p.amountMinor, p.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatMoney(p.feeMinor, p.currency)}
                    </TableCell>
                    <TableCell>
                      <StatusPill status={p.status} />
                      {p.failureMessage && (
                        <p className="mt-1 max-w-[16rem] truncate text-[11px] text-destructive">
                          {p.failureMessage}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(p.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add beneficiary dialog */}
      <Dialog open={benOpen} onOpenChange={setBenOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a beneficiary</DialogTitle>
            <DialogDescription>
              The account number is encrypted at rest and never shown again in full.
              Live payouts need a connected payout provider (Paystack or Flutterwave).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Account holder name</label>
              <Input value={bName} onChange={(e) => setBName(e.target.value)} placeholder="Ada Lovelace" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Account type</label>
              <Select value={bType} onValueChange={(x) => setBType(x as "bank_account" | "mobile_money")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_account">Bank account</SelectItem>
                  <SelectItem value="mobile_money">Mobile money wallet</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{bType === "mobile_money" ? "Network" : "Bank"}</label>
              <Select value={bBank} onValueChange={setBBank}>
                <SelectTrigger><SelectValue placeholder="Select a bank" /></SelectTrigger>
                <SelectContent>
                  {BANKS.map((b) => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Bank or network code <span className="font-normal text-muted-foreground">(as the payout provider lists it, e.g. 058)</span>
              </label>
              <Input value={bBankCode} onChange={(e) => setBBankCode(e.target.value)} placeholder="058" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{bType === "mobile_money" ? "Wallet phone number" : "Account number"}</label>
              <Input value={bAccount} onChange={(e) => setBAccount(e.target.value)} placeholder="0123456789" inputMode="numeric" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Currency</label>
              <Select
                value={bCurrency}
                onValueChange={(c) => {
                  setBCurrency(c);
                  const match = PAYOUT_CURRENCIES.find(([code]) => code === c);
                  if (match) setBCountry(match[1]);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYOUT_CURRENCIES.map(([c, country]) => (
                    <SelectItem key={c} value={c}>{c} · {country}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Country (ISO code)</label>
              <Input value={bCountry} maxLength={2} onChange={(e) => setBCountry(e.target.value.toUpperCase())} placeholder="NG" />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleCreateBeneficiary} disabled={savingBen}>
              {savingBen ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Add beneficiary
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send payout dialog */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send a payout</DialogTitle>
            <DialogDescription>
              Funds leave your ledger balance (amount + {`0.2%`} fee, capped). Failed
              payouts return money and fees automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Beneficiary</label>
              <Select value={pBeneficiary} onValueChange={setPBeneficiary}>
                <SelectTrigger><SelectValue placeholder="Select beneficiary" /></SelectTrigger>
                <SelectContent>
                  {verifiedBens.map((b) => (
                    <SelectItem key={b._id} value={b._id}>
                      {b.name} — {b.bankName} {b.accountMasked}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Amount</label>
              <Input
                value={pAmount}
                onChange={(e) => setPAmount(e.target.value)}
                placeholder={currencyDecimals(verifiedBens.find((b) => b._id === pBeneficiary)?.currency ?? "NGN") === 0 ? "5000" : "5000.00"}
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Narration</label>
              <Input value={pNarration} onChange={(e) => setPNarration(e.target.value)} placeholder="Invoice settlement" />
            </div>
            {environment === "sandbox" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Sandbox scenario</label>
              <Select value={pSimulate} onValueChange={setPSimulate}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SIMULATIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleSendPayout} disabled={sending}>
              {sending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
              Send payout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {bulkOpen && <BulkPayoutDialog onClose={() => setBulkOpen(false)} />}
    </div>
  );
}

function BatchesCard() {
  const batches = useQuery(api.bulkPayouts.listBatches, {});
  const [open, setOpen] = useState<string | null>(null);
  if (!batches || batches.length === 0) return null;
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Bulk payouts</CardTitle>
        <CardDescription>Each row is paid separately with its own safeguard against double payment.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {batches.map((b) => (
          <div key={b._id} className="rounded-md border">
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left" onClick={() => setOpen(open === b._id ? null : b._id)} aria-expanded={open === b._id}>
              <span className="min-w-0">
                <span className="block font-medium text-heading">{b.name}</span>
                <span className="text-xs text-muted-foreground">{b.count} payouts · {b.totals.join(" + ")} · {b.createdByLabel} · {new Date(b.createdAt).toLocaleString()}</span>
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                {b.submitted !== null && <span>{b.submitted} submitted{b.refused ? `, ${b.refused} refused` : ""}</span>}
                <StatusPill status={b.status === "pending_approval" ? "PENDING" : b.status === "processing" ? "PROCESSING" : b.status === "completed" ? "SUCCESSFUL" : "CANCELLED"} />
              </span>
            </button>
            {open === b._id && <BatchItems batchId={b._id} />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function BatchItems({ batchId }: { batchId: Id<"payoutBatches"> }) {
  const items = useQuery(api.bulkPayouts.batchItems, { batchId });
  if (items === undefined) return <div className="px-4 pb-4"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>;
  return (
    <div className="overflow-x-auto border-t">
      <Table>
        <TableHeader>
          <TableRow><TableHead>Line</TableHead><TableHead>Beneficiary</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead>Payout</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) => (
            <TableRow key={i.line}>
              <TableCell className="tabular-nums text-muted-foreground">{i.line}</TableCell>
              <TableCell><div className="text-sm">{i.name}</div><div className="text-xs text-muted-foreground">{i.account}{i.reference ? ` · ${i.reference}` : ""}</div></TableCell>
              <TableCell className="text-right tabular-nums">{i.amount}</TableCell>
              <TableCell><StatusPill status={i.payoutStatus ?? (i.status === "refused" ? "FAILED" : i.status === "cancelled" ? "CANCELLED" : "PENDING")} />{i.error && <div className="mt-1 max-w-[18rem] text-xs text-status-failed">{i.error}</div>}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{i.payoutId ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BulkPayoutDialog({ onClose }: { onClose: () => void }) {
  const template = useQuery(api.bulkPayouts.template, {});
  const validate = useAction(api.bulkPayouts.validate);
  const submit = useAction(api.bulkPayouts.submit);
  const sensitive = useSensitive();
  const [name, setName] = useState("");
  const [csv, setCsv] = useState("");
  const [check, setCheck] = useState<{ valid: boolean; rows: number; errors: { line: number; message: string }[]; totals: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) return toast.error("The file is larger than 2 MB.");
    const text = await f.text();
    setCsv(text);
    if (!name) setName(f.name.replace(/\.csv$/i, ""));
    setBusy(true);
    try {
      setCheck(await validate({ csv: text }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    try {
      const r = await sensitive(() => submit({ csv, name }));
      toast.success(r.status === "pending_approval" ? `${r.count} payouts sent for approval.` : `${r.count} payouts are being sent.`);
      onClose();
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const templateHref = template ? `data:text/csv;charset=utf-8,${encodeURIComponent(template)}` : undefined;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk payout</DialogTitle>
          <DialogDescription>
            Upload a CSV with one payout per row. Every row is checked first; nothing is created unless the whole file is valid.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {templateHref && (
            <a className="text-sm text-primary underline underline-offset-4" href={templateHref} download="usopgrid-bulk-payout-template.csv">Download the template</a>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bp-name">Batch name</label>
            <Input id="bp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="October salaries" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bp-file">CSV file</label>
            <Input id="bp-file" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          {check && (
            check.valid ? (
              <p className="rounded-md bg-status-success-bg px-3 py-2 text-sm text-status-success">{check.rows} payouts ready · {check.totals.join(" + ")}</p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-md bg-status-failed-bg px-3 py-2 text-sm text-status-failed">
                <p className="font-medium">Fix these rows and upload again:</p>
                <ul className="mt-1 list-disc pl-5">{check.errors.map((e) => <li key={e.line}>Line {e.line}: {e.message}</li>)}</ul>
              </div>
            )
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void send()} disabled={busy || !check?.valid}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}Submit {check?.valid ? `${check.rows} payouts` : ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
