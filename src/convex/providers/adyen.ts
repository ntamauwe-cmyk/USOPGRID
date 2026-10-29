// Adyen adapter — Checkout API v71.
// Docs: https://docs.adyen.com/api-explorer/Checkout/71/overview
//       https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures
// Auth: X-API-Key. Test base: checkout-test.adyen.com; live base uses the
// merchant-specific prefix: {prefix}-checkout-live.adyenpayments.com.
// Amounts: minor units. Idempotency: Idempotency-Key header.
// Webhooks: HMAC-SHA256 (hex-decoded key) over 8 colon-joined fields, base64,
// in additionalData.hmacSignature. Adyen expects the receiver to reply "[accepted]".

import type { ProviderAdapter, ChargeResult, ProviderEvent, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get } from "./http";
import { hmacBase64WithKeyBytes, hexToBytes, timingSafeEqual } from "../lib/crypto";

const NAME = "Adyen";

function base(ctx: AdapterContext): string {
  if (ctx.environment === "sandbox") return "https://checkout-test.adyen.com/v71";
  const prefix = requireCredential(ctx, "liveUrlPrefix", NAME);
  return `https://${prefix}-checkout-live.adyenpayments.com/checkout/v71`;
}

function headers(ctx: AdapterContext, idem?: string): Record<string, string> {
  const h: Record<string, string> = {
    "X-API-Key": requireCredential(ctx, "apiKey", NAME),
    "Content-Type": "application/json",
  };
  if (idem) h["Idempotency-Key"] = idem;
  return h;
}

function mapResult(j: unknown): ChargeResult {
  const code = str(j, "resultCode");
  const psp = str(j, "pspReference");
  const reason = str(j, "refusalReason") ?? "Refused";
  const reasonCode = str(j, "refusalReasonCode");
  switch (code) {
    case "Authorised":
      return { status: "successful", providerReference: psp, providerStatus: code };
    case "Pending":
    case "Received":
      return { status: "pending", providerReference: psp, providerStatus: code };
    case "RedirectShopper":
    case "IdentifyShopper":
    case "ChallengeShopper":
    case "PresentToShopper": {
      const url = str(j, "action.url");
      return {
        status: "requires_action",
        providerReference: psp,
        providerStatus: code,
        nextAction: url ? { type: "redirect", url } : { type: "await_customer_confirmation" },
      };
    }
    case "Refused":
      return {
        status: "declined",
        providerReference: psp,
        providerStatus: code,
        failure:
          reasonCode === "5" || /insufficient/i.test(reason)
            ? failure("insufficient_funds", "insufficient_funds", reason, { providerCode: reasonCode })
            : /fraud/i.test(reason)
              ? failure("fraud_rejection", "refused_fraud", reason, { providerCode: reasonCode })
              : failure("issuer_decline", "refused", reason, { providerCode: reasonCode }),
      };
    case "Cancelled":
      return { status: "failed", providerReference: psp, providerStatus: code, failure: failure("customer_cancellation", "cancelled", "Cancelled.") };
    case "Error":
      return { status: "failed", providerReference: psp, providerStatus: code, failure: failure("temporary_provider_failure", "adyen_error", reason, { retryable: true }) };
    default:
      return { status: "unknown", providerReference: psp, providerStatus: code };
  }
}

