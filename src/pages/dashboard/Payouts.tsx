// USOPGRID payouts page — beneficiaries, payout creation and
// the payout status pipeline (PENDING → PROCESSING → SUCCESSFUL | FAILED).
import { useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
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
  DialogTrigger,
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
import { PageHeader, EmptyState, StatusPill } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import {
  Landmark,
  Loader2,
  UserPlus,
  Send,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

const BANKS = [
  "Access Bank", "Citibank", "Ecobank", "Fidelity Bank", "First Bank",
  "GTBank", "Heritage Bank", "Keystone Bank", "Kuda MFB", "Moniepoint MFB",
  "Opay", "Polaris Bank", "Providus Bank", "Stanbic IBTC", "Standard Chartered",
  "Sterling Bank", "Union Bank", "UBA", "Wema Bank", "Zenith Bank",
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
  const balances = useQuery(api.services.getSettlementSummary, {});

  const createBeneficiary = useMutation(api.payouts.createBeneficiary);
  const createPayout = useAction(api.payouts.createDashboardPayout);

  const [benOpen, setBenOpen] = useState(false);
  const [bName, setBName] = useState("");
  const [bBank, setBBank] = useState("");
  const [bAccount, setBAccount] = useState("");
  const [bCurrency, setBCurrency] = useState("NGN");
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
      await createBeneficiary({
        name: bName,
        bankName: bBank,
        accountNumber: bAccount.replace(/\s+/g, ""),
        currency: bCurrency,
      });
      toast.success("Beneficiary added and verified.");
      setBenOpen(false);
      setBName("");
      setBBank("");
      setBAccount("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add beneficiary");
    } finally {
      setSavingBen(false);
    }
  }

  async function handleSendPayout() {
    if (!pBeneficiary) {
      toast.error("Choose a beneficiary.");
      return;
    }
    const amountMinor = Math.round(Number(pAmount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    setSending(true);
    try {
      const r = await createPayout({
        beneficiaryId: pBeneficiary as never,
        amountMinor,
        narration: pNarration || undefined,
        simulate: pSimulate,
      });
      toast.success(`Payout ${r.payoutId} — ${r.status.toLowerCase().replace(/_/g, " ")}.`);
      setPayOpen(false);
      setPAmount("");
      setPNarration("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Payout failed");
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
          <div className="flex gap-2">
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
            Account numbers are never stored — only a masked display and a hash for
            duplicate detection.
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
              The account number is hashed and masked — USOPGRID never stores it in
              plaintext.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Account holder name</label>
              <Input value={bName} onChange={(e) => setBName(e.target.value)} placeholder="Ada Lovelace" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Bank</label>
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
              <label className="text-sm font-medium">Account number</label>
              <Input value={bAccount} onChange={(e) => setBAccount(e.target.value)} placeholder="0123456789" inputMode="numeric" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Currency</label>
              <Select value={bCurrency} onValueChange={setBCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["NGN", "USD", "GHS", "KES"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Input value={pAmount} onChange={(e) => setPAmount(e.target.value)} placeholder="5000.00" inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Narration</label>
              <Input value={pNarration} onChange={(e) => setPNarration(e.target.value)} placeholder="Invoice settlement" />
            </div>
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
          </div>
          <DialogFooter>
            <Button onClick={handleSendPayout} disabled={sending}>
              {sending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
              Send payout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
