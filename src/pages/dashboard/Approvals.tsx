// Two-person approval: the organization's policy and the queue of requests
// waiting for a second team member.
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, EmptyState, LoadingRows, StatusPill, errorMessage, isStepUpError } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";

const KIND_LABEL: Record<string, string> = { payout: "Payout", bulk_payout: "Bulk payout", policy_change: "Policy change" };

function PolicyCard() {
  const data = useQuery(api.approvals.policy, {});
  const setPolicy = useMutation(api.approvals.setPolicy);
  const sensitive = useSensitive();
  const [mode, setMode] = useState<"off" | "all" | "above" | null>(null);
  const [threshold, setThreshold] = useState("");
  const [saving, setSaving] = useState(false);
  if (data === undefined) return <LoadingRows rows={2} />;
  const current = mode ?? data.policy.payouts;
  const t = threshold || (data.policy.payoutThresholdUsd ? String(data.policy.payoutThresholdUsd) : "");
  async function save() {
    setSaving(true);
    try {
      const r = await sensitive(() =>
        setPolicy({ policy: current === "above" ? { payouts: "above", payoutThresholdUsd: Number(t.replace(/,/g, "")) } : { payouts: current } }),
      );
      toast.success(r.applied ? "Approval policy updated" : "This change weakens the control, so a second approver must confirm it below");
      setMode(null);
      setThreshold("");
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-gold-ink" /> Approval policy</CardTitle>
        <CardDescription>Current: {data.description}. Approvers must be a different person, with an authenticator app enabled.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] space-y-1.5">
          <label className="text-sm font-medium" htmlFor="ap-mode">Payouts need a second approver</label>
          <Select value={current} onValueChange={(v) => setMode(v as typeof current)} disabled={!data.canEdit}>
            <SelectTrigger id="ap-mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Never</SelectItem>
              <SelectItem value="above">At or above an amount</SelectItem>
              <SelectItem value="all">Always</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {current === "above" && (
          <div className="w-44 space-y-1.5">
            <label className="text-sm font-medium" htmlFor="ap-threshold">Threshold (US$)</label>
            <Input id="ap-threshold" inputMode="decimal" placeholder="10000" value={t} onChange={(e) => setThreshold(e.target.value)} disabled={!data.canEdit} />
          </div>
        )}
        {data.canEdit && (
          <Button onClick={() => void save()} disabled={saving || (mode === null && !threshold)}>
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />}Save policy
          </Button>
        )}
        <p className="w-full text-xs text-muted-foreground">
          Amounts in other currencies are compared at the latest reference rate; when no rate is available the payout is treated as above the threshold. Bulk payouts always need approval while the policy is on. Weakening the policy also needs a second approver.
        </p>
      </CardContent>
    </Card>
  );
}

export default function Approvals() {
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const rows = useQuery(api.approvals.list, { status: tab });
  const decide = useAction(api.approvals.decide);
  const cancel = useMutation(api.approvals.cancel);
  const sensitive = useSensitive();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function act(id: Id<"approvalRequests">, decision: "approve" | "reject") {
    setBusy(id + decision);
    try {
      const r = await sensitive(() => decide({ approvalId: id, decision, note: notes[id] }));
      if (r.status === "failed") toast.error(`Approved, but it could not be completed: ${r.detail ?? ""}`);
      else toast.success(decision === "approve" ? `Approved. ${r.detail ?? ""}` : "Rejected");
    } catch (err) {
      if (!isStepUpError(err)) toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Approvals" description="Money leaves only after a second team member approves it. Every decision is recorded in the audit log." />
      <PolicyCard />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="pending">Waiting for approval</TabsTrigger>
          <TabsTrigger value="all">History</TabsTrigger>
        </TabsList>
      </Tabs>
      {rows === undefined ? (
        <LoadingRows rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="size-5" />} title={tab === "pending" ? "Nothing waiting" : "No requests yet"} description="Payouts that need a second approver appear here." />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r._id} className="rounded-md border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gold-ink">{KIND_LABEL[r.kind]}</span>
                    <StatusPill status={r.status.toUpperCase()} />
                  </div>
                  <p className="font-medium text-heading">{r.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    Requested by {r.requestedByLabel} · {new Date(r.requestedAt).toLocaleString()}
                    {r.status === "pending" && <> · expires {new Date(r.expiresAt).toLocaleString()}</>}
                    {r.decidedByLabel && <> · decided by {r.decidedByLabel}{r.decidedAt ? ` ${new Date(r.decidedAt).toLocaleString()}` : ""}</>}
                  </p>
                  {r.note && <p className="text-sm text-muted-foreground">Note: {r.note}</p>}
                  {r.error && <p className="text-sm text-status-failed">{r.error}</p>}
                </div>
                {r.status === "pending" && (
                  <div className="flex flex-col items-stretch gap-2 sm:w-72">
                    {r.canDecide ? (
                      <>
                        <Input placeholder="Note (optional)" value={notes[r._id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r._id]: e.target.value }))} aria-label="Decision note" />
                        <div className="flex gap-2">
                          <Button className="flex-1" disabled={busy !== null} onClick={() => void act(r._id, "approve")}>
                            {busy === r._id + "approve" ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}Approve
                          </Button>
                          <Button className="flex-1" variant="outline" disabled={busy !== null} onClick={() => void act(r._id, "reject")}>
                            <XCircle className="mr-2 size-4" />Reject
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">{r.isMine ? "Waiting for a second team member." : "You don't have permission to decide this."}</p>
                    )}
                    {r.isMine && (
                      <Button variant="ghost" size="sm" onClick={() => cancel({ approvalId: r._id }).then(() => toast.success("Request cancelled")).catch((e: unknown) => toast.error(errorMessage(e)))}>
                        Cancel request
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
