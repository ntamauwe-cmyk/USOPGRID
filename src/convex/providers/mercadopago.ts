// Mercado Pago adapter — Checkout Pro preferences + Payments API (Latin America).
// Docs: https://www.mercadopago.com/developers/en/reference ,
//       https://www.mercadopago.com/developers/en/docs/your-integrations/notifications/webhooks
// Auth: Bearer access token (TEST-… / APP_USR-…). AMOUNTS ARE MAJOR UNITS.
// Idempotency: X-Idempotency-Key. Webhooks: x-signature "ts=…,v1=…" where
// v1 = HMAC-SHA256(secret, "id:{data.id};request-id:{x-request-id};ts:{ts};"), hex.
// Notifications carry only an id, so status always comes from a lookup.

import type { ProviderAdapter, ChargeResult, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get, callbackUrl } from "./http";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";
import { minorToDecimalString, decimalToMinor } from "../../lib/money";

const API = "https://api.mercadopago.com";
const NAME = "Mercado Pago";

function headers(ctx: AdapterContext, idem?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${requireCredential(ctx, "accessToken", NAME)}`,
    "Content-Type": "application/json",
  };
  if (idem) h["X-Idempotency-Key"] = idem;
  return h;
}

function mapPayment(p: unknown): ChargeResult {
  const s = str(p, "status");
  const id = str(p, "id");
  const detail = str(p, "status_detail") ?? s ?? "";
  const cur = str(p, "currency_id");
  let reportedAmountMinor: number | undefined;
  try {
    reportedAmountMinor = cur && get(p, "transaction_amount") !== undefined ? decimalToMinor(get(p, "transaction_amount") as number, cur) : undefined;
  } catch {
    reportedAmountMinor = undefined;
  }
  const rep = { reportedAmountMinor, reportedCurrency: cur };
  switch (s) {
    case "approved":
      return { status: "successful", providerReference: id, providerStatus: s, ...rep };
    case "authorized":
    case "pending":
    case "in_process":
    case "in_mediation":
      return { status: "pending", providerReference: id, providerStatus: s };
    case "rejected":
      return {
        status: "declined",
        providerReference: id,
        providerStatus: s,
        failure: /insufficient/.test(detail)
          ? failure("insufficient_funds", detail, "Insufficient funds.")
          : /high_risk|blacklist/.test(detail)
            ? failure("fraud_rejection", detail, "Rejected by risk controls.")
            : failure("issuer_decline", detail, "Payment rejected."),
      };
    case "cancelled":
      return { status: "failed", providerReference: id, providerStatus: s, failure: failure("customer_cancellation", detail, "Payment cancelled.") };
    case "refunded":
    case "charged_back":
      return { status: "successful", providerReference: id, providerStatus: s, ...rep };
    default:
      return { status: "unknown", providerReference: id, providerStatus: s };
  }
}

export const mercadoPagoAdapter: ProviderAdapter = {
  descriptor: {
    id: "mercadopago",
    displayName: "Mercado Pago",
    category: "regional_psp",
    description: "Latin America's largest PSP: cards with installments, Pix, boleto/OXXO cash, wallet.",
    website: "https://www.mercadopago.com",
    docsUrl: "https://www.mercadopago.com/developers/en/reference",
    countries: ["AR", "BR", "MX", "CL", "CO", "PE", "UY"],
    currencies: ["ARS", "BRL", "MXN", "CLP", "COP", "PEN", "UYU"],
    methods: ["card", "pix", "cash_voucher", "bank_transfer", "wallet"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true },
    pricing: { pctBps: 399, fixedMinor: 0, fixedCurrency: "BRL", notes: "Brazil Checkout Pro immediate release ~3.99–4.98%; Pix ~0.99%. Varies by country/release term." },
    credentials: [
      { key: "accessToken", label: "Access token", secret: true, required: true },
      { key: "webhookSecret", label: "Webhook secret signature", secret: true, required: true },
    ],
    envCredentials: { accessToken: "MERCADOPAGO_ACCESS_TOKEN", webhookSecret: "MERCADOPAGO_WEBHOOK_SECRET" },
  },

  async charge(ctx, req) {
    const unitPrice = Number(minorToDecimalString(req.amountMinor, req.currency));
    if (req.paymentToken) {
      const o = await providerFetch(ctx, `${API}/v1/payments`, {
        method: "POST",
        headers: headers(ctx, req.idempotencyKey),
        body: JSON.stringify({
          transaction_amount: unitPrice,
          token: req.paymentToken,
          description: req.description ?? req.reference,
          installments: 1,
          payer: { email: req.customer?.email },
          external_reference: req.transactionId,
          notification_url: callbackUrl(ctx, "mercadopago"),
          metadata: { usopgrid_transaction_id: req.transactionId },
        }),
      });
      if (o.kind === "response" && (o.status === 201 || o.status === 200)) return mapPayment(o.json);
      const f = classifyHttpFailure(o, NAME);
      return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const o = await providerFetch(ctx, `${API}/checkout/preferences`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: JSON.stringify({
        items: [{ title: (req.description ?? req.reference).slice(0, 250), quantity: 1, unit_price: unitPrice, currency_id: req.currency }],
        payer: req.customer?.email ? { email: req.customer.email, name: req.customer.name } : undefined,
        external_reference: req.transactionId,
        notification_url: callbackUrl(ctx, "mercadopago"),
        back_urls: req.returnUrl ? { success: req.returnUrl, failure: req.returnUrl, pending: req.returnUrl } : undefined,
        auto_return: req.returnUrl ? "approved" : undefined,
        metadata: { usopgrid_transaction_id: req.transactionId },
      }),
    });
    if (o.kind === "response" && (o.status === 201 || o.status === 200)) {
      const url = ctx.environment === "sandbox" ? str(o.json, "sandbox_init_point") : str(o.json, "init_point");
      return { status: "requires_action", providerReference: undefined, providerStatus: "preference_created", nextAction: { type: "redirect", url } };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    if (q.providerReference && /^\d+$/.test(q.providerReference)) {
      const o = await providerFetch(ctx, `${API}/v1/payments/${q.providerReference}`, { method: "GET", headers: headers(ctx) });
      if (o.kind === "response" && o.status === 200) return mapPayment(o.json);
      return { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const o = await providerFetch(ctx, `${API}/v1/payments/search?external_reference=${encodeURIComponent(q.transactionId)}&sort=date_created&criteria=desc`, {
      method: "GET",
      headers: headers(ctx),
    });
    if (o.kind === "response" && o.status === 200) {
      const results = (get(o.json, "results") as unknown[] | undefined) ?? [];
      const approved = results.find((r) => str(r, "status") === "approved");
      if (approved) return mapPayment(approved);
      if (results[0]) return mapPayment(results[0]);
      return { status: "pending", providerStatus: "no_payment_yet" };
    }
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    const o = await providerFetch(ctx, `${API}/v1/payments/${encodeURIComponent(req.providerReference ?? "")}/refunds`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: JSON.stringify({ amount: Number(minorToDecimalString(req.amountMinor, req.currency)) }),
    });
    if (o.kind === "response" && (o.status === 201 || o.status === 200)) {
      return { status: str(o.json, "status") === "approved" ? "successful" : "pending", providerRefundReference: str(o.json, "id") };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const secret = ctx.credentials.webhookSecret;
    const sig = input.headers.get("x-signature");
    const requestId = input.headers.get("x-request-id") ?? "";
    if (!secret || !sig) return false;
    const parts = Object.fromEntries(sig.split(",").map((p) => p.trim().split("=") as [string, string]));
    if (!parts.ts || !parts.v1) return false;
    const url = new URL(input.url);
    let dataId = url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? "";
    if (!dataId) {
      try {
        dataId = str(JSON.parse(input.rawBody), "data.id") ?? "";
      } catch {
        dataId = "";
      }
    }
    if (/^[a-z0-9]+$/i.test(dataId)) dataId = dataId.toLowerCase();
    let manifest = "";
    if (dataId) manifest += `id:${dataId};`;
    if (requestId) manifest += `request-id:${requestId};`;
    manifest += `ts:${parts.ts};`;
    return timingSafeEqual(await hmacSha256Hex(secret, manifest), parts.v1);
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody);
    const type = str(evt, "type") ?? str(evt, "topic") ?? "";
    const id = str(evt, "data.id");
    return [
      {
        eventId: `${str(evt, "id") ?? id}:${str(evt, "action") ?? type}`,
        type: type === "payment" ? "payment" : type === "chargebacks" ? "dispute" : "other",
        rawType: str(evt, "action") ?? type,
        providerReference: id,
        // No status in the body — the engine resolves it with getStatus().
      },
    ];
  },
};
