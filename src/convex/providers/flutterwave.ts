// Flutterwave adapter — v3 Standard (hosted) payments.
// Docs: https://developer.flutterwave.com/docs/collecting-payments/standard ,
//       https://developer.flutterwave.com/docs/integration-guides/webhooks
// Auth: Bearer secret key (test vs live keys). AMOUNTS ARE MAJOR UNITS — we
// convert exactly via decimal strings, never floats.
// Webhooks: `verif-hash` header must equal the secret hash set in the
// dashboard. Because that is a shared token rather than a body signature,
// USOPGRID re-verifies every success by transaction lookup before booking.

import type { ProviderAdapter, ChargeResult, PayoutResult } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get, callbackUrl } from "./http";
import { timingSafeEqual } from "../lib/crypto";
import { minorToDecimalString, decimalToMinor } from "../../lib/money";

const API = "https://api.flutterwave.com/v3";
const NAME = "Flutterwave";

const OPTIONS: Record<string, string> = {
  card: "card",
  bank_transfer: "banktransfer",
  mobile_money: "mobilemoneyghana,mobilemoneyuganda,mobilemoneyrwanda,mobilemoneyzambia,mobilemoneyfranco,mpesa",
  ussd: "ussd",
  account_to_account: "account",
  qr: "nqr",
  open_banking: "account",
};

function mapTxn(j: unknown): ChargeResult {
  const d = get(j, "data");
  const s = str(d, "status");
  const ref = str(d, "id");
  const msg = str(d, "processor_response") ?? "Declined";
  if (s === "successful") return { status: "successful", providerReference: ref, providerStatus: s };
  if (s === "failed") {
    return {
      status: "declined",
      providerReference: ref,
      providerStatus: s,
      failure: /insufficient/i.test(msg) ? failure("insufficient_funds", "insufficient_funds", msg) : failure("issuer_decline", "declined", msg),
    };
  }
  if (s === "pending") return { status: "pending", providerReference: ref, providerStatus: s };
  return { status: "unknown", providerReference: ref, providerStatus: s };
}

// Transfers (payouts): POST /v3/transfers, amounts in major units, status
// NEW/PENDING → SUCCESSFUL | FAILED, webhook "transfer.completed".
// Docs: https://developer.flutterwave.com/docs/making-payments/transfers/overview
function mapTransfer(j: unknown): PayoutResult {
  const d = get(j, "data");
  const s = (str(d, "status") ?? "").toUpperCase();
  const id = str(d, "id");
  if (s === "SUCCESSFUL") return { status: "successful", providerReference: id, providerStatus: s };
  if (s === "FAILED") return { status: "failed", providerReference: id, providerStatus: s, failure: failure("temporary_provider_failure", "transfer_failed", str(d, "complete_message") ?? "Transfer failed.") };
  if (s === "NEW" || s === "PENDING") return { status: "pending", providerReference: id, providerStatus: s };
  return { status: "unknown", providerReference: id, providerStatus: s };
}

