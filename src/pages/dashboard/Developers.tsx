// USOPGRID developer workspace: API keys (shown once, stored hashed, rotatable),
// API base URL, quickstart, error reference and webhook events.
import { useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
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
import { PageHeader, EmptyState, errorMessage } from "@/components/kit";
import { useSensitive } from "@/components/StepUp";
import { apiBaseUrl } from "@/site/routes";
import { KeyRound, Plus, Copy, Ban, Loader2, Terminal, Check, RotateCw, ShieldCheck } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "sonner";

// Convex HTTP surface host derived from VITE_CONVEX_URL (.cloud → .site).
const API_BASE = apiBaseUrl() ?? "";

function quickstartFor(key: string | null): string {
  return `curl -X POST ${API_BASE || "https://<your-deployment>.convex.site"}/api/v1/payments \\
  -H "Authorization: Bearer ${key ?? "sk_sandbox_YOUR_KEY"}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order_12345" \\
  -d '{
    "amount": 250000,
    "currency": "NGN",
    "payment_method": "card",
    "country": "NG",
    "reference": "order_12345",
    "customer": { "email": "customer@example.com" },
    "metadata": { "simulate": "success" }
  }'`;
}

const ERRORS: { code: string; http: string; meaning: string }[] = [
  { code: "authentication_error", http: "401", meaning: "Missing, invalid, revoked or expired key. Pass it as a Bearer token." },
  { code: "authorization_error", http: "403", meaning: "Publishable key used server-side, or the organization is suspended." },
  { code: "validation_error", http: "422", meaning: "A field is missing or malformed; the message names it. Fix before retrying." },
  { code: "idempotency_conflict", http: "422", meaning: "This Idempotency-Key was reused with a different request body." },
  { code: "not_found", http: "404", meaning: "No such object in this organization." },
  { code: "conflict", http: "409", meaning: "Duplicate reference, request in progress, or refund above the refundable amount." },
  { code: "rate_limited", http: "429", meaning: "Over 120 requests a minute for this key. Honour Retry-After." },
  { code: "provider_unavailable", http: "503", meaning: "No provider could take it now. Retry with the same Idempotency-Key." },
  { code: "processing_error", http: "500", meaning: "Unexpected error. Retry with the same Idempotency-Key; quote the request id." },
];

const SANDBOX_EVENTS = [
  { event: "payment.successful", when: "Funds captured and the ledger posted" },
  { event: "payment.pending", when: "Accepted by the provider, or outcome being confirmed" },
  { event: "payment.requires_action", when: "The customer must authenticate or approve" },
  { event: "payment.declined", when: "Issuer, risk or compliance declined it" },
  { event: "payment.failed", when: "No provider could process it" },
  { event: "payment.expired", when: "Customer action not completed in time" },
  { event: "payment.refunded", when: "A full or partial refund completed" },
  { event: "refund.pending / refund.failed", when: "Refund awaiting confirmation, or refused" },
  { event: "payment.reconciliation_exception", when: "Provider and USOPGRID records disagree" },
  { event: "payment_method.saved", when: "A customer's payment method was saved for future charges" },
  { event: "subscription.created", when: "A customer was subscribed to a plan" },
  { event: "subscription.renewed", when: "A renewal was paid and a new period started" },
  { event: "invoice.paid", when: "A subscription invoice was paid" },
  { event: "invoice.payment_failed", when: "A renewal attempt failed (includes the next retry time)" },
  { event: "subscription.past_due", when: "A renewal failed and will be retried" },
  { event: "subscription.unpaid", when: "Retries ran out or the decline was final" },
  { event: "subscription.canceled", when: "A subscription ended" },
];

export default function Developers() {
  const keys = useQuery(api.services.listApiKeys, {});
  const orgContext = useQuery(api.orgs.getOrgContext, {});

  const createKey = useAction(api.services.createApiKey);
  const revokeKey = useMutation(api.services.revokeApiKey);
  const rotateKey = useAction(api.services.rotateApiKey);
  const sensitive = useSensitive();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyEnv, setKeyEnv] = useState<"sandbox" | "production">("sandbox");
  const [keyMode, setKeyMode] = useState<"secret" | "publishable">("secret");
  const [keyScope, setKeyScope] = useState<"full" | "read_only">("full");
  const [restricting, setRestricting] = useState<{ _id: Id<"apiKeys">; name: string; scope: "full" | "read_only"; allowedIps: string[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // When a fresh key exists, embed it in the quickstart for instant testing.
  const quickstart = quickstartFor(newKey);

  async function handleCreate() {
    setCreating(true);
    try {
      const r = await sensitive(() => createKey({
        name: keyName.trim() || "Default key",
        environment: keyEnv,
        mode: keyMode,
        scope: keyScope,
      }));
      setNewKey(r.fullKey);
      setKeyName("");
    } catch (err) {
      toast.error(errorMessage(err));
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

  const environment = orgContext?.org.environment ?? "sandbox";

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Developers"
        description="API keys, quickstart and the sandbox: everything needed to take the first payment programmatically."
      />
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm">
        <span className="font-medium">API base URL</span>
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{API_BASE ? `${API_BASE}/api/v1` : "Available once the backend is deployed"}</code>
        {API_BASE && <Button size="sm" variant="ghost" onClick={() => copy(`${API_BASE}/api/v1`)}><Copy className="size-3.5" /> Copy</Button>}
        <a className="text-primary hover:underline" href="/developers">Documentation</a>
        {API_BASE && <a className="text-primary hover:underline" href={`${API_BASE}/api/v1/openapi.json`} target="_blank" rel="noreferrer">OpenAPI spec</a>}
      </div>

      {/* API keys */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">API keys</CardTitle>
            <CardDescription>
              Secret keys are shown once and stored only as a SHA-256 hash. Sandbox
              keys can never touch production providers.
            </CardDescription>
          </div>
          <Dialog
            open={dialogOpen}
            onOpenChange={(o) => {
              setDialogOpen(o);
              if (!o) setNewKey(null);
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4" /> Create key
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              {newKey ? (
                <>
                  <DialogHeader>
                    <DialogTitle>Save your key now</DialogTitle>
                    <DialogDescription>
                      This is the only time the full key is visible. It is stored
                      hashed and cannot be retrieved again.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex items-center gap-2 rounded-md border bg-muted p-3">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs">{newKey}</code>
                    <Button size="icon" variant="outline" onClick={() => copy(newKey)}>
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    </Button>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => { setDialogOpen(false); setNewKey(null); }}>
                      I've saved it
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                <>
                  <DialogHeader>
                    <DialogTitle>Create an API key</DialogTitle>
                    <DialogDescription>
                      Keys are scoped to this organization and to one environment.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Key name</label>
                      <Input
                        value={keyName}
                        onChange={(e) => setKeyName(e.target.value)}
                        placeholder="Production server"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Environment</label>
                        <Select value={keyEnv} onValueChange={(v) => setKeyEnv(v as typeof keyEnv)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sandbox">Sandbox</SelectItem>
                            <SelectItem value="production">Production</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Mode</label>
                        <Select value={keyMode} onValueChange={(v) => setKeyMode(v as typeof keyMode)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="secret">Secret (server-side)</SelectItem>
                            <SelectItem value="publishable">Publishable (client-side)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Access</label>
                      <Select value={keyScope} onValueChange={(v) => setKeyScope(v as typeof keyScope)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="full">Full access</SelectItem>
                          <SelectItem value="read_only">Read-only (reporting, reconciliation tools)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleCreate} disabled={creating}>
                      {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Generate key
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {keys === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound className="size-5" />}
              title="No API keys yet"
              description="Create a sandbox key to take your first test payment through the API."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Restrictions</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k._id}>
                    <TableCell className="text-sm font-medium">{k.name}</TableCell>
                    <TableCell>
                      <button
                        className="font-mono text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => copy(k.prefix)}
                        title="Copy prefix"
                      >
                        {k.prefix}••••
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          k.environment === "production"
                            ? "border-primary text-primary"
                            : "text-muted-foreground"
                        }
                      >
                        {k.environment}
                      </Badge>{" "}
                      <span className="text-xs text-muted-foreground">{k.mode}</span>
                    </TableCell>
                    <TableCell>
                      <span className={k.status === "active" ? "text-sm" : "text-sm text-destructive"}>
                        {k.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className={k.scope === "read_only" ? "font-medium text-heading" : ""}>{k.scope === "read_only" ? "Read-only" : "Full access"}</div>
                      <div>{k.allowedIps.length === 0 ? "Any IP address" : k.allowedIps.length === 1 ? k.allowedIps[0] : `${k.allowedIps.length} IP ranges`}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
                      {k.expiresAt && <div className="text-xs text-status-pending">Rotated; stops working {new Date(k.expiresAt).toLocaleString()}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      {k.status === "active" && (
                        <Button size="sm" variant="ghost" onClick={() => setRestricting({ _id: k._id, name: k.name, scope: k.scope, allowedIps: k.allowedIps })}>
                          <ShieldCheck className="size-3.5" /> Restrict
                        </Button>
                      )}
                      {k.status === "active" && !k.expiresAt && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            try {
                              const r = await sensitive(() => rotateKey({ keyId: k._id }));
                              setNewKey(r.fullKey);
                              setDialogOpen(true);
                              toast.success(`New key issued. The old key keeps working until ${new Date(r.oldKeyExpiresAt).toLocaleString()}.`);
                            } catch (e) {
                              toast.error(errorMessage(e));
                            }
                          }}
                        >
                          <RotateCw className="size-3.5" /> Rotate
                        </Button>
                      )}
                      {k.status === "active" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            revokeKey({ keyId: k._id }).then(() => toast.success("Key revoked"))
                              .catch((e: unknown) =>
                                toast.error(e instanceof Error ? e.message : "Revoke failed"));
                          }}
                        >
                          <Ban className="size-3.5" /> Revoke
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

      {/* Quickstart */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Quickstart</CardTitle>
              <CardDescription>
                Create a payment with one request. Pass an Idempotency-Key so
                retries can never double-charge.
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => copy(quickstart)}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />} Copy
            </Button>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <Terminal className="absolute right-3 top-3 size-4 text-muted-foreground" />
              <pre className="overflow-auto rounded-lg bg-muted p-4 pr-12 text-xs leading-5">
                {quickstart}
              </pre>
            </div>
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="font-medium">GET /api/v1/payments/:id</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Track the live status pipeline for any transaction.
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-medium">GET /api/v1/balance</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Read merchant balances straight from the ledger.
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-medium">GET /api/v1/settlements</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  List settlement batches and their state.
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Current environment: <span className="font-medium capitalize">{environment}</span>.
              {newKey
                ? " The quickstart above embeds your new key — copy and run it now."
                : " Create a key above to embed it in the quickstart."}
            </p>
          </CardContent>
        </Card>

        {/* Webhook events reference */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Webhook events</CardTitle>
            <CardDescription>Signed with your endpoint secret</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {SANDBOX_EVENTS.map((e) => (
                <li key={e.event}>
                  <p className="font-mono text-xs">{e.event}</p>
                  <p className="text-[11px] text-muted-foreground">{e.when}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Sandbox scenarios */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Sandbox scenarios</CardTitle>
          <CardDescription>
            Reproduce real failure modes from the dashboard payment dialog — every
            scenario posts full lifecycle events, ledger entries and webhooks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Successful payment", "Clears immediately and posts to the ledger"],
              ["Pending (async rail)", "Stays PENDING to model bank-transfer rails"],
              ["Issuer decline", "Fails with a non-retryable issuer code"],
              ["Insufficient funds", "Retryable failure — safe to reattempt later"],
              ["Provider timeout", "Retryable timeout with retry guidance"],
              ["Provider failure", "Temporary adapter outage simulation"],
              ["Fraud rejection", "Blocked by the risk engine"],
            ].map(([title, desc]) => (
              <div key={title} className="rounded-lg border p-3">
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Error reference */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Error codes</CardTitle>
          <CardDescription>
            Structured, documented failures — never opaque messages.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>HTTP</TableHead>
                <TableHead>Meaning</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ERRORS.map((e) => (
                <TableRow key={e.code}>
                  <TableCell className="font-mono text-xs">{e.code}</TableCell>
                  <TableCell className="tabular-nums">{e.http}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.meaning}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {restricting && <RestrictKeyDialog keyInfo={restricting} onClose={() => setRestricting(null)} />}
    </div>
  );
}

function RestrictKeyDialog({ keyInfo, onClose }: { keyInfo: { _id: Id<"apiKeys">; name: string; scope: "full" | "read_only"; allowedIps: string[] }; onClose: () => void }) {
  const setRestrictions = useMutation(api.services.setApiKeyRestrictions);
  const sensitive = useSensitive();
  const [scope, setScope] = useState(keyInfo.scope);
  const [ips, setIps] = useState(keyInfo.allowedIps.join("\n"));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await sensitive(() => setRestrictions({ keyId: keyInfo._id, scope, allowedIps: ips.split(/[\s,]+/).filter(Boolean) }));
      toast.success("Restrictions saved");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restrict “{keyInfo.name}”</DialogTitle>
          <DialogDescription>Limit what this key can do and where it can be used from. Changes apply to the next request.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="rk-scope">Access</label>
            <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
              <SelectTrigger id="rk-scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full access</SelectItem>
                <SelectItem value="read_only">Read-only: can view, cannot create payments, refunds or payouts</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="rk-ips">Allowed IP addresses</label>
            <textarea
              id="rk-ips"
              value={ips}
              onChange={(e) => setIps(e.target.value)}
              rows={4}
              placeholder={"203.0.113.7\n198.51.100.0/24\n2001:db8::/48"}
              className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              One address or range per line. Leave empty to allow any address. Check the address USOPGRID sees for your servers with <code className="font-mono">GET /api/v1/whoami</code> before saving, or requests from them will be refused.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>{saving && <Loader2 className="mr-2 size-4 animate-spin" />}Save restrictions</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
