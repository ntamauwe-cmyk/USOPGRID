import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { PageHeader, StatusPill, EmptyState, errorMessage } from "@/components/kit";
import { formatMoney, formatMoneyCompact, decimalToMinor, currencyDecimals } from "@/lib/money";
import { ACTIVE_CURRENCY_CODES } from "@/lib/geo";
import { PAYMENT_METHODS as ALL_METHODS, METHOD_LABELS, SANDBOX_SIMULATION_KEYS } from "@/convex/providers/index";
import { Link, useNavigate } from "react-router";
import {
  ArrowLeftRight,
  CircleDollarSign,
  Percent,
  Loader2,
  Plus,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const PAYMENT_METHOD_OPTIONS = ALL_METHODS.map((m) => ({ value: m, label: METHOD_LABELS[m] }));

const SIMULATION_LABELS: Record<string, string> = {
  success: "Successful payment",
  pending: "Pending (async rail)",
  requires_action: "Customer must authenticate",
  issuer_decline: "Issuer decline",
  insufficient_funds: "Insufficient funds",
  fraud_rejection: "Provider fraud rejection",
  invalid_payment_information: "Invalid payment details",
  customer_cancellation: "Customer cancelled",
  timeout: "Timeout, later confirmed successful",
  timeout_declined: "Timeout, later confirmed declined",
  failover: "Primary rail down, failover succeeds",
  provider_down: "Every rail down",
};
const SIMULATIONS = SANDBOX_SIMULATION_KEYS.map((k) => ({ value: k, label: SIMULATION_LABELS[k] ?? k }));

function NewPaymentDialog({ defaultCurrency, environment }: { defaultCurrency: string; environment: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createPayment = useAction(api.queries.createDashboardPayment);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const currency = String(fd.get("currency") || defaultCurrency).trim().toUpperCase();
    let amountMinor: number;
    try {
      amountMinor = decimalToMinor(String(fd.get("amount") ?? "").trim(), currency);
      if (amountMinor <= 0) throw new Error();
    } catch {
      setError(`Enter a positive amount with at most ${currencyDecimals(currency)} decimal places for ${currency}.`);
      setBusy(false);
      return;
    }
    try {
      await createPayment({
        amountMinor,
        currency,
        country: String(fd.get("country") ?? "").trim().toUpperCase() || undefined,
        customerEmail: (fd.get("email") as string) || undefined,
        customerName: (fd.get("name") as string) || undefined,
        paymentMethod: fd.get("method") as string,
        simulate: environment === "sandbox" ? (fd.get("simulate") as string) : undefined,
        description: (fd.get("description") as string) || undefined,
      });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err, "Payment failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> New payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{environment === "sandbox" ? "Create a test payment" : "Create a live payment"}</DialogTitle>
          <DialogDescription>
            Runs through the same engine as the API: screening, routing, failover, ledger posting and webhooks.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Amount</Label>
              <Input id="amount" name="amount" inputMode="decimal" placeholder="2500.00" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Input id="currency" name="currency" defaultValue={defaultCurrency} list="ug-currencies" maxLength={3} required className="uppercase" />
              <datalist id="ug-currencies">
                {ACTIVE_CURRENCY_CODES.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="method">Payment method</Label>
              <Select name="method" defaultValue="card">
                <SelectTrigger id="method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHOD_OPTIONS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {environment === "sandbox" ? (
            <div className="space-y-1.5">
              <Label htmlFor="simulate">Sandbox scenario</Label>
              <Select name="simulate" defaultValue="success">
                <SelectTrigger id="simulate"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SIMULATIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="country">Payer country</Label>
                <Input id="country" name="country" maxLength={2} placeholder="NG" className="uppercase" />
              </div>
            )}
          </div>
          {environment === "sandbox" && (
            <div className="space-y-1.5">
              <Label htmlFor="country">Payer country</Label>
              <Input id="country" name="country" maxLength={2} placeholder="NG" className="uppercase" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Customer email</Label>
            <Input id="email" name="email" type="email" placeholder="customer@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" placeholder="Order #1234" />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Process payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Overview() {
  const navigate = useNavigate();
  const orgContext = useQuery(api.orgs.getOrgContext, {});
  const stats = useQuery(api.queries.getOverviewStats, { days: 14 });
  const recent = useQuery(api.queries.listTransactions, {
    paginationOpts: { numItems: 8, cursor: null },
  });

  const currency = stats?.primaryCurrency ?? "USD";

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Overview"
        description="Payment volume, success rate and the live state of your money movement."
        actions={orgContext && orgContext.permissions.includes("payments:create") ? <NewPaymentDialog defaultCurrency={currency} environment={orgContext.org.environment} /> : undefined}
      />

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <CircleDollarSign className="size-3.5" /> {currency} volume (14d)
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {stats === undefined ? "—" : formatMoney(stats.volume, currency)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats?.successful ?? 0} successful payments{stats && Object.keys(stats.volumeByCurrency).length > 1 ? `, plus ${Object.keys(stats.volumeByCurrency).length - 1} other currencies` : ""}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <Percent className="size-3.5" /> Success rate
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {stats === undefined ? "—" : `${stats.successRate}%`}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats?.failed ?? 0} failed or declined, {stats?.pending ?? 0} in flight
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <ArrowLeftRight className="size-3.5" /> Transactions (14d)
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">{stats?.total ?? "—"}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Across {stats?.currencyCounts.length ?? 0} currencies
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
                <CardDescription className="text-xs">{currency} fees (14d)</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {stats === undefined ? "—" : formatMoney(stats.fees, currency)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats?.exceptions ? `${stats.exceptions} payments need reconciliation` : "Deducted before settlement"}
          </CardContent>
        </Card>
      </div>

      {/* Chart + failure intelligence */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Volume</CardTitle>
            <CardDescription>Daily successful {currency} volume, last 14 days (UTC)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              {stats && stats.series.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats.series} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tickFormatter={(d: string) => d.slice(5)}
                      className="text-muted-foreground"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tickFormatter={(v: number) => formatMoneyCompact(v, currency)}
                      className="text-muted-foreground"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                    />
                    <Tooltip
                      formatter={(v) => [formatMoney(Number(v), currency), "Volume"]}
                      labelFormatter={(l) => `Day ${l}`}
                      contentStyle={{ borderRadius: 8, border: "1px solid var(--border)" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="volume"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      fill="url(#vol)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No transactions in the last 14 days yet.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Failure intelligence</CardTitle>
            <CardDescription>Why payments failed — not just that they failed</CardDescription>
          </CardHeader>
          <CardContent>
            {stats && stats.failureCategories.length > 0 ? (
              <ul className="space-y-3">
                {stats.failureCategories.slice(0, 6).map((f) => (
                  <li key={`${f.category}-${f.code}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize">{f.category.replace(/_/g, " ")}</span>
                      <span className="font-medium tabular-nums">{f.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-destructive/70"
                        style={{
                          width: `${Math.round((f.count / Math.max(...stats.failureCategories.map((x) => x.count))) * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No failures recorded. Failed payments will show category, retry guidance and
                the provider stage involved.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent transactions */}
      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Recent transactions</CardTitle>
            <CardDescription>Live status pipeline for the latest activity</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate("/dashboard/transactions")}>
            View all <ChevronRight className="size-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {recent === undefined ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : recent.page.length === 0 ? (
            <EmptyState
              icon={<ArrowLeftRight className="size-5" />}
              title="No transactions yet"
              description="Create your first payment from the dashboard or send one through the API — every state change appears here in real time."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead className="hidden sm:table-cell">Customer</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.page.map((t) => (
                  <TableRow key={t._id} className="cursor-pointer">
                    <TableCell>
                      <Link to={`/dashboard/transactions/${t.transactionId}`} className="block">
                        <div className="font-mono text-xs">{t.reference}</div>
                        <div className="text-[11px] text-muted-foreground">{t.paymentMethod.replace(/_/g, " ")}</div>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden max-w-[16rem] truncate text-sm sm:table-cell">{t.customerEmail ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(t.amountMinor, t.currency)}
                    </TableCell>
                    <TableCell><StatusPill status={t.status} /></TableCell>
                    <TableCell className="hidden text-right sm:table-cell">
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
