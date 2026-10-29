// Checkout.com adapter — Unified Payments API.
// Docs: https://api-reference.checkout.com/ , https://www.checkout.com/docs/workflows/set-up-your-webhook-receiver
// Auth: Bearer secret key. Sandbox: api.sandbox.checkout.com, live: api.checkout.com.
// Amounts: minor units. Idempotency: Cko-Idempotency-Key.
// Webhooks: Cko-Signature = HMAC-SHA256(signature key, raw body), lowercase hex.

import type { ProviderAdapter, ChargeResult, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get } from "./http";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";

const NAME = "Checkout.com";

const base = (ctx: AdapterContext) =>
  ctx.environment === "sandbox" ? "https://api.sandbox.checkout.com" : "https://api.checkout.com";

function headers(ctx: AdapterContext, idem?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`,
    "Content-Type": "application/json",
  };
  if (idem) h["Cko-Idempotency-Key"] = idem;
  return h;
}

function mapPayment(j: unknown): ChargeResult {
  const s = str(j, "status");
  const id = str(j, "id");
  const approved = get(j, "approved");
  const code = str(j, "response_code");
  const summary = str(j, "response_summary") ?? "Declined";
  if (s === "Authorized" || s === "Captured" || s === "Paid" || s === "Card Verified") {
    return {
      status: approved === false ? "declined" : "successful",
      providerReference: id,
      providerStatus: s,
      reportedAmountMinor: Number(get(j, "amount")) || undefined,
      reportedCurrency: str(j, "currency"),
    };
  }
  if (s === "Pending") {
    const url = str(j, "_links.redirect.href");
    return url
      ? { status: "requires_action", providerReference: id, providerStatus: s, nextAction: { type: "redirect", url } }
      : { status: "pending", providerReference: id, providerStatus: s };
  }
  if (s === "Declined") {
    const cat =
      code === "20051"
        ? failure("insufficient_funds", "insufficient_funds", summary, { providerCode: code })
        : code?.startsWith("20") || code?.startsWith("30")
          ? failure("issuer_decline", "declined", summary, { providerCode: code })
          : code?.startsWith("4")
            ? failure("fraud_rejection", "risk_declined", summary, { providerCode: code })
            : failure("issuer_decline", "declined", summary, { providerCode: code });
    return { status: "declined", providerReference: id, providerStatus: s, failure: cat };
  }
  if (s === "Voided" || s === "Canceled" || s === "Expired") {
    return { status: "failed", providerReference: id, providerStatus: s, failure: failure("customer_cancellation", s.toLowerCase(), `Payment ${s.toLowerCase()}.`) };
  }
  if (s === "Refunded" || s === "Partially Refunded") return { status: "successful", providerReference: id, providerStatus: s };
  return { status: "unknown", providerReference: id, providerStatus: s };
}

export const checkoutComAdapter: ProviderAdapter = {
  descriptor: {
    id: "checkoutcom",
    displayName: "Checkout.com",
    category: "global_acquirer",
    description: "Global acquiring with strong coverage in Europe, the Middle East and Asia-Pacific.",
    website: "https://www.checkout.com",
    docsUrl: "https://api-reference.checkout.com/",
    countries: "global",
    currencies: "all",
    methods: ["card", "wallet", "bank_transfer", "open_banking", "bnpl"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true },
    pricing: { pctBps: 0, fixedMinor: 0, fixedCurrency: "USD", notes: "Custom interchange++ pricing; set the agreed rate on the connection." },
    credentials: [
      { key: "secretKey", label: "Secret key (sk_…)", secret: true, required: true },
      { key: "processingChannelId", label: "Processing channel ID (pc_…)", secret: false, required: true },
      { key: "webhookSignatureKey", label: "Webhook signature key", secret: true, required: true },
    ],
    envCredentials: {
      secretKey: "CHECKOUTCOM_SECRET_KEY",
      processingChannelId: "CHECKOUTCOM_PROCESSING_CHANNEL_ID",
      webhookSignatureKey: "CHECKOUTCOM_WEBHOOK_KEY",
    },
  },

  async charge(ctx, req) {
    const channel = requireCredential(ctx, "processingChannelId", NAME);
    if (!req.paymentToken) {
      // Hosted Payments Page when no tokenized source is supplied.
      const o = await providerFetch(ctx, `${base(ctx)}/hosted-payments`, {
        method: "POST",
        headers: headers(ctx, req.idempotencyKey),
        body: JSON.stringify({
          amount: req.amountMinor,
          currency: req.currency,
          reference: req.transactionId,
          processing_channel_id: channel,
          billing: { address: { country: req.country ?? "US" } },
          customer: req.customer?.email ? { email: req.customer.email, name: req.customer.name } : undefined,
          success_url: req.returnUrl ?? "https://usopgrid.com/checkout/success",
          failure_url: req.returnUrl ?? "https://usopgrid.com/checkout/failure",
          cancel_url: req.returnUrl ?? "https://usopgrid.com/checkout/cancel",
          metadata: { usopgrid_transaction_id: req.transactionId },
        }),
      });
      if (o.kind === "response" && o.status >= 200 && o.status < 300) {
        return {
          status: "requires_action",
          providerReference: str(o.json, "id"),
          nextAction: { type: "redirect", url: str(o.json, "_links.redirect.href") },
        };
      }
      const f = classifyHttpFailure(o, NAME);
      return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const o = await providerFetch(ctx, `${base(ctx)}/payments`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: JSON.stringify({
        source: { type: "token", token: req.paymentToken },
        amount: req.amountMinor,
        currency: req.currency,
        reference: req.transactionId,
        processing_channel_id: channel,
        capture: true,
        "3ds": { enabled: true },
        success_url: req.returnUrl,
        failure_url: req.returnUrl,
        customer: req.customer?.email ? { email: req.customer.email, name: req.customer.name } : undefined,
        metadata: { usopgrid_transaction_id: req.transactionId, usopgrid_reference: req.reference },
      }),
    });
    if (o.kind === "response" && (o.status === 201 || o.status === 202 || o.status === 200)) return mapPayment(o.json);
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    const url = q.providerReference
      ? `${base(ctx)}/payments/${encodeURIComponent(q.providerReference)}`
      : `${base(ctx)}/payments?reference=${encodeURIComponent(q.transactionId)}`;
    const o = await providerFetch(ctx, url, { method: "GET", headers: headers(ctx) });
    if (o.kind === "response" && o.status === 200) {
      if (q.providerReference) return mapPayment(o.json);
      const first = (get(o.json, "data") as unknown[] | undefined)?.[0];
      if (!first) return { status: "failed", failure: failure("network_error", "not_found_at_provider", "No payment at Checkout.com.", { safeToFailover: true }) };
      return mapPayment(first);
    }
    if (o.kind === "response" && o.status === 404) {
      return { status: "failed", failure: failure("network_error", "not_found_at_provider", "No payment at Checkout.com.", { safeToFailover: true }) };
    }
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    const o = await providerFetch(ctx, `${base(ctx)}/payments/${encodeURIComponent(req.providerReference ?? "")}/refunds`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: JSON.stringify({ amount: req.amountMinor, reference: req.refundId }),
    });
    if (o.kind === "response" && o.status === 202) return { status: "pending", providerRefundReference: str(o.json, "action_id") };
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const key = ctx.credentials.webhookSignatureKey;
    const sig = input.headers.get("cko-signature");
    if (!key || !sig) return false;
    const expected = await hmacSha256Hex(key, input.rawBody);
    return timingSafeEqual(expected, sig.trim().toLowerCase());
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody);
    const type = str(evt, "type") ?? "";
    const d = get(evt, "data");
    const ev = {
      eventId: str(evt, "id") ?? `${str(d, "id")}:${type}`,
      rawType: type,
      providerReference: str(d, "id"),
      reference: str(d, "reference"),
      amountMinor: Number(get(d, "amount")) || undefined,
      currency: str(d, "currency"),
      occurredAt: Date.parse(str(evt, "created_on") ?? "") || undefined,
    };
    const map: Record<string, { type: "payment" | "refund" | "dispute"; status: string; fail?: boolean }> = {
      payment_approved: { type: "payment", status: "successful" },
      payment_captured: { type: "payment", status: "successful" },
      payment_pending: { type: "payment", status: "pending" },
      payment_declined: { type: "payment", status: "declined", fail: true },
      payment_expired: { type: "payment", status: "failed", fail: true },
      payment_canceled: { type: "payment", status: "failed", fail: true },
      payment_refunded: { type: "refund", status: "refunded" },
      dispute_received: { type: "dispute", status: "dispute_opened" },
      dispute_won: { type: "dispute", status: "dispute_won" },
      dispute_lost: { type: "dispute", status: "dispute_lost" },
    };
    const m = map[type];
    if (!m) return [{ ...ev, type: "other" }];
    return [
      {
        ...ev,
        type: m.type,
        status: m.status as never,
        failure: m.fail ? failure("issuer_decline", type, str(d, "response_summary") ?? type) : undefined,
      },
    ];
  },
};
