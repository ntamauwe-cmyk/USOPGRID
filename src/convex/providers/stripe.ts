// Stripe adapter — PaymentIntents API.
// Docs: https://docs.stripe.com/api/payment_intents , https://docs.stripe.com/webhooks#verify-manually
// Auth: Bearer secret key. Body: application/x-www-form-urlencoded. Amounts: minor units.
// Idempotency: Idempotency-Key header. Webhooks: Stripe-Signature "t=…,v1=…" =
// HMAC-SHA256(whsec, `${t}.${rawBody}`) hex, 5-minute tolerance.

import type { ProviderAdapter, ChargeResult, ProviderEvent, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, formEncode, requireCredential, str, get } from "./http";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";

const API = "https://api.stripe.com/v1";
const NAME = "Stripe";
const TOLERANCE_S = 300;

// Stripe presentment currencies are broad but not literally every ISO code.
const STRIPE_UNSUPPORTED = new Set(["IRR", "KPW", "SYP", "CUP", "SDG", "VES", "MRU", "STN", "SSP", "ERN", "BYN", "TMT"]);

function headers(ctx: AdapterContext, idem?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": "2024-06-20",
  };
  if (idem) h["Idempotency-Key"] = idem;
  return h;
}

function mapIntent(pi: unknown): ChargeResult {
  const status = str(pi, "status");
  const id = str(pi, "id");
  const lastErr = get(pi, "last_payment_error");
  switch (status) {
    case "succeeded":
      return {
        status: "successful",
        providerReference: id,
        providerStatus: status,
        reportedAmountMinor: Number(get(pi, "amount_received") ?? get(pi, "amount")) || undefined,
        reportedCurrency: str(pi, "currency")?.toUpperCase(),
      };
    case "processing":
      return { status: "pending", providerReference: id, providerStatus: status };
    case "requires_action": {
      const url = str(pi, "next_action.redirect_to_url.url");
      return {
        status: "requires_action",
        providerReference: id,
        providerStatus: status,
        nextAction: url ? { type: "redirect", url } : { type: "await_customer_confirmation" },
      };
    }
    case "requires_payment_method":
      if (lastErr) {
        return {
          status: "declined",
          providerReference: id,
          providerStatus: status,
          failure: declineFrom(str(lastErr, "decline_code") ?? str(lastErr, "code"), str(lastErr, "message")),
        };
      }
      return { status: "requires_action", providerReference: id, providerStatus: status, nextAction: { type: "await_customer_confirmation" } };
    case "requires_confirmation":
    case "requires_capture":
      return { status: "pending", providerReference: id, providerStatus: status };
    case "canceled":
      return {
        status: "failed",
        providerReference: id,
        providerStatus: status,
        failure: failure("customer_cancellation", "stripe_canceled", "The PaymentIntent was canceled."),
      };
    default:
      return { status: "unknown", providerReference: id, providerStatus: status };
  }
}

function declineFrom(code: string | undefined, message: string | undefined) {
  const m = message ?? "The card was declined.";
  switch (code) {
    case "insufficient_funds":
      return failure("insufficient_funds", "insufficient_funds", m, { providerCode: code });
    case "fraudulent":
    case "stolen_card":
    case "lost_card":
    case "pickup_card":
      return failure("fraud_rejection", "card_declined_fraud", m, { providerCode: code });
    case "incorrect_number":
    case "invalid_number":
    case "invalid_expiry_year":
    case "invalid_cvc":
    case "expired_card":
      return failure("invalid_payment_information", code, m, { providerCode: code });
    case "processing_error":
    case "try_again_later":
      return failure("temporary_provider_failure", code, m, { retryable: true, providerCode: code });
    default:
      return failure("issuer_decline", "card_declined", m, { providerCode: code });
  }
}