export const flutterwaveAdapter: ProviderAdapter = {
  descriptor: {
    id: "flutterwave",
    displayName: "Flutterwave",
    category: "regional_psp",
    description: "Pan-African collections across 30+ countries: cards, mobile money, bank transfer, USSD.",
    website: "https://flutterwave.com",
    docsUrl: "https://developer.flutterwave.com/docs",
    countries: ["NG", "GH", "KE", "UG", "TZ", "RW", "ZA", "ZM", "CM", "CI", "SN", "BF", "ML", "BJ", "TG", "GA", "CD", "MW", "SL", "EG", "ET", "MA", "MZ", "GB", "US"],
    currencies: ["NGN", "GHS", "KES", "UGX", "TZS", "RWF", "ZAR", "ZMW", "XAF", "XOF", "MWK", "SLE", "EGP", "ETB", "MAD", "MZN", "CDF", "USD", "EUR", "GBP"],
    methods: ["card", "bank_transfer", "mobile_money", "ussd", "account_to_account", "qr", "open_banking"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true, payouts: true, recurring: true },
    payoutCurrencies: ["NGN", "GHS", "KES", "UGX", "TZS", "RWF", "ZAR", "ZMW", "XAF", "XOF", "EGP", "ETB", "USD", "EUR", "GBP"],
    pricing: { pctBps: 140, fixedMinor: 0, fixedCurrency: "NGN", capMinor: 200_000, notes: "Nigeria local cards 1.4%; international 3.8%. Varies by country." },
    credentials: [
      { key: "secretKey", label: "Secret key (FLWSECK…)", secret: true, required: true },
      { key: "webhookHash", label: "Webhook secret hash", secret: true, required: true },
    ],
    envCredentials: { secretKey: "FLW_SECRET_KEY", webhookHash: "FLW_WEBHOOK_HASH" },
  },

  async charge(ctx, req) {
    if (!req.customer?.email) {
      return { status: "failed", failure: failure("invalid_payment_information", "email_required", "Flutterwave requires a customer email.", { safeToFailover: true }) };
    }
    // Saved card token (subscription renewal): merchant-initiated tokenized charge.
    if (req.recurring) {
      if (!req.paymentToken) return { status: "failed", failure: failure("invalid_payment_information", "token_required", "Saved card token missing.", { safeToFailover: false }) };
      const t = await providerFetch(ctx, `${API}/tokenized-charges`, {
        method: "POST",
        headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          token: req.paymentToken,
          currency: req.currency,
          country: req.country,
          amount: Number(minorToDecimalString(req.amountMinor, req.currency)),
          email: req.customer.email,
          tx_ref: req.transactionId,
          narration: req.description ?? req.reference,
        }),
      });
      if (t.kind === "response" && t.status === 200 && str(t.json, "status") === "success") return mapTxn(t.json);
      if (t.kind === "response" && t.status === 400) {
        const msg = str(t.json, "message") ?? str(t.json, "data.processor_response") ?? "Declined";
        return { status: "declined", failure: failure(/insufficient/i.test(msg) ? "insufficient_funds" : "issuer_decline", "declined", msg) };
      }
      const tf = classifyHttpFailure(t, NAME);
      return tf ? { status: "failed", failure: tf } : { status: "unknown", failure: unknownOutcome(t, NAME) };
    }
    const o = await providerFetch(ctx, `${API}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: req.transactionId,
        amount: minorToDecimalString(req.amountMinor, req.currency),
        currency: req.currency,
        redirect_url: req.returnUrl ?? callbackUrl(ctx, "flutterwave"),
        payment_options: OPTIONS[req.paymentMethod],
        customer: { email: req.customer.email, name: req.customer.name, phonenumber: req.customer.phone },
        meta: { usopgrid_transaction_id: req.transactionId, usopgrid_reference: req.reference },
        customizations: { title: req.description ?? "Payment" },
      }),
    });
    if (o.kind === "response" && o.status === 200 && str(o.json, "status") === "success") {
      return { status: "requires_action", providerReference: req.transactionId, providerStatus: "link_created", nextAction: { type: "redirect", url: str(o.json, "data.link") } };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    const o = await providerFetch(ctx, `${API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(q.transactionId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}` },
    });
    if (o.kind === "response" && o.status === 200) {
      const r = mapTxn(o.json);
      const cur = str(o.json, "data.currency");
      const amt = get(o.json, "data.amount");
      if (cur && amt !== undefined) {
        // Surface the provider-reported amount so the engine can detect mismatches.
        try {
          r.reportedAmountMinor = decimalToMinor(amt as number, cur);
          r.reportedCurrency = cur;
        } catch {
          r.status = "unknown";
        }
      }
      return r;
    }
    if (o.kind === "response" && (o.status === 404 || o.status === 400)) {
      return { status: "pending", providerReference: q.providerReference, providerStatus: "not_paid_yet" };
    }
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    // Refunds use Flutterwave's numeric transaction id (recorded once the payment completes).
    const o = await providerFetch(ctx, `${API}/transactions/${encodeURIComponent(req.providerReference ?? "")}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: minorToDecimalString(req.amountMinor, req.currency) }),
    });
    if (o.kind === "response" && o.status === 200 && str(o.json, "status") === "success") {
      const s = str(o.json, "data.status");
      return { status: s === "completed" ? "successful" : "pending", providerRefundReference: str(o.json, "data.id") };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async payout(ctx, req) {
    if (!req.beneficiary.bankCode) {
      return { status: "failed", failure: failure("invalid_payment_information", "bank_code_required", "A bank (or mobile network) code is required for Flutterwave transfers.", { safeToFailover: true }) };
    }
    const o = await providerFetch(ctx, `${API}/transfers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        account_bank: req.beneficiary.bankCode,
        account_number: req.beneficiary.accountNumber,
        amount: Number(minorToDecimalString(req.amountMinor, req.currency)),
        currency: req.currency,
        narration: req.narration?.slice(0, 100) ?? `Payout ${req.payoutId}`,
        reference: req.reference,
        beneficiary_name: req.beneficiary.name,
        debit_currency: req.currency,
        callback_url: callbackUrl(ctx, "flutterwave"),
      }),
    });
    if (o.kind === "response" && o.status === 200 && str(o.json, "status") === "success") return mapTransfer(o.json);
    if (o.kind === "response" && o.status === 400 && /duplicate|already exists/i.test(str(o.json, "message") ?? "")) {
      return { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const f = classifyHttpFailure(o, NAME);
    if (f) return { status: "failed", failure: { ...f, message: `${f.message} ${o.kind === "response" ? (str(o.json, "message") ?? "") : ""}`.trim() } };
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getPayoutStatus(ctx, q) {
    if (!q.providerReference) {
      return { status: "unknown", failure: failure("temporary_provider_failure", "no_transfer_id", "Flutterwave transfer id not known yet; waiting for the webhook.", { retryable: true }) };
    }
    const o = await providerFetch(ctx, `${API}/transfers/${encodeURIComponent(q.providerReference)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}` },
    });
    if (o.kind === "response" && o.status === 200) return mapTransfer(o.json);
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const expected = ctx.credentials.webhookHash;
    const got = input.headers.get("verif-hash");
    return !!expected && !!got && timingSafeEqual(expected, got);
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody);
    const type = str(evt, "event") ?? str(evt, "event.type") ?? "";
    const d = get(evt, "data") ?? evt;
    const cur = str(d, "currency");
    const amt = get(d, "amount");
    let amountMinor: number | undefined;
    try {
      amountMinor = cur && amt !== undefined ? decimalToMinor(amt as number, cur) : undefined;
    } catch {
      amountMinor = undefined;
    }
    const s = str(d, "status");
    const ev = {
      eventId: `${type}:${str(d, "id")}:${s}`,
      rawType: type,
      providerReference: str(d, "id"),
      reference: str(d, "tx_ref") ?? str(d, "txRef"),
      amountMinor,
      currency: cur,
    };
    if (type === "charge.completed") {
      return [
        {
          ...ev,
          type: "payment",
          status: s === "successful" ? "successful" : s === "failed" ? "declined" : "pending",
          failure: s === "failed" ? failure("issuer_decline", "declined", str(d, "processor_response") ?? "Declined") : undefined,
          reusableToken:
            s === "successful" && str(d, "card.token")
              ? {
                  token: str(d, "card.token")!,
                  brand: str(d, "card.type"),
                  last4: str(d, "card.last_4digits"),
                  expMonth: Number((str(d, "card.expiry") ?? "").split("/")[0]) || undefined,
                  expYear: Number((str(d, "card.expiry") ?? "").split("/")[1]) ? 2000 + Number((str(d, "card.expiry") ?? "").split("/")[1]) : undefined,
                }
              : undefined,
        },
      ];
    }
    if (type === "transfer.completed" || str(evt, "event.type") === "Transfer") {
      const ts = (s ?? "").toUpperCase();
      return [{ ...ev, reference: str(d, "reference"), type: "payout", status: ts === "SUCCESSFUL" ? "payout_successful" : ts === "FAILED" ? "payout_failed" : undefined }];
    }
    if (type.startsWith("refund")) return [{ ...ev, type: "refund", status: "refunded" }];
    return [{ ...ev, type: "other" }];
  },
};