export const adyenAdapter: ProviderAdapter = {
  descriptor: {
    id: "adyen",
    displayName: "Adyen",
    category: "global_acquirer",
    description: "Enterprise global acquiring with 250+ local payment methods and direct scheme connections.",
    website: "https://www.adyen.com",
    docsUrl: "https://docs.adyen.com/api-explorer/Checkout/71/overview",
    countries: "global",
    currencies: "all",
    methods: ["card", "wallet", "bank_transfer", "open_banking", "direct_debit", "bnpl", "qr", "pix", "upi", "cash_voucher"],
    operations: { charge: true, status: false, refund: true, partialRefund: true, webhooks: true, settlementReports: true },
    pricing: { pctBps: 0, fixedMinor: 13, fixedCurrency: "USD", notes: "Interchange++ plus processing fee; scheme/interchange costs passed through." },
    credentials: [
      { key: "apiKey", label: "API key", secret: true, required: true },
      { key: "merchantAccount", label: "Merchant account", secret: false, required: true },
      { key: "hmacKey", label: "Webhook HMAC key (hex)", secret: true, required: true },
      { key: "liveUrlPrefix", label: "Live URL prefix", secret: false, required: false, help: "Required for production" },
    ],
    envCredentials: {
      apiKey: "ADYEN_API_KEY",
      merchantAccount: "ADYEN_MERCHANT_ACCOUNT",
      hmacKey: "ADYEN_HMAC_KEY",
      liveUrlPrefix: "ADYEN_LIVE_URL_PREFIX",
    },
  },

  async charge(ctx, req) {
    const body = {
      merchantAccount: requireCredential(ctx, "merchantAccount", NAME),
      amount: { value: req.amountMinor, currency: req.currency },
      reference: req.transactionId,
      merchantOrderReference: req.reference,
      paymentMethod: req.paymentToken ? JSON.parse(req.paymentToken) : { type: "scheme" },
      returnUrl: req.returnUrl ?? "https://usopgrid.com/checkout/return",
      shopperEmail: req.customer?.email,
      shopperName: req.customer?.name ? { firstName: req.customer.name.split(" ")[0], lastName: req.customer.name.split(" ").slice(1).join(" ") || "-" } : undefined,
      countryCode: req.country,
      shopperReference: req.customer?.email,
      metadata: { usopgrid_transaction_id: req.transactionId },
    };
    if (!req.paymentToken) {
      // Without encrypted method data, create a hosted payment session instead.
      const o = await providerFetch(ctx, `${base(ctx)}/paymentLinks`, {
        method: "POST",
        headers: headers(ctx, req.idempotencyKey),
        body: JSON.stringify({
          merchantAccount: body.merchantAccount,
          amount: body.amount,
          reference: body.reference,
          returnUrl: body.returnUrl,
          shopperEmail: body.shopperEmail,
          countryCode: body.countryCode,
        }),
      });
      if (o.kind === "response" && o.status >= 200 && o.status < 300) {
        return {
          status: "requires_action",
          providerReference: str(o.json, "id"),
          providerStatus: str(o.json, "status"),
          nextAction: { type: "redirect", url: str(o.json, "url"), expiresAt: Date.parse(str(o.json, "expiresAt") ?? "") || undefined },
        };
      }
      const f = classifyHttpFailure(o, NAME);
      return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const o = await providerFetch(ctx, `${base(ctx)}/payments`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: JSON.stringify(body),
    });
    if (o.kind === "response" && o.status >= 200 && o.status < 300) return mapResult(o.json);
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    // Adyen has no generic "get payment" endpoint; payment-link status is
    // queryable, otherwise the authoritative outcome arrives by webhook.
    if (q.providerReference?.startsWith("PL")) {
      const o = await providerFetch(ctx, `${base(ctx)}/paymentLinks/${encodeURIComponent(q.providerReference)}`, {
        method: "GET",
        headers: headers(ctx),
      });
      if (o.kind === "response" && o.status === 200) {
        const s = str(o.json, "status");
        if (s === "completed") return { status: "successful", providerReference: q.providerReference, providerStatus: s };
        if (s === "expired") return { status: "failed", providerReference: q.providerReference, providerStatus: s, failure: failure("customer_cancellation", "link_expired", "Payment link expired.") };
        return { status: "pending", providerReference: q.providerReference, providerStatus: s };
      }
    }
    return { status: "unknown", providerReference: q.providerReference };
  },

  async refund(ctx, req) {
    if (!req.providerReference) return { status: "failed", failure: failure("invalid_payment_information", "missing_psp_reference", "No pspReference to refund.") };
    const o = await providerFetch(ctx, `${base(ctx)}/payments/${encodeURIComponent(req.providerReference)}/refunds`, {
      method: "POST",
      headers: headers(ctx, req.idempotencyKey),
      body: JSON.stringify({
        merchantAccount: requireCredential(ctx, "merchantAccount", NAME),
        amount: { value: req.amountMinor, currency: req.currency },
        reference: req.refundId,
      }),
    });
    // Adyen refunds are asynchronous: 201 "received", final result via REFUND webhook.
    if (o.kind === "response" && o.status >= 200 && o.status < 300) {
      return { status: "pending", providerRefundReference: str(o.json, "pspReference") };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const key = ctx.credentials.hmacKey;
    if (!key) return false;
    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      return false;
    }
    const items = (get(payload, "notificationItems") as { NotificationRequestItem: Record<string, unknown> }[] | undefined) ?? [];
    if (items.length === 0) return false;
    const keyBytes = hexToBytes(key);
    for (const { NotificationRequestItem: it } of items) {
      const signed = [
        str(it, "pspReference") ?? "",
        str(it, "originalReference") ?? "",
        str(it, "merchantAccountCode") ?? "",
        str(it, "merchantReference") ?? "",
        str(it, "amount.value") ?? "",
        str(it, "amount.currency") ?? "",
        str(it, "eventCode") ?? "",
        str(it, "success") ?? "",
      ].join(":");
      const expected = await hmacBase64WithKeyBytes("SHA-256", keyBytes, signed);
      const got = str(it, "additionalData.hmacSignature") ?? "";
      if (!timingSafeEqual(expected, got)) return false;
    }
    return true;
  },

  parseWebhook(_ctx, input) {
    const payload = JSON.parse(input.rawBody);
    const items = (get(payload, "notificationItems") as { NotificationRequestItem: Record<string, unknown> }[]) ?? [];
    return items.map(({ NotificationRequestItem: it }): ProviderEvent => {
      const code = str(it, "eventCode") ?? "";
      const ok = str(it, "success") === "true";
      const evBase = {
        eventId: `${str(it, "pspReference")}:${code}:${str(it, "success")}`,
        rawType: code,
        reference: str(it, "merchantReference"),
        amountMinor: Number(str(it, "amount.value")) || undefined,
        currency: str(it, "amount.currency"),
        occurredAt: Date.parse(str(it, "eventDate") ?? "") || undefined,
      };
      switch (code) {
        case "AUTHORISATION":
          return {
            ...evBase,
            type: "payment",
            providerReference: str(it, "pspReference"),
            status: ok ? "successful" : "declined",
            failure: ok ? undefined : failure("issuer_decline", "refused", str(it, "reason") ?? "Refused"),
          };
        case "CANCELLATION":
          return { ...evBase, type: "payment", providerReference: str(it, "pspReference"), status: ok ? "failed" : undefined };
        case "REFUND":
          return { ...evBase, type: "refund", providerReference: str(it, "originalReference"), status: ok ? "refunded" : undefined };
        case "CHARGEBACK":
        case "NOTIFICATION_OF_CHARGEBACK":
          return { ...evBase, type: "dispute", providerReference: str(it, "originalReference") ?? str(it, "pspReference"), status: "dispute_opened" };
        case "CHARGEBACK_REVERSED":
          return { ...evBase, type: "dispute", providerReference: str(it, "originalReference"), status: "dispute_won" };
        default:
          return { ...evBase, type: "other" };
      }
    });
  },
};