export const stripeAdapter: ProviderAdapter = {
  descriptor: {
    id: "stripe",
    displayName: "Stripe",
    category: "global_acquirer",
    description: "Global card acquiring, wallets and local methods with strong developer tooling.",
    website: "https://stripe.com",
    docsUrl: "https://docs.stripe.com/api",
    countries: "global",
    currencies: "all",
    methods: ["card", "wallet", "bank_transfer", "direct_debit", "bnpl", "open_banking"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true, recurring: true },
    limits: { USD: { minMinor: 50, maxMinor: 99_999_999 }, EUR: { minMinor: 50 }, GBP: { minMinor: 30 } },
    pricing: { pctBps: 290, fixedMinor: 30, fixedCurrency: "USD", notes: "US list price for domestic cards; varies by country and method." },
    credentials: [
      { key: "secretKey", label: "Secret key (sk_…)", secret: true, required: true },
      { key: "webhookSecret", label: "Webhook signing secret (whsec_…)", secret: true, required: true },
    ],
    envCredentials: { secretKey: "STRIPE_SECRET_KEY", webhookSecret: "STRIPE_WEBHOOK_SECRET" },
  },

  async charge(ctx, req) {
    if (STRIPE_UNSUPPORTED.has(req.currency)) {
      return { status: "failed", failure: failure("unsupported", "currency_unsupported", `Stripe does not support ${req.currency}.`, { safeToFailover: true }) };
    }
    const body: Record<string, unknown> = {
      amount: req.amountMinor,
      currency: req.currency.toLowerCase(),
      description: req.description ?? `USOPGRID ${req.reference}`,
      receipt_email: req.customer?.email,
      metadata: { usopgrid_transaction_id: req.transactionId, usopgrid_reference: req.reference },
    };
    if (req.recurring) {
      // Saved method: "cus_…|pm_…", charged off-session (customer not present).
      const [customer, pm] = (req.paymentToken ?? "").split("|");
      if (!customer?.startsWith("cus_") || !pm?.startsWith("pm_")) {
        return { status: "failed", failure: failure("invalid_payment_information", "bad_saved_method", "Saved Stripe payment method is malformed.", { safeToFailover: false }) };
      }
      Object.assign(body, { customer, payment_method: pm, off_session: "true", confirm: "true" });
    } else if (req.paymentToken) {
      body.payment_method = req.paymentToken;
      body.confirm = "true";
      if (req.returnUrl) body.return_url = req.returnUrl;
      if (req.savePaymentMethod) {
        // Keep the card for future off-session charges: needs a Stripe customer.
        const c = await providerFetch(ctx, `${API}/customers`, {
          method: "POST",
          headers: headers(ctx, `${req.idempotencyKey}:customer`),
          body: formEncode({ email: req.customer?.email, name: req.customer?.name, metadata: { usopgrid_transaction_id: req.transactionId } }),
        });
        const customerId = c.kind === "response" && c.status < 300 ? str(c.json, "id") : undefined;
        if (customerId) Object.assign(body, { customer: customerId, setup_future_usage: "off_session", expand: ["payment_method"] });
      }
    } else {
      body.automatic_payment_methods = { enabled: "true" };
    }
    const o = await providerFetch(ctx, `${API}/payment_intents`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: formEncode(body),
    });
    if (o.kind === "response" && o.status >= 200 && o.status < 300) {
      const r = mapIntent(o.json);
      const cust = str(o.json, "customer");
      const pmId = str(o.json, "payment_method.id") ?? str(o.json, "payment_method");
      if (req.savePaymentMethod && r.status === "successful" && cust && pmId?.startsWith("pm_")) {
        r.reusableToken = {
          token: `${cust}|${pmId}`,
          brand: str(o.json, "payment_method.card.brand"),
          last4: str(o.json, "payment_method.card.last4"),
          expMonth: Number(get(o.json, "payment_method.card.exp_month")) || undefined,
          expYear: Number(get(o.json, "payment_method.card.exp_year")) || undefined,
        };
      }
      if (!req.paymentToken && r.status === "requires_action") {
        r.nextAction = {
          type: "await_customer_confirmation",
          instructions: `Confirm client-side with client_secret ${str(o.json, "client_secret")?.slice(0, 8)}…`,
        };
      }
      return r;
    }
    if (o.kind === "response" && o.status === 402) {
      // Card error: Stripe returns the (failed) intent inside error.payment_intent.
      return {
        status: "declined",
        providerReference: str(o.json, "error.payment_intent.id"),
        failure: declineFrom(str(o.json, "error.decline_code") ?? str(o.json, "error.code"), str(o.json, "error.message")),
      };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    if (q.providerReference) {
      const o = await providerFetch(ctx, `${API}/payment_intents/${encodeURIComponent(q.providerReference)}`, {
        method: "GET",
        headers: headers(ctx),
      });
      if (o.kind === "response" && o.status === 200) return mapIntent(o.json);
      return { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    // No intent id (create timed out): search by our metadata.
    const query = encodeURIComponent(`metadata['usopgrid_transaction_id']:'${q.transactionId}'`);
    const o = await providerFetch(ctx, `${API}/payment_intents/search?query=${query}`, { method: "GET", headers: headers(ctx) });
    if (o.kind === "response" && o.status === 200) {
      const first = (get(o.json, "data") as unknown[] | undefined)?.[0];
      if (!first) {
        return { status: "failed", failure: failure("network_error", "not_found_at_provider", "Stripe has no record of this payment.", { safeToFailover: true }) };
      }
      return mapIntent(first);
    }
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    const o = await providerFetch(ctx, `${API}/refunds`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: formEncode({
        payment_intent: req.providerReference,
        amount: req.amountMinor,
        metadata: { usopgrid_refund_id: req.refundId },
      }),
    });
    if (o.kind === "response" && o.status >= 200 && o.status < 300) {
      const s = str(o.json, "status");
      return {
        status: s === "succeeded" ? "successful" : s === "failed" || s === "canceled" ? "failed" : "pending",
        providerRefundReference: str(o.json, "id"),
        failure: s === "failed" ? failure("temporary_provider_failure", "refund_failed", str(o.json, "failure_reason") ?? "Refund failed") : undefined,
      };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const secret = ctx.credentials.webhookSecret;
    const header = input.headers.get("stripe-signature");
    if (!secret || !header) return false;
    const parts = Object.fromEntries(
      header.split(",").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      }),
    ) as Record<string, string>;
    const t = Number(parts.t);
    if (!Number.isFinite(t) || Math.abs(ctx.now() / 1000 - t) > TOLERANCE_S) return false;
    const expected = await hmacSha256Hex(secret, `${parts.t}.${input.rawBody}`);
    const candidates = header
      .split(",")
      .filter((kv) => kv.trim().startsWith("v1="))
      .map((kv) => kv.trim().slice(3));
    return candidates.some((c) => timingSafeEqual(c, expected));
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody) as Record<string, unknown>;
    const type = String(evt.type ?? "");
    const obj = get(evt, "data.object");
    const base = {
      eventId: String(evt.id),
      rawType: type,
      occurredAt: typeof evt.created === "number" ? evt.created * 1000 : undefined,
    };
    const out: ProviderEvent[] = [];
    if (type.startsWith("payment_intent.")) {
      const mapped = mapIntent(obj);
      out.push({
        ...base,
        type: "payment",
        status: mapped.status,
        providerReference: str(obj, "id"),
        reference: str(obj, "metadata.usopgrid_transaction_id"),
        amountMinor: Number(get(obj, "amount") ?? 0) || undefined,
        currency: str(obj, "currency")?.toUpperCase(),
        failure: mapped.failure,
      });
    } else if (type === "charge.refunded" || type.startsWith("refund.")) {
      const refunded = Number(get(obj, "amount_refunded") ?? 0);
      const amount = Number(get(obj, "amount") ?? 0);
      out.push({
        ...base,
        type: "refund",
        status: type === "charge.refunded" ? (refunded >= amount ? "refunded" : "partially_refunded") : undefined,
        providerReference: str(obj, "payment_intent"),
        amountMinor: refunded || undefined,
        currency: str(obj, "currency")?.toUpperCase(),
      });
    } else if (type.startsWith("charge.dispute.")) {
      const s = str(obj, "status");
      out.push({
        ...base,
        type: "dispute",
        status: type.endsWith("created") ? "dispute_opened" : s === "won" ? "dispute_won" : s === "lost" ? "dispute_lost" : undefined,
        providerReference: str(obj, "payment_intent"),
        amountMinor: Number(get(obj, "amount") ?? 0) || undefined,
        currency: str(obj, "currency")?.toUpperCase(),
      });
    } else {
      out.push({ ...base, type: "other" });
    }
    return out;
  },
};
