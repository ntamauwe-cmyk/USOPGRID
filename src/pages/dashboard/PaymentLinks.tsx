// USOPGRID payment links page — create, share, toggle links and
// track usage. Copy-to-clipboard for the public checkout URL.
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, EmptyState, StatusPill } from "@/components/kit";
import { Link2, Plus, Loader2, Copy, Check, ExternalLink, ToggleLeft, ToggleRight } from "lucide-react";
import { toast } from "sonner";

const API_BASE = ((import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "").replace(/\.cloud$/, ".site");

export default function PaymentLinks() {
  const links = useQuery(api.paylinks.listPaymentLinks, {});
  const createLink = useMutation(api.paylinks.createPaymentLink);
  const toggleLink = useMutation(api.paylinks.togglePaymentLink);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [maxUses, setMaxUses] = useState("");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleCreate() {
    if (!title.trim()) {
      toast.error("Give the link a title.");
      return;
    }
    setCreating(true);
    try {
      const amountMinor = amount.trim() ? Math.round(Number(amount) * 100) : undefined;
      if (amountMinor !== undefined && (!Number.isFinite(amountMinor) || amountMinor <= 0)) {
        toast.error("Amount must be a positive number.");
        return;
      }
      await createLink({
        title: title.trim(),
        description: description.trim() || undefined,
        amountMinor,
        currency,
        maxUses: maxUses.trim() ? Number(maxUses) : undefined,
      });
      toast.success("Payment link created.");
      setOpen(false);
      setTitle("");
      setDescription("");
      setAmount("");
      setMaxUses("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create link");
    } finally {
      setCreating(false);
    }
  }

  function copy(text: string, id: string) {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    toast.success("Checkout URL copied");
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Payment links"
        description="Share a URL, get paid. Links run through the same engine, ledger and webhook pipeline as API payments."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4" /> New link
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create a payment link</DialogTitle>
                <DialogDescription>
                  Fix an amount, or leave it open for the customer to enter. Links
                  expire only if you set an expiry or usage limit.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Title</label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Consulting — October" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Description</label>
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="10 hours at the standard rate" />
                </div>
                <div className="grid grid-cols-[1fr_7rem] gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Amount (blank = open)</label>
                    <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2500.00" inputMode="decimal" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Currency</label>
                    <Select value={currency} onValueChange={setCurrency}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["NGN", "USD", "EUR", "GBP", "GHS", "KES", "ZAR"].map((c) => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Max uses (blank = unlimited)</label>
                  <Input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="1" inputMode="numeric" />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Create link
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <Card>
        <CardContent className="pt-6">
          {links === undefined ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : links.length === 0 ? (
            <EmptyState
              icon={<Link2 className="size-5" />}
              title="No payment links yet"
              description="Create a shareable link and get paid without writing any code — customers check out on a hosted page."
            />
          ) : (
            <ul className="divide-y">
              {links.map((l) => {
                const checkoutUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/pay/${l.linkId}`;
                const disabled = l.status !== "active" ||
                  (l.expiresAt !== undefined && l.expiresAt < Date.now()) ||
                  (l.maxUses !== undefined && l.useCount >= l.maxUses);
                return (
                  <li key={l._id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{l.title}</p>
                        <StatusPill status={disabled ? "CANCELLED" : "SUCCESSFUL"} />
                      </div>
                      {l.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{l.description}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-medium">
                          {l.amountMinor != null ? `${(l.amountMinor / 100).toFixed(2)} ${l.currency}` : `Open amount · ${l.currency}`}
                        </span>
                        <span>{l.successCount}/{l.useCount} successful</span>
                        {l.maxUses !== undefined && <span>limit {l.maxUses}</span>}
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{checkoutUrl}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => copy(checkoutUrl, l._id)}>
                        {copiedId === l._id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Copy
                      </Button>
                      <a href={`/pay/${l.linkId}`} target="_blank" rel="noreferrer">
                        <Button size="sm" variant="ghost">
                          <ExternalLink className="size-3.5" /> Open
                        </Button>
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          toggleLink({ linkId: l._id }).catch((e: unknown) =>
                            toast.error(e instanceof Error ? e.message : "Toggle failed"))
                        }
                      >
                        {l.status === "active" ? <ToggleRight className="size-4" /> : <ToggleLeft className="size-4" />}
                        {l.status === "active" ? "Active" : "Disabled"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      {/* API_BASE kept for future share-sheet; suppress unused warning */}
      <span className="hidden">{API_BASE}</span>
    </div>
  );
}
