// Marketplace: recipients who receive shares of payments, their balances,
// and payouts from those balances.
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, EmptyState, LoadingRows, StatCard, errorMessage, isStepUpError } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { decimalToMinor, formatMoney } from "@/lib/money";
import { Loader2, Plus, Send, Store } from "lucide-react";
import { toast } from "sonner";

type Recipient = NonNullable<ReturnType<typeof useQuery<typeof api.recipients.list>>>[number];

function RecipientStatus({ status }: { status: "active" | "disabled" }) {
  const active = status === "active";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${active ? "bg-status-success-bg text-status-success" : "bg-muted text-muted-foreground"}`}>
      <span className={`size-1.5 rounded-full ${active ? "bg-status-success" : "bg-muted-foreground"}`} />
      {active ? "Active" : "Disabled"}
    </span>
  );
}

function AddRecipientDialog({ onClose }: { onClose: () => void }) {
  const beneficiaries = useQuery(api.payouts.listBeneficiaries, {});
  const create = useAction(api.recipients.create);
  const sensitive = useSensitive();
  const [mode, setMode] = useState<"new" | "saved">("new");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [beneficiaryId, setBeneficiaryId] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [country, setCountry] = useState("NG");
  const [busy, setBusy] = useState(false);
  const ready = name.trim() && (mode === "saved" ? beneficiaryId : bankName.trim() && accountNumber.trim() && currency.length === 3);
  async function save() {
    setBusy(true);
    try {
      const r = await sensitive(() =>
        create({
          name,
          email: email || undefined,
          beneficiaryId: mode === "saved" ? (beneficiaryId as Id<"beneficiaries">) : undefined,
          account: mode === "new" ? { holderName: name, bankName, bankCode: bankCode || undefined, accountNumber, currency, country: country || undefined } : undefined,
        }),
      );
      toast.success(`Recipient ${r.id} added`);
      onClose();
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add recipient</DialogTitle>
          <DialogDescription>A seller or partner who receives shares of payments. Account numbers are stored encrypted; only the last four digits are shown again.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm font-medium">Name<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Crafts Ltd" /></label>
          <label className="grid gap-1.5 text-sm font-medium">Email (optional)<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="payments@adacrafts.ng" /></label>
          <label className="grid gap-1.5 text-sm font-medium">Payout account
            <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="new">Enter new bank or wallet details</SelectItem><SelectItem value="saved">Use a saved payout account</SelectItem></SelectContent>
            </Select>
          </label>
          {mode === "saved" ? (
            <label className="grid gap-1.5 text-sm font-medium">Saved account
              <Select value={beneficiaryId} onValueChange={setBeneficiaryId} disabled={!beneficiaries?.length}>
                <SelectTrigger><SelectValue placeholder={beneficiaries?.length ? "Choose" : "No saved accounts"} /></SelectTrigger>
                <SelectContent>{(beneficiaries ?? []).map((b) => <SelectItem key={b._id} value={b._id}>{b.name} · {b.bankName} {b.accountMasked} · {b.currency}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <label className="grid gap-1.5 text-sm font-medium">Bank or wallet<Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="GTBank" /></label>
                <label className="grid gap-1.5 text-sm font-medium">Bank code<Input value={bankCode} onChange={(e) => setBankCode(e.target.value)} placeholder="058" /></label>
              </div>
              <label className="grid gap-1.5 text-sm font-medium">Account number<Input inputMode="numeric" autoComplete="off" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="0123456789" /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 text-sm font-medium">Currency<Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label>
                <label className="grid gap-1.5 text-sm font-medium">Country<Input value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} /></label>
              </div>
            </>
          )}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy || !ready}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}Add recipient</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayoutDialog({ recipient, onClose }: { recipient: Recipient; onClose: () => void }) {
  const pay = useAction(api.recipients.payout);
  const sensitive = useSensitive();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await sensitive(() => pay({ recipientId: recipient._id, amountMinor: amount.trim() ? decimalToMinor(amount.replace(/,/g, ""), recipient.currency) : undefined }));
      if (r.kind === "pending_approval") toast.success("Waiting for a second approver under Approvals");
      else toast.success(`Payout ${r.payoutId}: ${r.status.toLowerCase()}`);
      onClose();
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pay {recipient.name}</DialogTitle>
          <DialogDescription>
            Balance {formatMoney(recipient.balanceMinor, recipient.currency)}, paid to {recipient.payoutAccount ? `${recipient.payoutAccount.bank} ${recipient.payoutAccount.account}` : "its payout account"}. The payout fee comes out of the recipient's balance.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm font-medium">Amount ({recipient.currency})
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Leave empty to pay everything available" />
        </label>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}Pay out</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Activity({ recipient }: { recipient: Recipient }) {
  const rows = useQuery(api.recipients.sharesFor, { recipientId: recipient._id });
  if (rows === undefined) return <LoadingRows rows={3} />;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No shares or payouts yet.</p>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>When</TableHead><TableHead>What</TableHead><TableHead className="hidden sm:table-cell">Payment</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={`${r.ledgerRef}-${i}`}>
            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</TableCell>
            <TableCell className="text-sm">{r.description}</TableCell>
            <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{r.transactionId ?? "—"}</TableCell>
            <TableCell className={`text-right tabular-nums ${r.amountMinor < 0 ? "text-status-failed" : "text-heading"}`}>{formatMoney(r.amountMinor, r.currency)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function Marketplace() {
  const recipients = useQuery(api.recipients.list, {});
  const setStatus = useMutation(api.recipients.setStatus);
  const sensitive = useSensitive();
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Recipient | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  if (recipients === undefined) return <div className="mx-auto max-w-7xl"><PageHeader title="Marketplace" /><LoadingRows rows={4} /></div>;

  const byCurrency = new Map<string, number>();
  for (const r of recipients) if (r.balanceMinor > 0) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.balanceMinor);
  const owing = recipients.filter((r) => r.balanceMinor < 0);
  const selected = recipients.find((r) => r.id === open) ?? null;
  const rowActions = (r: Recipient) => (
    <>
      <Button size="sm" variant="outline" disabled={r.status !== "active" || r.balanceMinor <= 0} onClick={() => setPaying(r)}><Send className="size-3.5" /> Pay out</Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          sensitive(() => setStatus({ recipientId: r._id, status: r.status === "active" ? "disabled" : "active" }))
            .then(() => toast.success(r.status === "active" ? "Recipient disabled" : "Recipient enabled"))
            .catch((e: unknown) => { if (!isStepUpError(e)) toast.error(errorMessage(e)); })
        }
      >
        {r.status === "active" ? "Disable" : "Enable"}
      </Button>
    </>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Marketplace"
        description="Split payments between your platform and the sellers or partners on it. Name recipients in a payment's splits; each share lands in the recipient's balance when the payment succeeds, refunds take shares back in proportion, and you pay recipients out from their own balances."
        actions={<Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add recipient</Button>}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Recipients" value={String(recipients.length)} hint={`${recipients.filter((r) => r.status === "active").length} active`} />
        <StatCard label="Owed to recipients" value={byCurrency.size ? [...byCurrency].map(([c, n]) => formatMoney(n, c)).join(" + ") : "—"} hint="Shares not yet paid out" />
        <StatCard label="Owing back" value={String(owing.length)} hint="Refunds after a payout; recovered from new shares" tone={owing.length ? "warn" : undefined} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recipients</CardTitle>
          <CardDescription>
            Send <code className="font-mono">splits: [{"{"} recipient: "rcp_…", percent: 80 {"}"}]</code> with a payment. Shares come out of your net after fees.
            <span className="sm:hidden"> Tap a recipient to pay out or disable it.</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recipients.length === 0 ? (
            <EmptyState icon={<Store className="size-5" />} title="No recipients yet" description="Add the sellers or partners who should receive part of each payment." />
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Recipient</TableHead><TableHead className="hidden md:table-cell">Payout account</TableHead><TableHead className="hidden sm:table-cell">Status</TableHead><TableHead className="text-right">Balance</TableHead><TableHead className="hidden sm:table-cell" /></TableRow></TableHeader>
              <TableBody>
                {recipients.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <TableCell><div className="text-sm font-medium text-heading">{r.name}{r.status !== "active" && <span className="ml-2 text-xs font-normal text-muted-foreground sm:hidden">disabled</span>}</div><div className="font-mono text-[11px] text-muted-foreground">{r.id}</div></TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{r.payoutAccount ? `${r.payoutAccount.bank} ${r.payoutAccount.account}` : "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell"><RecipientStatus status={r.status} /></TableCell>
                    <TableCell className={`text-right tabular-nums ${r.balanceMinor < 0 ? "text-status-failed" : "text-heading"}`}>{formatMoney(r.balanceMinor, r.currency)}</TableCell>
                    <TableCell className="hidden whitespace-nowrap text-right sm:table-cell" onClick={(e) => e.stopPropagation()}>
                      {rowActions(r)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>{selected.name}: activity</CardTitle>
            <CardDescription>Shares received, reversals from refunds and payouts, newest first.</CardDescription>
            <div className="flex flex-wrap gap-2 pt-2 sm:hidden">{rowActions(selected)}</div>
          </CardHeader>
          <CardContent><Activity recipient={selected} /></CardContent>
        </Card>
      )}
      {adding && <AddRecipientDialog onClose={() => setAdding(false)} />}
      {paying && <PayoutDialog recipient={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}
