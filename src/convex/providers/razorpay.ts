// Razorpay adapter — Payment Links + Payments API (India).
// Docs: https://razorpay.com/docs/api/payments/payment-links/ ,
//       https://razorpay.com/docs/webhooks/validate-test/
// Auth: HTTP Basic key_id:key_secret (rzp_test_ / rzp_live_ keys).
// Amounts: minor units (paise). Webhooks: X-Razorpay-Signature =
// HMAC-SHA256(webhook secret, raw body), hex.

import type { ProviderAdapter, ChargeResult, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get } from "./http";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";

const API = "https://api.razorpay.com/v1";
const NAME = "Razorpay";

function headers(ctx: AdapterContext): Record<string, string> {
  const id = requireCredential(ctx, "keyId", NAME);
  const secret = requireCredential(ctx, "keySecret", NAME);
  return { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/json" };
}

function mapLink(j: unknown): ChargeResult {
  const s = str(j, "status");
  const id = str(j, "id");
  const payments = (get(j, "payments") as { payment_id: string; status: string }[] | null) ?? [];
  const captured = payments.find((p) => p.status === "captured");
  const reported = { reportedAmountMinor: Number(get(j, "amount_paid")) || undefined, reportedCurrency: str(j, "currency") };
  if (s === "paid") return { status: "successful", providerReference: captured?.payment_id ?? id, providerStatus: s, ...reported };
  if (s === "expired" || s === "cancelled") {
    return { status: "failed", providerReference: id, providerStatus: s, failure: failure("customer_cancellation", `link_${s}`, `Payment link ${s}.`) };
  }
  return { status: "pending", providerReference: id, providerStatus: s };
}

export const razorpayAdapter: ProviderAdapter = {
  descriptor: {
    id: "razorpay",
    displayName: "Razorpay",
    category: "regional_psp",
    description: "India's full-stack PSP: UPI, cards, netbanking, wallets and EMI.",
    website: "https://razorpay.com",
    docsUrl: "https://razorpay.com/docs/api/",
    countries: ["IN", "MY"],
    currencies: ["INR", "MYR", "USD", "EUR", "GBP", "SGD", "AED", "AUD", "CAD"],
    methods: ["upi", "card", "wallet", "bank_transfer", "open_banking", "bnpl"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true },
    limits: { INR: { minMinor: 100 } },
    pricing: { pctBps: 200, fixedMinor: 0, fixedCurrency: "INR", notes: "Standard plan 2% domestic; UPI pricing per current RBI/NPCI rules." },
    credentials: [
      { key: "keyId", label: "Key ID (rzp_…)", secret: false, required: true },
      { key: "keySecret", label: "Key secret", secret: true, required: true },
      { key: "webhookSecret", label: "Webhook secret", secret: true, required: true },
    ],
    envCredentials: { keyId: "RAZORPAY_KEY_ID", keySecret: "RAZORPAY_KEY_SECRET", webhookSecret: "RAZORPAY_WEBHOOK_SECRET" },
  },

  async charge(ctx, req) {
    const o = await providerFetch(ctx, `${API}/payment_links`, {
      method: "POST",
      headers: headers(ctx),
      body: JSON.stringify({
        amount: req.amountMinor,
        currency: req.currency,
        reference_id: req.transactionId.slice(0, 40),
        description: (req.description ?? req.reference).slice(0, 2048),
        customer: { name: req.customer?.name, email: req.customer?.email, contact: req.customer?.phone },
        notify: { sms: false, email: false },
        callback_url: req.returnUrl,
        callback_method: req.returnUrl ? "get" : undefined,
        notes: { usopgrid_transaction_id: req.transactionId, usopgrid_reference: req.reference.slice(0, 256) },
      }),
    });
    if (o.kind === "response" && o.status === 200) {
      return { status: "requires_action", providerReference: str(o.json, "id"), providerStatus: str(o.json, "status"), nextAction: { type: "redirect", url: str(o.json, "short_url") } };
    }
    if (o.kind === "response" && o.status === 400 && /reference_id.*already/i.test(str(o.json, "error.description") ?? "")) {
      return { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    if (q.providerReference?.startsWith("pay_")) {
      const o = await providerFetch(ctx, `${API}/payments/${q.providerReference}`, { method: "GET", headers: headers(ctx) });
      if (o.kind === "response" && o.status === 200) {
        const s = str(o.json, "status");
        const rep = { reportedAmountMinor: Number(get(o.json, "amount")) || undefined, reportedCurrency: str(o.json, "currency") };
        if (s === "captured") return { status: "successful", providerReference: q.providerReference, providerStatus: s, ...rep };
        if (s === "failed") {
          return { status: "declined", providerReference: q.providerReference, providerStatus: s, failure: failure("issuer_decline", str(o.json, "error_code") ?? "failed", str(o.json, "error_description") ?? "Payment failed") };
        }
        return { status: "pending", providerReference: q.providerReference, providerStatus: s };
      }
      return { status: "unknown" };
    }
    if (!q.providerReference) return { status: "unknown" };
    const o = await providerFetch(ctx, `${API}/payment_links/${q.providerReference}`, { method: "GET", headers: headers(ctx) });
    if (o.kind === "response" && o.status === 200) return mapLink(o.json);
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    if (!req.providerReference?.startsWith("pay_")) {
      return { status: "failed", failure: failure("invalid_payment_information", "missing_payment_id", "No captured Razorpay payment id to refund.") };
    }
    const o = await providerFetch(ctx, `${API}/payments/${req.providerReference}/refund`, {
      method: "POST",
      headers: { ...headers(ctx), "X-Razorpay-Idempotency-Key": req.idempotencyKey },
      body: JSON.stringify({ amount: req.amountMinor, receipt: req.refundId.slice(0, 40), notes: { reason: req.reason } }),
    });
    if (o.kind === "response" && o.status === 200) {
      return { status: str(o.json, "status") === "processed" ? "successful" : "pending", providerRefundReference: str(o.json, "id") };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const secret = ctx.credentials.webhookSecret;
    const sig = input.headers.get("x-razorpay-signature");
    if (!secret || !sig) return false;
    return timingSafeEqual(await hmacSha256Hex(secret, input.rawBody), sig);
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody);
    const type = str(evt, "event") ?? "";
    const pay = get(evt, "payload.payment.entity");
    const link = get(evt, "payload.payment_link.entity");
    const refund = get(evt, "payload.refund.entity");
    const eventId = input.headers.get("x-razorpay-event-id") ?? `${type}:${str(pay, "id") ?? str(link, "id") ?? str(refund, "id")}`;
    if (type === "payment_link.paid") {
      return [{ eventId, type: "payment", rawType: type, status: "successful", providerReference: str(pay, "id"), reference: str(link, "reference_id"), amountMinor: Number(get(link, "amount_paid")) || undefined, currency: str(link, "currency") }];
    }
    if (type === "payment.captured" || type === "payment.failed") {
      return [
        {
          eventId,
          type: "payment",
          rawType: type,
          status: type === "payment.captured" ? "successful" : "declined",
          providerReference: str(pay, "id"),
          reference: str(pay, "notes.usopgrid_transaction_id"),
          amountMinor: Number(get(pay, "amount")) || undefined,
          currency: str(pay, "currency"),
          failure: type === "payment.failed" ? failure("issuer_decline", str(pay, "error_code") ?? "failed", str(pay, "error_description") ?? "Payment failed") : undefined,
        },
      ];
    }
    if (type === "refund.processed") {
      return [{ eventId, type: "refund", rawType: type, status: "refunded", providerReference: str(refund, "payment_id"), amountMinor: Number(get(refund, "amount")) || undefined, currency: str(refund, "currency") }];
    }
    return [{ eventId, type: "other", rawType: type }];
  },
};
