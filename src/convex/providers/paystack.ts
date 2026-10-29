// Paystack adapter.
// Docs: https://paystack.com/docs/api/transaction/ , https://paystack.com/docs/payments/webhooks/
// Auth: Bearer secret key (test vs live keys select the environment).
// Amounts: minor units (kobo, pesewas, cents). Our transactionId is the
// Paystack reference, so Paystack itself rejects a duplicate initialization.
// Webhooks: x-paystack-signature = HMAC-SHA512(secret key, raw body), hex.

import type { ProviderAdapter, ChargeResult, PayoutResult, PayoutBeneficiary } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get, callbackUrl } from "./http";
import { hmacHex, timingSafeEqual } from "../lib/crypto";

const API = "https://api.paystack.co";
const NAME = "Paystack";

const CHANNELS: Record<string, string[]> = {
  card: ["card"],
  bank_transfer: ["bank_transfer", "bank"],
  ussd: ["ussd"],
  mobile_money: ["mobile_money"],
  qr: ["qr"],
  open_banking: ["bank"],
};

function mapTxn(j: unknown): ChargeResult {
  const d = get(j, "data");
  const s = str(d, "status");
  const ref = str(d, "reference");
  const msg = str(d, "gateway_response") ?? "Declined";
  const reported = { reportedAmountMinor: Number(get(d, "amount")) || undefined, reportedCurrency: str(d, "currency") };
  switch (s) {
    case "success":
      return { status: "successful", providerReference: ref, providerStatus: s, providerFeeMinor: Number(get(d, "fees")) || undefined, ...reported };
    case "failed":
      return {
        status: "declined",
        providerReference: ref,
        providerStatus: s,
        failure: /insufficient/i.test(msg)
          ? failure("insufficient_funds", "insufficient_funds", msg)
          : failure("issuer_decline", "declined", msg),
      };
    case "abandoned":
      return { status: "pending", providerReference: ref, providerStatus: s };
    case "ongoing":
    case "pending":
    case "processing":
    case "queued":
      return { status: "pending", providerReference: ref, providerStatus: s };
    case "reversed":
      return { status: "failed", providerReference: ref, providerStatus: s, failure: failure("customer_cancellation", "reversed", "Transaction reversed.") };
    default:
      return { status: "unknown", providerReference: ref, providerStatus: s };
  }
}

// Transfers (payouts): POST /transferrecipient then POST /transfer from the
// Paystack balance. Docs: https://paystack.com/docs/transfers/single-transfers/
// The reference is ours and stable, so a retried transfer is de-duplicated by
// Paystack. Transfers must not require OTP (disable "OTP for transfers" in the
// Paystack dashboard), otherwise they are reported as a configuration error.
function recipientType(currency: string, b: PayoutBeneficiary): string | null {
  if (b.type === "mobile_money") return currency === "GHS" || currency === "KES" ? "mobile_money" : null;
  return ({ NGN: "nuban", ZAR: "basa", GHS: "ghipss", KES: "kepss" } as Record<string, string>)[currency] ?? null;
}

function mapTransfer(j: unknown): PayoutResult {
  const d = get(j, "data");
  const s = str(d, "status");
  const ref = str(d, "transfer_code") ?? str(d, "reference");
  switch (s) {
    case "success":
      return { status: "successful", providerReference: ref, providerStatus: s };
    case "failed":
    case "reversed":
      return { status: "failed", providerReference: ref, providerStatus: s, failure: failure("temporary_provider_failure", `transfer_${s}`, str(d, "reason") ?? `Transfer ${s}.`) };
    case "otp":
      return { status: "failed", providerReference: ref, providerStatus: s, failure: failure("configuration_error", "transfer_otp_required", "Paystack requires OTP for transfers. Disable OTP for API transfers in the Paystack dashboard.") };
    case "abandoned":
      return { status: "failed", providerReference: ref, providerStatus: s, failure: failure("temporary_provider_failure", "transfer_abandoned", "Transfer was abandoned.") };
    default:
      return { status: "pending", providerReference: ref, providerStatus: s };
  }
}

