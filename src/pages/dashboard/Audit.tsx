// USOPGRID audit page: actor, action, resource, before/after.
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PageHeader, EmptyState } from "@/components/kit";
import { ScrollText, Loader2 } from "lucide-react";

export default function Audit() {
  const logs = useQuery(api.services.listAuditLogs, {});

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Audit log"
        description="Every consequential action — actor, resource and the change made. Protected from unauthorized modification."
      />
      <Card>
        <CardContent className="pt-6">
          {logs === undefined ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : logs.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="size-5" />}
              title="No audit entries visible"
              description="Audit visibility requires the audit:view permission. Entries appear as your team acts on payments, keys, settlements and webhooks."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l._id}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {l.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {l.actor.length > 18 ? `${l.actor.slice(0, 18)}…` : l.actor}
                    </TableCell>
                    <TableCell className="text-sm">
                      {l.resource}
                      {l.resourceId && (
                        <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                          {l.resourceId.slice(-6)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      {(l.before != null || l.after != null) && (
                        <code className="block truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {JSON.stringify({ from: l.before ?? null, to: l.after ?? null })}
                        </code>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(l.at).toLocaleString()}
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
