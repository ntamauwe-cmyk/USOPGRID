// USOPGRID public checkout — pays a payment link through POST /api/v1/checkout.
// Public page (no auth): shows only link-safe fields.
import { useEffect, useState } from "react";
import { useParams, } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/money";
import { Loader2, CheckCircle2, CircleAlert, ShieldCheck } from "lucide-react";
import { UsopgridLogo } from "@/components/brand";
import { decimalToMinor } from "@/lib/money";

const API_BASE = ((import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "").replace(/\.cloud$/, ".site");

interface LinkInfo {
  linkId: string;
  title: string;
  description: string | null;
  amountMinor: number | null;
  currency: string;
  status: string;
  expired: boolean;
  usesExhausted: boolean;
  merchantName: string;
  environment?: "sandbox" | "production";
}

interface PayResult {
  id?: string;
  status?: string;
  next_action?: { type: string; url?: string; instructions?: string } | null;
  failure?: { message: string } | null;
  amount?: number;
  currency?: string;
}

export default function Checkout() {
  const { linkId = "" } = useParams();
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>("");

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("card");
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; payment?: PayResult; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // The public link preview rides on the checkout endpoint's sibling query;
        // use a lightweight POST-free path via the payments API's link resolver.
        const res = await fetch(`${API_BASE}/api/v1/checkout/${linkId}`, {
          method: "OPTIONS",
        });
        if (res.ok && !cancelled) {
          // OPTIONS only proves the API is up; fetch the actual link via the
          // public query through a HEAD-less trick: pay page uses the create
          // response. Simpler: expose link info via the same endpoint with GET.
          const infoRes = await fetch(`${API_BASE}/api/v1/checkout/${linkId}`);
          if (infoRes.ok) {
            const body = (await infoRes.json()) as { data?: LinkInfo };
            if (body.data) {
              setLink(body.data);
              setLoadState("ready");
              return;
            }
          }
          setLoadState("error");
          setLoadError("This payment link could not be found.");
        } else if (!cancelled) {
          setLoadState("error");
          setLoadError("This payment link could not be found.");
        }
      } catch {
        if (!cancelled) {
          setLoadState("error");
          setLoadError("Could not reach the payment service.");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  async function handlePay() {
    let amountMinor = link?.amountMinor ?? NaN;
    if (link && link.amountMinor == null) {
      try {
        amountMinor = decimalToMinor(amount.trim(), link.currency);
      } catch {
        amountMinor = NaN;
      }
    }
    if (!email.includes("@")) {
      setResult({ ok: false, message: "Enter a valid email address." });
      return;
    }
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      setResult({ ok: false, message: "Enter a valid amount." });
      return;
    }
    setPaying(true);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/checkout/${linkId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountMinor,
          customerEmail: email,
          customerName: name || undefined,
          paymentMethod: method,
        }),
      });
      const body = (await res.json()) as {
        status: string;
        data?: { payment: PayResult };
        error?: { message: string };
      };
      if (res.ok && body.status === "success" && body.data?.payment) {
        const p = body.data.payment;
        if (p.next_action?.type === "redirect" && p.next_action.url && /^https:\/\//.test(p.next_action.url)) {
          window.location.assign(p.next_action.url);
          return;
        }
        setResult({
          ok: p.status === "SUCCESSFUL",
          payment: p,
          message: p.status === "PENDING" ? "Your payment is being confirmed. You'll receive a receipt by email when it completes." : p.failure?.message ?? "",
        });
      } else {
        setResult({ ok: false, message: body.error?.message ?? "Payment failed." });
      }
    } catch {
      setResult({ ok: false, message: "Could not reach the payment service." });
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-background px-4 pb-10">
      <div className="w-full max-w-md">
        <div className="-mx-4 mb-8 flex items-center justify-center border-b-2 border-gold bg-navy px-4 py-4 sm:mx-0 sm:rounded-b-md">
          <UsopgridLogo tone="onDark" markClassName="size-7" wordClassName="text-[17px]" />
        </div>

        <div className="rounded-md border bg-card p-6 sm:p-7">
          {loadState === "loading" && (
            <div className="flex flex-col items-center py-12 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="mt-3 text-sm">Loading payment link…</p>
            </div>
          )}

          {loadState === "error" && (
            <div className="flex flex-col items-center py-12 text-center">
              <CircleAlert className="size-8 text-status-failed" />
              <p className="mt-3 text-sm font-medium text-heading">Link unavailable</p>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
              <a href="/" className="mt-4 text-xs text-muted-foreground underline-offset-2 hover:underline">
                Powered by USOPGRID
              </a>
            </div>
          )}

          {loadState === "ready" && link && (
            <>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-gold-ink">
                {link.merchantName}
              </div>
              <h1 className="text-xl">{link.title}</h1>
              {link.description && (
                <p className="mt-1 text-sm text-muted-foreground">{link.description}</p>
              )}
              <p className="mt-4 border-t pt-4 font-display text-3xl font-semibold tabular-nums text-heading">
                {link.amountMinor != null
                  ? formatMoney(link.amountMinor, link.currency)
                  : `Open amount · ${link.currency}`}
              </p>

              {result ? (
                <div className="mt-6">
                  {result.ok ? (
                    <div className="flex flex-col items-center rounded-md border border-status-success/30 bg-status-success-bg p-6 text-center">
                      <CheckCircle2 className="size-10 text-status-success" />
                      <p className="mt-3 font-semibold text-status-success">Payment successful</p>
                      <p className="mt-1 text-sm text-status-success">
                        {result.payment?.id && <>Reference {result.payment.id} · </>}
                        {formatMoney(result.payment?.amount ?? 0, result.payment?.currency ?? link.currency)}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center rounded-md border border-status-failed/30 bg-status-failed-bg p-6 text-center">
                      <CircleAlert className="size-10 text-status-failed" />
                      <p className="mt-3 font-semibold text-status-failed">Payment failed</p>
                      <p className="mt-1 text-sm text-status-failed">{result.message}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        onClick={() => setResult(null)}
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-6 space-y-4">
                  {link.amountMinor == null && (
                    <div className="space-y-1.5">
                      <Label htmlFor="co-amount" >Amount</Label>
                      <Input
                        id="co-amount"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="2500.00"
                        inputMode="decimal"
                        
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="co-email" >Email</Label>
                    <Input
                      id="co-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="co-name" >Name (optional)</Label>
                    <Input
                      id="co-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label >Payment method</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {[["card", "Card"], ["bank_transfer", "Bank transfer"], ["ussd", "USSD"], ["mobile_money", "Mobile money"]].map(
                        ([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setMethod(value)}
                            className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                              method === value
                                ? "border-primary bg-accent font-medium text-primary"
                                : "border-border bg-card text-muted-foreground hover:border-primary/40"
                            }`}
                          >
                            {label}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                  <Button
                    className="h-11 w-full text-[15px]"
                    onClick={handlePay}
                    disabled={paying || link.status !== "active" || link.expired || link.usesExhausted}
                  >
                    {paying ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                    Pay {link.amountMinor != null ? formatMoney(link.amountMinor, link.currency) : ""}
                  </Button>
                  <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                    <ShieldCheck className="size-3.5" /> {link.environment === "production" ? "Secured by USOPGRID. Card details are handled by the payment provider." : "Secured by USOPGRID. Test environment: no real money moves."}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          <a href="/" className="underline-offset-2 hover:underline">Payment infrastructure by USOPGRID</a>
        </p>
      </div>
    </div>
  );
}
