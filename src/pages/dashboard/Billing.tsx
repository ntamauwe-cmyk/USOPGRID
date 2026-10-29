// Recurring billing: plans, subscriptions and monthly recurring revenue.
import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, EmptyState, LoadingRows, StatCard, StatusPill, errorMessage, isStepUpError } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { decimalToMinor } from "@/lib/money";
import { Loader2, Plus, Repeat } from "lucide-react";
import { toast } from "sonner";

const STATUS: Record<string, string> = { active: "SUCCESSFUL", trialing: "PROCESSING", past_due: "PENDING", unpaid: "FAILED", canceled: "CANCELLED" };

function PlanDialog({ onClose }: { onClose: () => void }) {
  const createPlan = useMutation(api.billing.createPlan);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [interval, setInterval] = useState<"day" | "week" | "month" | "year">("month");
  const [count, setCount] = useState("1");
  const [trial, setTrial] = useState("0");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await createPlan({ name, amountMinor: decimalToMinor(amount.replace(/,/g, ""), currency), currency, interval, intervalCount: Number(count), trialDays: Number(trial) || undefined });
      toast.success("Plan created");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>New plan</DialogTitle><DialogDescription>What customers pay and how often.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm font-medium">Name<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Business monthly" /></label>
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <label className="grid gap-1.5 text-sm font-medium">Amount<Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25000.00" /></label>
            <label className="grid gap-1.5 text-sm font-medium">Currency<Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label>
          </div>
          <div className="grid grid-cols-[5rem_1fr_6rem] gap-3">
            <label className="grid gap-1.5 text-sm font-medium">Every<Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} /></label>
            <label className="grid gap-1.5 text-sm font-medium">Period
              <Select value={interval} onValueChange={(v) => setInterval(v as typeof interval)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="day">Day</SelectItem><SelectItem value="week">Week</SelectItem><SelectItem value="month">Month</SelectItem><SelectItem value="year">Year</SelectItem></SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">Trial days<Input inputMode="numeric" value={trial} onChange={(e) => setTrial(e.target.value)} /></label>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy || !name || !amount}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}Create plan</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubscribeDialog({ plans, onClose }: { plans: { id: string; name: string; description: string; active: boolean }[]; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const methods = useQuery(api.billing.paymentMethodsForCustomer, email.includes("@") ? { customerEmail: email } : "skip");
  const subscribe = useAction(api.billing.createSubscription);
  const sensitive = useSensitive();
  const [planId, setPlanId] = useState("");
  const [methodId, setMethodId] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await sensitive(() => subscribe({ planId, paymentMethodId: methodId }));
      toast.success("Subscription created");
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
          <DialogTitle>New subscription</DialogTitle>
          <DialogDescription>Customers need a saved payment method: take a first payment with <code className="font-mono">save_payment_method: true</code>, or import a provider token through the API.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm font-medium">Customer email<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" /></label>
          <label className="grid gap-1.5 text-sm font-medium">Saved payment method
            <Select value={methodId} onValueChange={setMethodId} disabled={!methods || methods.length === 0}>
              <SelectTrigger><SelectValue placeholder={methods === undefined ? "Enter the customer's email" : methods.length === 0 ? "No saved methods for this customer" : "Choose"} /></SelectTrigger>
              <SelectContent>{(methods ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{(m.brand ?? m.provider).toUpperCase()} {m.last4 ? `•••• ${m.last4}` : ""} · {m.provider}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Plan
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger><SelectValue placeholder="Choose a plan" /></SelectTrigger>
              <SelectContent>{plans.filter((p) => p.active).map((p) => <SelectItem key={p.id} value={p.id}>{p.name} · {p.description}</SelectItem>)}</SelectContent>
            </Select>
          </label>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy || !planId || !methodId}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}Subscribe</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Billing() {
  const data = useQuery(api.billing.overview, {});
  const cancel = useMutation(api.billing.cancelSubscription);
  const [planOpen, setPlanOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  if (data === undefined) return <div className="mx-auto max-w-7xl"><PageHeader title="Billing" /><LoadingRows rows={4} /></div>;
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Billing"
        description="Plans and subscriptions charged automatically to saved payment methods, with retries on days 1, 3, 5 and 7 when a renewal fails for a recoverable reason."
        actions={data.canManage ? <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setPlanOpen(true)}><Plus className="size-4" /> New plan</Button><Button onClick={() => setSubOpen(true)} disabled={data.plans.length === 0}><Repeat className="size-4" /> New subscription</Button></div> : undefined}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Monthly recurring revenue" value={data.mrr.length ? data.mrr.join(" + ") : "—"} hint="Active and past-due subscriptions" />
        <StatCard label="Active" value={String(data.counts.active)} hint={`${data.counts.trialing} in trial`} />
        <StatCard label="Past due" value={String(data.counts.pastDue)} hint="Retrying failed renewals" tone={data.counts.pastDue ? "warn" : undefined} />
        <StatCard label="Unpaid or cancelled" value={String(data.counts.unpaid + data.counts.canceled)} hint={`${data.counts.unpaid} stopped after failed renewals`} tone={data.counts.unpaid ? "bad" : undefined} />
      </div>
      <Card>
        <CardHeader><CardTitle>Plans</CardTitle><CardDescription>Prices customers subscribe to.</CardDescription></CardHeader>
        <CardContent>
          {data.plans.length === 0 ? <EmptyState icon={<Repeat className="size-5" />} title="No plans yet" description="Create a plan, then subscribe customers who have a saved payment method." /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Plan</TableHead><TableHead>Price</TableHead><TableHead className="text-right">Subscribers</TableHead><TableHead className="hidden md:table-cell">ID</TableHead></TableRow></TableHeader>
              <TableBody>{data.plans.map((p) => <TableRow key={p.id}><TableCell className="font-medium text-heading">{p.name}{p.trial_days ? <span className="ml-2 text-xs text-muted-foreground">{p.trial_days}-day trial</span> : null}</TableCell><TableCell className="tabular-nums">{p.description}</TableCell><TableCell className="text-right tabular-nums">{p.subscribers}</TableCell><TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{p.id}</TableCell></TableRow>)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Subscriptions</CardTitle><CardDescription>{data.environment === "production" ? "Live" : "Sandbox"} environment. Renewals are charged at the provider that issued each saved payment method.</CardDescription></CardHeader>
        <CardContent>
          {data.subscriptions.length === 0 ? <EmptyState icon={<Repeat className="size-5" />} title="No subscriptions yet" description="Subscribed customers appear here with their next charge date." /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead className="hidden md:table-cell">Plan</TableHead><TableHead>Status</TableHead><TableHead className="hidden sm:table-cell">Next charge</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {data.subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell><div className="text-sm">{s.customer}</div><div className="font-mono text-[11px] text-muted-foreground">{s.id}</div></TableCell>
                    <TableCell className="hidden md:table-cell"><div className="text-sm">{s.plan}</div><div className="text-xs text-muted-foreground">{s.price}</div></TableCell>
                    <TableCell><StatusPill status={STATUS[s.status] ?? s.status} className="mr-1" /><span className="text-xs text-muted-foreground">{s.status.replace("_", " ")}{s.failedAttempts ? `, ${s.failedAttempts} failed` : ""}{s.cancelAtPeriodEnd ? ", ends at period end" : ""}</span></TableCell>
                    <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground sm:table-cell">{s.nextChargeAt ? new Date(s.nextChargeAt).toLocaleDateString() : "—"}</TableCell>
                    <TableCell className="text-right">
                      {data.canManage && (s.status === "active" || s.status === "trialing" || s.status === "past_due") && !s.cancelAtPeriodEnd && (
                        <Button size="sm" variant="ghost" onClick={() => cancel({ subscriptionId: s.id, atPeriodEnd: true }).then(() => toast.success("Will end at the end of the current period")).catch((e: unknown) => toast.error(errorMessage(e)))}>Cancel</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {planOpen && <PlanDialog onClose={() => setPlanOpen(false)} />}
      {subOpen && <SubscribeDialog plans={data.plans} onClose={() => setSubOpen(false)} />}
    </div>
  );
}
