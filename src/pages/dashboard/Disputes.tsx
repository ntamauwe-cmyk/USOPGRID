// USOPGRID disputes page — dispute lifecycle: open, submit
// evidence, resolve. Chargebacks post balanced ledger entries automatically.
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { PageHeader, EmptyState, StatusPill, KeyValue } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import { ShieldAlert, Loader2, Gavel, FileText, ChevronRight } from "lucide-react";
import { toast } from "sonner";

const REASONS = [
  { value: "fraudulent", label: "Fraudulent — cardholder claims unauthorized" },
  { value: "product_not_received", label: "Product not received" },
  { value: "product_unacceptable", label: "Product unacceptable" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "subscription_cancelled", label: "Subscription cancelled but billed" },
  { value: "other", label: "Other" },
];

export default function Disputes() {
  const disputes = useQuery(api.disputes.listDisputes, {
    paginationOpts: { numItems: 15, cursor: null },
  });
  const openDispute = useMutation(api.disputes.openDashboardDispute);
  const addEvidence = useMutation(api.disputes.addDashboardEvidence);
  const resolveDispute = useMutation(api.disputes.resolveDashboardDispute);

  // Open dialog state
  const [openOpen, setOpenOpen] = useState(false);
  const [txnId, setTxnId] = useState("");
  const [reason, setReason] = useState("fraudulent");
  const [details, setDetails] = useState("");
  const [opening, setOpening] = useState(false);

  // Evidence dialog state
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const [evidenceNote, setEvidenceNote] = useState("");
  const [addingEvidence, setAddingEvidence] = useState(false);

  async function handleOpen() {
    if (!txnId.trim()) {
      toast.error("Enter the transaction id (txn_…).");
      return;
    }
    setOpening(true);
    try {
      const r = await openDispute({
        transactionId: txnId.trim(),
        reasonCode: reason,
        reasonDetails: details || undefined,
      });
      toast.success(`Dispute ${r.disputeId} opened — transaction marked DISPUTED.`);
      setOpenOpen(false);
      setTxnId("");
      setDetails("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open dispute");
    } finally {
      setOpening(false);
    }
  }

  async function handleEvidence() {
    if (!evidenceFor || !evidenceNote.trim()) return;
    setAddingEvidence(true);
    try {
      await addEvidence({ disputeId: evidenceFor, note: evidenceNote.trim() });
      toast.success("Evidence recorded — dispute moved to UNDER_REVIEW.");
      setEvidenceFor(null);
      setEvidenceNote("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add evidence");
    } finally {
      setAddingEvidence(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Disputes & chargebacks"
        description="Track chargebacks with deadlines, evidence and automatic ledger handling — a lost dispute returns funds and posts the fee."
        actions={
          <Button onClick={() => setOpenOpen(true)}>
            <Gavel className="size-4" /> Open dispute
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6">
          {disputes === undefined ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : disputes.page.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert className="size-5" />}
              title="No disputes"
              description="When a cardholder challenges a payment, the dispute and its full lifecycle appear here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dispute</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {disputes.page.map((d) => (
                  <TableRow key={d._id}>
                    <TableCell>
                      <div className="font-mono text-xs">{d.disputeId}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(d.createdAt).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {d.reasonCode.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(d.amountMinor, d.currency)}
                    </TableCell>
                    <TableCell><StatusPill status={d.status} /></TableCell>
                    <TableCell className="text-sm tabular-nums">{d.evidence?.length ?? 0}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {!["WON", "LOST", "CANCELLED"].includes(d.status) && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => setEvidenceFor(d.disputeId)}>
                              <FileText className="size-3.5" /> Evidence
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-emerald-700 hover:text-emerald-800"
                              onClick={() =>
                                resolveDispute({ disputeId: d.disputeId, outcome: "won" })
                                  .then(() => toast.success("Dispute won — no funds moved."))
                                  .catch((e: unknown) =>
                                    toast.error(e instanceof Error ? e.message : "Failed"))
                              }
                            >
                              Win
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() =>
                                resolveDispute({ disputeId: d.disputeId, outcome: "lost" })
                                  .then(() => toast.success("Dispute lost — chargeback posted to the ledger."))
                                  .catch((e: unknown) =>
                                    toast.error(e instanceof Error ? e.message : "Failed"))
                              }
                            >
                              Lose
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Open dispute dialog */}
      <Dialog open={openOpen} onOpenChange={setOpenOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open a dispute</DialogTitle>
            <DialogDescription>
              Simulates a cardholder chargeback against a successful transaction.
              The transaction is marked DISPUTED and a lost dispute will post a
              balanced chargeback group to the ledger.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Transaction id</label>
              <Input value={txnId} onChange={(e) => setTxnId(e.target.value)} placeholder="txn_…" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Details</label>
              <Textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Cardholder statement…" />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleOpen} disabled={opening}>
              {opening ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Open dispute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Evidence dialog */}
      <Dialog open={evidenceFor !== null} onOpenChange={(o) => !o && setEvidenceFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add evidence</DialogTitle>
            <DialogDescription>
              Submitting evidence moves the dispute to UNDER_REVIEW. Resolution
              posts any required money movement automatically.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            placeholder="Delivery confirmation, customer communication, proof of service…"
            rows={5}
          />
          <DialogFooter>
            <Button onClick={handleEvidence} disabled={addingEvidence}>
              {addingEvidence ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Submit evidence
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
