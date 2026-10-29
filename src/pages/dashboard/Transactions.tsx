// USOPGRID transactions page — powerful filters + pagination.
import { TX_STATES, STATE_LABELS } from "@/convex/orchestration/states";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { PageHeader, StatusPill, EmptyState } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import { Link } from "react-router";
import { ChevronLeft, ChevronRight, Search, ArrowLeftRight, Loader2 } from "lucide-react";

const STATUSES = TX_STATES.filter((x) => x !== "CREATED" && x !== "VALIDATED" && x !== "ACCEPTED");

export default function Transactions() {
  const [status, setStatus] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageStack, setPageStack] = useState<(string | null)[]>([null]);

  const listArgs = useMemo(
    () => ({
      status: status === "all" ? undefined : status,
      search: committedSearch || undefined,
      paginationOpts: { numItems: 15, cursor },
    }),
    [status, committedSearch, cursor],
  );

  const result = useQuery(api.queries.listTransactions, listArgs);

  function reset() {
    setCursor(null);
    setPageStack([null]);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Transactions"
        description="Every payment moving through your organization — filter, search and drill into any single transaction."
      />

      <Card>
        <CardContent className="pt-6">
          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <form
              className="relative w-full max-w-xs"
              onSubmit={(e) => {
                e.preventDefault();
                setCommittedSearch(search.trim());
                reset();
              }}
            >
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reference, txn id or email…"
                className="pl-9"
              />
            </form>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                reset();
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(committedSearch || status !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setCommittedSearch("");
                  setStatus("all");
                  reset();
                }}
              >
                Clear filters
              </Button>
            )}
          </div>

          {result === undefined ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : result.page.length === 0 ? (
            <EmptyState
              icon={<ArrowLeftRight className="size-5" />}
              title={committedSearch ? "No matching transactions" : "No transactions yet"}
              description={
                committedSearch
                  ? "Try a different reference, transaction id, or customer email."
                  : "Once payments start flowing — from the dashboard or the API — they appear here instantly."
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transaction</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.page.map((t) => (
                    <TableRow key={t._id} className="group">
                      <TableCell>
                        <Link to={`/dashboard/transactions/${t.transactionId}`} className="block">
                          <div className="font-mono text-xs group-hover:text-primary group-hover:underline">
                            {t.reference}
                          </div>
                          <div className="text-[11px] text-muted-foreground">{t.transactionId}</div>
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{t.customerEmail ?? "—"}</TableCell>
                      <TableCell className="text-sm capitalize">{t.paymentMethod.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatMoney(t.amountMinor, t.currency)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                        {t.feeMinor != null ? formatMoney(t.feeMinor, t.currency) : "—"}
                      </TableCell>
                      <TableCell><StatusPill status={t.status} /></TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(t.createdAt).toLocaleString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              <div className="mt-4 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Page {pageStack.length} · {result.page.length} shown
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pageStack.length <= 1}
                    onClick={() => {
                      const stack = [...pageStack];
                      stack.pop();
                      const prev = stack[stack.length - 1] ?? null;
                      setPageStack(stack);
                      setCursor(prev);
                    }}
                  >
                    <ChevronLeft className="size-4" /> Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={result.isDone}
                    onClick={() => {
                      const next = result.continueCursor;
                      setPageStack((s) => [...s, next]);
                      setCursor(next);
                    }}
                  >
                    Next <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
