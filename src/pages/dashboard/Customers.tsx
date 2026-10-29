// USOPGRID customers page — customers upserted from payment
// activity, with per-customer drill-down.
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Users, Loader2, ChevronLeft, } from "lucide-react";
import { Link } from "react-router";

export default function Customers() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const result = useQuery(api.customers.listCustomers, {
    paginationOpts: { numItems: 15, cursor },
  });
  const detail = useQuery(
    api.customers.getCustomer,
    selected ? { email: selected } : "skip",
  );

  if (selected) {
    return (
      <div className="mx-auto max-w-5xl">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 -ml-2"
          onClick={() => setSelected(null)}
        >
          <ChevronLeft className="size-4" /> All customers
        </Button>
        {detail === undefined ? (
          <div className="flex justify-center py-24">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : detail === null ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Customer not found.</p>
        ) : (
          <>
            <PageHeader title={detail.customer.email} description={detail.customer.name ?? "Customer"} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="pt-6">
                  <KeyValue label="Lifetime volume">
                    {Object.keys(detail.customer.lifetimeVolumeByCurrency).length === 0 ? (
                      "—"
                    ) : (
                      <span className="space-y-0.5">
                        {Object.entries(detail.customer.lifetimeVolumeByCurrency).map(([cur, minor]) => (
                          <div key={cur}>{formatMoney(minor, cur)}</div>
                        ))}
                      </span>
                    )}
                  </KeyValue>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <KeyValue label="Transactions">{detail.customer.transactionCount}</KeyValue>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <KeyValue label="Successful">{detail.customer.successfulCount}</KeyValue>
                </CardContent>
              </Card>
            </div>
            <Card className="mt-6">
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.transactions.map((t) => (
                      <TableRow key={t._id}>
                        <TableCell>
                          <Link
                            to={`/dashboard/transactions/${t.transactionId}`}
                            className="font-mono text-xs hover:text-primary hover:underline"
                          >
                            {t.reference}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(t.amountMinor, t.currency)}
                        </TableCell>
                        <TableCell><StatusPill status={t.status} /></TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(t.createdAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Customers"
        description="Built automatically from payment activity — volume, success and recency for everyone who has paid you."
      />
      <Card>
        <CardContent className="pt-6">
          {result === undefined ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : result.page.length === 0 ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title="No customers yet"
              description="Customers appear here automatically the first time they pay you — with email or through a payment link."
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Lifetime volume</TableHead>
                    <TableHead className="text-right">Txns</TableHead>
                    <TableHead>Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.page.map((c) => (
                    <TableRow
                      key={c._id}
                      className="cursor-pointer"
                      onClick={() => setSelected(c.email)}
                    >
                      <TableCell className="text-sm font-medium">{c.email}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.name ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Object.entries(c.lifetimeVolumeByCurrency ?? {}).length === 0
                          ? "—"
                          : Object.entries(c.lifetimeVolumeByCurrency ?? {})
                              .map(([cur, minor]) => formatMoney(minor as number, cur))
                              .join(" · ")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c.transactionCount}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.lastTransactionAt ? new Date(c.lastTransactionAt).toLocaleDateString() : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{result.page.length} shown</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!cursor}
                    onClick={() => setCursor(null)}
                  >
                    <ChevronLeft className="size-4" /> First
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={result.isDone}
                    onClick={() => setCursor(result.continueCursor)}
                  >
                    Next
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
