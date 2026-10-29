import { useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { PageHeader, NoAccess, errorMessage } from "@/components/kit";
import { toCsv } from "@/convex/lib/analytics";
import { toast } from "sonner";
import { Download } from "lucide-react";

function download(name: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

export default function Reports() {
  const ctx = useQuery(api.orgs.getOrgContext, {});
  const convex = useConvex();
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const allowed = ctx?.permissions.includes("analytics:view");
  if (ctx && !allowed) return <NoAccess what="reports" />;

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    try {
      await fn();
      toast.success("Report downloaded");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const reports = [
    {
      id: "transactions",
      title: "Transactions",
      body: "Every payment in the window with status, amounts in minor units, provider, fees, refunds, attempts and failure codes.",
      go: async () => download(`usopgrid-transactions-${days}d-${stamp()}.csv`, await convex.query(api.analytics.exportTransactions, { days })),
    },
    {
      id: "providers",
      title: "Provider performance",
      body: "Attempts, success, approval and provider-error rates, and p50/p95 latency for each provider.",
      go: async () => {
        const d = await convex.query(api.analytics.dashboard, { days });
        download(
          `usopgrid-provider-performance-${days}d-${stamp()}.csv`,
          toCsv(["rank", "provider", "attempts", "successful", "declined", "failed", "unknown", "success_rate", "approval_rate", "provider_error_rate", "latency_p50_ms", "latency_p95_ms"], d.providers.map((p) => [p.rank, p.providerId, p.attempts, p.successful, p.declined, p.failed, p.unknown, p.successRate, p.approvalRate, p.providerErrorRate, p.latencyP50Ms, p.latencyP95Ms])),
        );
      },
    },
    {
      id: "breakdowns",
      title: "Country, method and currency breakdown",
      body: "Payment counts, success rates and volume per currency for each country, payment method and currency.",
      go: async () => {
        const d = await convex.query(api.analytics.dashboard, { days });
        const rows = [
          ...d.overview.byCountry.map((b) => ["country", b.key, b.count, b.successful, b.failed, b.successRate, JSON.stringify(b.volumeByCurrency)]),
          ...d.overview.byMethod.map((b) => ["payment_method", b.key, b.count, b.successful, b.failed, b.successRate, JSON.stringify(b.volumeByCurrency)]),
          ...d.overview.byCurrency.map((b) => ["currency", b.key, b.count, b.successful, b.failed, b.successRate, JSON.stringify(b.volumeByCurrency)]),
        ];
        download(`usopgrid-breakdown-${days}d-${stamp()}.csv`, toCsv(["dimension", "value", "payments", "successful", "failed", "success_rate", "volume_minor_by_currency"], rows));
      },
    },
    {
      id: "api",
      title: "API usage",
      body: "Requests and 4xx/5xx errors per day across all your API keys, for capacity planning and integration health.",
      go: async () => {
        const d = await convex.query(api.analytics.dashboard, { days });
        download(`usopgrid-api-usage-${days}d-${stamp()}.csv`, toCsv(["day", "requests", "errors_4xx", "errors_5xx"], d.api.daily.map((x) => [x.day, x.requests, x.errors4xx, x.errors5xx])));
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Download finance and operations datasets as CSV. Amounts are in each currency's minor unit; currencies are never combined." />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Window</span>
        {[7, 30, 90, 365].map((d) => (
          <Button key={d} size="sm" variant={days === d ? "default" : "outline"} aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</Button>
        ))}
      </div>
      <div className="divide-y rounded-lg border bg-card">
        {reports.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="max-w-2xl">
              <div className="font-medium">{r.title}</div>
              <p className="text-sm text-muted-foreground">{r.body}</p>
            </div>
            <Button variant="outline" disabled={busy !== null} onClick={() => void run(r.id, r.go)}>
              <Download className="size-4" /> {busy === r.id ? "Preparing…" : "Download CSV"}
            </Button>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">Settlement batches and ledger balances are on the Settlements page; reconciliation exceptions on Reconciliation. Every export is limited to 20,000 rows per request; use the API's paginated <code className="font-mono text-xs">GET /payments</code> for larger extracts.</p>
    </div>
  );
}
