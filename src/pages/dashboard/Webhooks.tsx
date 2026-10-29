// USOPGRID webhooks page: endpoint management, delivery history
// with live pipeline state, and replay for failed deliveries.
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader, EmptyState, StatusPill } from "@/components/kit";
import { Webhook, Plus, Loader2, ToggleLeft, ToggleRight, RotateCcw, Copy, Check } from "lucide-react";
import { toast } from "sonner";

const ALL_EVENTS = [
  "payment.created",
  "payment.processing",
  "payment.successful",
  "payment.failed",
  "payment.refunded",
  "transfer.created",
  "transfer.successful",
  "transfer.failed",
  "settlement.created",
  "settlement.completed",
  "dispute.created",
  "dispute.updated",
];

export default function Webhooks() {
  const endpoints = useQuery(api.services.listWebhookEndpoints, {});
  const deliveries = useQuery(api.services.listWebhookDeliveries, {});

  const createEndpoint = useMutation(api.services.createWebhookEndpoint);
  const toggleEndpoint = useMutation(api.services.toggleWebhookEndpoint);
  const replay = useMutation(api.services.replayWebhookDelivery);

  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    if (!url.trim()) {
      toast.error("Enter an HTTPS endpoint URL.");
      return;
    }
    setCreating(true);
    try {
      const r = await createEndpoint({ url: url.trim(), events: selectedEvents });
      setNewSecret(r.secret);
      setUrl("");
      setSelectedEvents([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create endpoint");
    } finally {
      setCreating(false);
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Webhooks"
        description="Programmatic visibility into every fund movement — signed payloads, exponential-backoff retries and full delivery history. Zero opaque holds."
        actions={
          <Dialog
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              if (!o) setNewSecret(null);
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4" /> Add endpoint
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              {newSecret ? (
                <>
                  <DialogHeader>
                    <DialogTitle>Endpoint created</DialogTitle>
                    <DialogDescription>
                      Save the signing secret now — it is shown only once. Verify
                      deliveries by computing HMAC-SHA256 over
                      <code className="mx-1 rounded bg-muted px-1">{"t=<ts>.<payload>"}</code>
                      and comparing to the X-USOPGRID-Signature header.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex items-center gap-2 rounded-md border bg-muted p-3">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs">{newSecret}</code>
                    <Button size="icon" variant="outline" onClick={() => copy(newSecret)}>
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    </Button>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => { setOpen(false); setNewSecret(null); }}>Done</Button>
                  </DialogFooter>
                </>
              ) : (
                <>
                  <DialogHeader>
                    <DialogTitle>Add a webhook endpoint</DialogTitle>
                    <DialogDescription>
                      USOPGRID signs every payload and retries failures with
                      exponential backoff before dead-lettering.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Endpoint URL</label>
                      <Input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://api.yourapp.com/hooks/usopgrid"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Events</label>
                      <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
                        {ALL_EVENTS.map((ev) => {
                          const checked = selectedEvents.includes(ev);
                          return (
                            <label key={ev} className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setSelectedEvents((prev) =>
                                    checked ? prev.filter((x) => x !== ev) : [...prev, ev],
                                  )
                                }
                                className="accent-primary"
                              />
                              <span className="font-mono">{ev}</span>
                            </label>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Leave all unchecked to receive every event.
                      </p>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleCreate} disabled={creating}>
                      {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Create endpoint
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        }
      />

      {/* Endpoints */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Endpoints</CardTitle>
          <CardDescription>Where USOPGRID sends signed event payloads.</CardDescription>
        </CardHeader>
        <CardContent>
          {endpoints === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : endpoints.length === 0 ? (
            <EmptyState
              icon={<Webhook className="size-5" />}
              title="No webhook endpoints"
              description="Add an HTTPS endpoint to receive payment, refund, transfer and settlement events as they happen."
            />
          ) : (
            <ul className="divide-y">
              {endpoints.map((e) => (
                <li key={e._id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{e.url}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {e.events.map((ev) => (
                        <Badge key={ev} variant="outline" className="font-mono text-[10px]">
                          {ev}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={e.status} />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        toggleEndpoint({ endpointId: e._id }).catch((err: unknown) =>
                          toast.error(err instanceof Error ? err.message : "Toggle failed"),
                        )
                      }
                    >
                      {e.status === "active" ? (
                        <ToggleRight className="size-4" />
                      ) : (
                        <ToggleLeft className="size-4" />
                      )}
                      {e.status === "active" ? "Enabled" : "Disabled"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Delivery history */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Delivery history</CardTitle>
          <CardDescription>
            Live attempt log — statuses, HTTP responses and errors for the latest 50 deliveries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {deliveries === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : deliveries.length === 0 ? (
            <EmptyState
              icon={<Webhook className="size-5" />}
              title="No deliveries yet"
              description="Once payments flow and an endpoint is active, every event delivery appears here with its full attempt history."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead className="text-right">Response</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d._id}>
                    <TableCell className="font-mono text-xs">{d.event}</TableCell>
                    <TableCell><StatusPill status={d.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{d.attempts}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {d.responseStatus != null ? `HTTP ${d.responseStatus}` : d.lastError ? "—" : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {(d.status === "failed" || d.status === "dead") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            replay({ deliveryId: d._id })
                              .then(() => toast.success("Delivery re-queued"))
                              .catch((err: unknown) =>
                                toast.error(err instanceof Error ? err.message : "Replay failed"))
                          }
                        >
                          <RotateCcw className="size-3.5" /> Replay
                        </Button>
                      )}
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
