// USOPGRID public checkout — pays a payment link through POST /api/v1/checkout.
// Public page (no auth): shows only link-safe fields.
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/kit";
import { formatMoney } from "@/lib/money";
import { Loader2, CheckCircle2, CircleAlert, ShieldCheck } from "lucide-react";
import { UsopgridMark } from "@/components/brand";
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
    <div className="flex min-h-screen items-center justify-center bg-[#080A24] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5 text-zinc-300">
          <UsopgridMark tone="onDark" className="size-7" />
          <span className="text-xs font-bold uppercase tracking-[0.22em]">USOPGRID</span>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur">
          {loadState === "loading" && (
            <div className="flex flex-col items-center py-12 text-zinc-400">
              <Loader2 className="size-6 animate-spin" />
              <p className="mt-3 text-sm">Loading payment link…</p>
            </div>
          )}

          {loadState === "error" && (
            <div className="flex flex-col items-center py-12 text-center">
              <CircleAlert className="size-8 text-red-400" />
              <p className="mt-3 text-sm font-medium text-zinc-200">Link unavailable</p>
              <p className="mt-1 text-sm text-zinc-500">{loadError}</p>
              <a href="/" className="mt-4 text-xs text-zinc-400 underline-offset-2 hover:underline">
                Powered by USOPGRID
              </a>
            </div>
          )}

          {loadState === "ready" && link && (
            <>
              <div className="mb-1 text-xs uppercase tracking-wider text-zinc-500">
                {link.merchantName}
              </div>
              <h1 className="text-lg font-semibold text-zinc-100">{link.title}</h1>
              {link.description && (
                <p className="mt-1 text-sm text-zinc-400">{link.description}</p>
              )}
              <p className="mt-3 text-3xl font-bold tabular-nums text-white">
                {link.amountMinor != null
                  ? formatMoney(link.amountMinor, link.currency)
                  : `Open amount · ${link.currency}`}
              </p>

              {result ? (
                <div className="mt-6">
                  {result.ok ? (
                    <div className="flex flex-col items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center">
                      <CheckCircle2 className="size-10 text-emerald-400" />
                      <p className="mt-3 font-semibold text-emerald-200">Payment successful</p>
                      <p className="mt-1 text-sm text-emerald-200/70">
                        {result.payment?.id && <>Reference {result.payment.id} · </>}
                        {formatMoney(result.payment?.amount ?? 0, result.payment?.currency ?? link.currency)}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
                      <CircleAlert className="size-10 text-red-400" />
                      <p className="mt-3 font-semibold text-red-200">Payment failed</p>
                      <p className="mt-1 text-sm text-red-200/70">{result.message}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4 border-white/20 bg-transparent text-white hover:bg-white/10"
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
                      <Label htmlFor="co-amount" className="text-zinc-300">Amount</Label>
                      <Input
                        id="co-amount"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="2500.00"
                        inputMode="decimal"
                        className="border-white/15 bg-white/5 text-zinc-100 placeholder:text-zinc-600"
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="co-email" className="text-zinc-300">Email</Label>
                    <Input
                      id="co-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="border-white/15 bg-white/5 text-zinc-100 placeholder:text-zinc-600"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="co-name" className="text-zinc-300">Name (optional)</Label>
                    <Input
                      id="co-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      className="border-white/15 bg-white/5 text-zinc-100 placeholder:text-zinc-600"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-zinc-300">Payment method</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {[["card", "Card"], ["bank_transfer", "Bank transfer"], ["ussd", "USSD"], ["mobile_money", "Mobile money"]].map(
                        ([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setMethod(value)}
                            className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                              method === value
                                ? "border-violet-400/60 bg-violet-500/15 text-violet-200"
                                : "border-white/10 bg-white/5 text-zinc-400 hover:border-white/20"
                            }`}
                          >
                            {label}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                  <Button
                    className="w-full bg-white text-zinc-900 hover:bg-zinc-200"
                    onClick={handlePay}
                    disabled={paying || link.status !== "active" || link.expired || link.usesExhausted}
                  >
                    {paying ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                    Pay {link.amountMinor != null ? formatMoney(link.amountMinor, link.currency) : ""}
                  </Button>
                  <p className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-500">
                    <ShieldCheck className="size-3.5" /> {link.environment === "production" ? "Secured by USOPGRID. Card details are handled by the payment provider." : "Secured by USOPGRID. Test environment: no real money moves."}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-zinc-600">
          <a href="/" className="underline-offset-2 hover:underline">Payment infrastructure by USOPGRID</a>
        </p>
      </div>
    </div>
  );
}