export const paystackAdapter: ProviderAdapter = {
  descriptor: {
    id: "paystack",
    displayName: "Paystack",
    category: "regional_psp",
    description: "Leading African PSP — cards, bank transfer, USSD, mobile money and QR across West, East and Southern Africa.",
    website: "https://paystack.com",
    docsUrl: "https://paystack.com/docs/api/",
    countries: ["NG", "GH", "ZA", "KE", "CI", "EG", "RW"],
    currencies: ["NGN", "GHS", "ZAR", "KES", "USD", "XOF", "EGP", "RWF"],
    methods: ["card", "bank_transfer", "ussd", "mobile_money", "qr", "open_banking"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true, payouts: true, recurring: true },
    payoutCurrencies: ["NGN", "GHS", "ZAR", "KES"],
    limits: { NGN: { minMinor: 5_000 }, GHS: { minMinor: 10 }, KES: { minMinor: 300 } },
    pricing: { pctBps: 150, fixedMinor: 10_000, fixedCurrency: "NGN", capMinor: 200_000, notes: "Nigeria local: 1.5% + ₦100 (waived < ₦2,500), capped at ₦2,000." },
    credentials: [{ key: "secretKey", label: "Secret key (sk_…)", secret: true, required: true }],
    envCredentials: { secretKey: "PAYSTACK_SECRET_KEY" },
  },

  async charge(ctx, req) {
    const auth = { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`, "Content-Type": "application/json" };
    if (!req.customer?.email) {
      return { status: "failed", failure: failure("invalid_payment_information", "email_required", "Paystack requires a customer email.", { safeToFailover: true }) };
    }
    const common = {
      email: req.customer.email,
      amount: req.amountMinor,
      currency: req.currency,
      reference: req.transactionId,
      metadata: { usopgrid_transaction_id: req.transactionId, usopgrid_reference: req.reference },
    };
    // Saved authorization (recurring card) → direct charge.
    if (req.paymentToken?.startsWith("AUTH_")) {
      const o = await providerFetch(ctx, `${API}/transaction/charge_authorization`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ ...common, authorization_code: req.paymentToken }),
      });
      if (o.kind === "response" && o.status === 200 && get(o.json, "status") === true) return mapTxn(o.json);
      if (o.kind === "response" && o.status === 400) {
        const msg = str(o.json, "message") ?? str(o.json, "data.gateway_response") ?? "Declined";
        return { status: "declined", failure: failure(/insufficient/i.test(msg) ? "insufficient_funds" : "issuer_decline", /insufficient/i.test(msg) ? "insufficient_funds" : "declined", msg) };
      }
      const f = classifyHttpFailure(o, NAME);
      return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const o = await providerFetch(ctx, `${API}/transaction/initialize`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        ...common,
        callback_url: req.returnUrl ?? callbackUrl(ctx, "paystack"),
        channels: CHANNELS[req.paymentMethod],
      }),
    });
    if (o.kind === "response" && o.status === 200 && get(o.json, "status") === true) {
      return {
        status: "requires_action",
        providerReference: str(o.json, "data.reference"),
        providerStatus: "initialized",
        nextAction: { type: "redirect", url: str(o.json, "data.authorization_url") },
      };
    }
    if (o.kind === "response" && o.status === 400 && /duplicate/i.test(str(o.json, "message") ?? "")) {
      // We already initialized this exact transaction — outcome is whatever Paystack holds.
      return { status: "unknown", providerReference: req.transactionId, failure: unknownOutcome(o, NAME) };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    const o = await providerFetch(ctx, `${API}/transaction/verify/${encodeURIComponent(q.providerReference ?? q.transactionId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}` },
    });
    if (o.kind === "response" && o.status === 200) return mapTxn(o.json);
    if (o.kind === "response" && o.status === 404) {
      return { status: "failed", failure: failure("network_error", "not_found_at_provider", "Paystack has no record of this transaction.", { safeToFailover: true }) };
    }
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    const o = await providerFetch(ctx, `${API}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: req.providerReference ?? req.transactionId, amount: req.amountMinor, merchant_note: req.reason }),
    });
    if (o.kind === "response" && o.status === 200 && get(o.json, "status") === true) {
      const s = str(o.json, "data.status");
      return { status: s === "processed" ? "successful" : "pending", providerRefundReference: str(o.json, "data.id") };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async payout(ctx, req) {
    const auth = { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}`, "Content-Type": "application/json" };
    const type = recipientType(req.currency, req.beneficiary);
    if (!type) return { status: "failed", failure: failure("unsupported", "payout_unsupported", `Paystack cannot pay out ${req.currency} to this account type.`, { safeToFailover: true }) };
    if (!req.beneficiary.bankCode) return { status: "failed", failure: failure("invalid_payment_information", "bank_code_required", "A bank (or mobile network) code is required for Paystack transfers.", { safeToFailover: true }) };
    const r = await providerFetch(ctx, `${API}/transferrecipient`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type, name: req.beneficiary.name, account_number: req.beneficiary.accountNumber, bank_code: req.beneficiary.bankCode, currency: req.currency }),
    });
    if (!(r.kind === "response" && (r.status === 200 || r.status === 201) && get(r.json, "status") === true)) {
      // Nothing has been sent yet: any failure here is safe to retry elsewhere.
      const msg = r.kind === "response" ? (str(r.json, "message") ?? `HTTP ${r.status}`) : "Paystack unreachable";
      return { status: "failed", failure: failure(r.kind === "response" && r.status === 400 ? "invalid_payment_information" : "temporary_provider_failure", "recipient_rejected", `Paystack rejected the recipient: ${msg}`, { safeToFailover: true, retryable: r.kind !== "response" }) };
    }
    const recipient = str(r.json, "data.recipient_code");
    const o = await providerFetch(ctx, `${API}/transfer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: "balance", amount: req.amountMinor, reference: req.reference, recipient, reason: req.narration?.slice(0, 100) }),
    });
    if (o.kind === "response" && o.status === 200 && get(o.json, "status") === true) return mapTransfer(o.json);
    if (o.kind === "response" && o.status === 400 && /duplicate|already/i.test(str(o.json, "message") ?? "")) {
      return { status: "unknown", failure: unknownOutcome(o, NAME) };
    }
    const f = classifyHttpFailure(o, NAME);
    if (f) return { status: "failed", failure: { ...f, message: `${f.message} ${str(o.kind === "response" ? o.json : null, "message") ?? ""}`.trim() } };
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getPayoutStatus(ctx, q) {
    const o = await providerFetch(ctx, `${API}/transfer/verify/${encodeURIComponent(q.reference)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${requireCredential(ctx, "secretKey", NAME)}` },
    });
    if (o.kind === "response" && o.status === 200) return mapTransfer(o.json);
    if (o.kind === "response" && o.status === 404) {
      return { status: "failed", failure: failure("network_error", "not_found_at_provider", "Paystack has no transfer with this reference.", { safeToFailover: true }) };
    }
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const secret = ctx.credentials.secretKey;
    const sig = input.headers.get("x-paystack-signature");
    if (!secret || !sig) return false;
    return timingSafeEqual(await hmacHex("SHA-512", secret, input.rawBody), sig.toLowerCase());
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody);
    const type = str(evt, "event") ?? "";
    const d = get(evt, "data");
    const ref = str(d, "reference");
    const ev = {
      eventId: `${type}:${str(d, "id") ?? ref}`,
      rawType: type,
      providerReference: ref,
      reference: str(d, "metadata.usopgrid_transaction_id") ?? ref,
      amountMinor: Number(get(d, "amount")) || undefined,
      currency: str(d, "currency"),
      occurredAt: Date.parse(str(d, "paid_at") ?? str(d, "created_at") ?? "") || undefined,
    };
    if (type === "charge.success") {
      // A reusable card authorization comes back with the first successful charge.
      const auth = get(d, "authorization");
      const reusable = get(auth, "reusable") === true && str(auth, "authorization_code")?.startsWith("AUTH_");
      return [{
        ...ev,
        type: "payment",
        status: "successful",
        reusableToken: reusable
          ? { token: str(auth, "authorization_code")!, brand: str(auth, "brand") ?? str(auth, "card_type"), last4: str(auth, "last4"), expMonth: Number(str(auth, "exp_month")) || undefined, expYear: Number(str(auth, "exp_year")) || undefined }
          : undefined,
      }];
    }
    if (type === "charge.failed") return [{ ...ev, type: "payment", status: "declined", failure: failure("issuer_decline", "declined", str(d, "gateway_response") ?? "Declined") }];
    if (type === "refund.processed") return [{ ...ev, type: "refund", status: "refunded", providerReference: str(d, "transaction_reference") ?? ref }];
    if (type === "transfer.success" || type === "transfer.failed" || type === "transfer.reversed") {
      return [{ ...ev, reference: ref, providerReference: str(d, "transfer_code") ?? ref, type: "payout", status: type === "transfer.success" ? "payout_successful" : type === "transfer.failed" ? "payout_failed" : "payout_reversed" }];
    }
    if (type.startsWith("charge.dispute.")) {
      return [{ ...ev, type: "dispute", status: type.endsWith("create") ? "dispute_opened" : type.endsWith("resolve") ? (str(d, "resolution") === "merchant-accepted" ? "dispute_lost" : "dispute_won") : undefined }];
    }
    return [{ ...ev, type: "other" }];
  },
};
