// dLocal adapter — Payins API v2.1 (emerging markets: LatAm, Africa, Asia, Middle East).
// Docs: https://docs.dlocal.com/docs/generate-signature , https://docs.dlocal.com/reference/
// Auth: X-Login, X-Trans-Key, X-Date, X-Version: 2.1 and
//   Authorization: "V2-HMAC-SHA256, Signature: hex(HMAC-SHA256(secret, X-Login + X-Date + body))".
// AMOUNTS ARE MAJOR UNITS. Notifications are signed with the same scheme.

import type { ProviderAdapter, ChargeResult, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get, callbackUrl } from "./http";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";
import { minorToDecimalString, decimalToMinor } from "../../lib/money";

const NAME = "dLocal";

const base = (ctx: AdapterContext) => (ctx.environment === "sandbox" ? "https://sandbox.dlocal.com" : "https://api.dlocal.com");

const METHOD_IDS: Record<string, string | undefined> = {
  card: "CARD",
  pix: "PIX",
  cash_voucher: undefined, // let dLocal show local cash options
  bank_transfer: undefined,
  upi: "UPI",
  wallet: undefined,
  mobile_money: undefined,
  qr: undefined,
};

async function signedHeaders(ctx: AdapterContext, body: string): Promise<Record<string, string>> {
  const login = requireCredential(ctx, "login", NAME);
  const xDate = new Date(ctx.now()).toISOString();
  const sig = await hmacSha256Hex(requireCredential(ctx, "secretKey", NAME), `${login}${xDate}${body}`);
  return {
    "X-Date": xDate,
    "X-Login": login,
    "X-Trans-Key": requireCredential(ctx, "transKey", NAME),
    "X-Version": "2.1",
    "Content-Type": "application/json",
    Authorization: `V2-HMAC-SHA256, Signature: ${sig}`,
  };
}

function mapPayment(j: unknown): ChargeResult {
  const s = str(j, "status");
  const id = str(j, "id");
  const detail = str(j, "status_detail") ?? "Rejected";
  const code = str(j, "status_code");
  const cur = str(j, "currency");
  let reportedAmountMinor: number | undefined;
  try {
    reportedAmountMinor = cur && get(j, "amount") !== undefined ? decimalToMinor(get(j, "amount") as number, cur) : undefined;
  } catch {
    reportedAmountMinor = undefined;
  }
  switch (s) {
    case "PAID":
      return { status: "successful", providerReference: id, providerStatus: s, reportedAmountMinor, reportedCurrency: cur };
    case "AUTHORIZED":
    case "VERIFIED":
      return { status: "pending", providerReference: id, providerStatus: s };
    case "PENDING": {
      const url = str(j, "redirect_url");
      return url
        ? { status: "requires_action", providerReference: id, providerStatus: s, nextAction: { type: "redirect", url } }
        : { status: "pending", providerReference: id, providerStatus: s };
    }
    case "REJECTED":
      return {
        status: "declined",
        providerReference: id,
        providerStatus: s,
        failure: code === "308" || /insufficient/i.test(detail)
          ? failure("insufficient_funds", "insufficient_funds", detail, { providerCode: code })
          : code === "310" || /fraud|risk/i.test(detail)
            ? failure("fraud_rejection", "rejected_risk", detail, { providerCode: code })
            : failure("issuer_decline", "rejected", detail, { providerCode: code }),
      };
    case "CANCELLED":
    case "EXPIRED":
      return { status: "failed", providerReference: id, providerStatus: s, failure: failure("customer_cancellation", s.toLowerCase(), detail) };
    default:
      return { status: "unknown", providerReference: id, providerStatus: s };
  }
}

export const dlocalAdapter: ProviderAdapter = {
  descriptor: {
    id: "dlocal",
    displayName: "dLocal",
    category: "emerging_markets",
    description: "One integration for 40+ emerging markets — local cards, cash, bank transfer, wallets and real-time rails.",
    website: "https://www.dlocal.com",
    docsUrl: "https://docs.dlocal.com/reference/",
    countries: [
      "AR", "BO", "BR", "CL", "CO", "CR", "DO", "EC", "SV", "GT", "HN", "MX", "NI", "PA", "PY", "PE", "UY",
      "EG", "GH", "KE", "MA", "NG", "ZA", "TZ", "UG", "CM", "CI", "SN", "RW", "BJ",
      "IN", "ID", "MY", "PH", "TH", "VN", "BD", "PK", "CN", "JP", "KR",
      "SA", "AE", "KW", "QA", "OM", "BH", "JO", "TR",
    ],
    currencies: [
      "ARS", "BOB", "BRL", "CLP", "COP", "CRC", "DOP", "USD", "GTQ", "HNL", "MXN", "NIO", "PAB", "PYG", "PEN", "UYU",
      "EGP", "GHS", "KES", "MAD", "NGN", "ZAR", "TZS", "UGX", "XAF", "XOF", "RWF",
      "INR", "IDR", "MYR", "PHP", "THB", "VND", "BDT", "PKR", "CNY", "JPY", "KRW",
      "SAR", "AED", "KWD", "QAR", "OMR", "BHD", "JOD", "TRY",
    ],
    methods: ["card", "bank_transfer", "cash_voucher", "wallet", "pix", "upi", "mobile_money", "qr"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true },
    pricing: { pctBps: 350, fixedMinor: 0, fixedCurrency: "USD", notes: "Negotiated per market; enter the agreed rate on the connection." },
    credentials: [
      { key: "login", label: "X-Login", secret: false, required: true },
      { key: "transKey", label: "X-Trans-Key", secret: true, required: true },
      { key: "secretKey", label: "Secret key", secret: true, required: true },
    ],
    envCredentials: { login: "DLOCAL_LOGIN", transKey: "DLOCAL_TRANS_KEY", secretKey: "DLOCAL_SECRET_KEY" },
  },

  async charge(ctx, req) {
    if (!req.country) {
      return { status: "failed", failure: failure("invalid_payment_information", "country_required", "dLocal requires the payer country.", { safeToFailover: true }) };
    }
    const body = JSON.stringify({
      amount: Number(minorToDecimalString(req.amountMinor, req.currency)),
      currency: req.currency,
      country: req.country,
      payment_method_id: METHOD_IDS[req.paymentMethod],
      payment_method_flow: req.paymentToken ? "DIRECT" : "REDIRECT",
      card: req.paymentToken ? { token: req.paymentToken } : undefined,
      payer: { name: req.customer?.name ?? "Customer", email: req.customer?.email, document: req.customer?.document, phone: req.customer?.phone },
      order_id: req.transactionId,
      description: req.description ?? req.reference,
      notification_url: callbackUrl(ctx, "dlocal"),
      callback_url: req.returnUrl,
    });
    const o = await providerFetch(ctx, `${base(ctx)}/payments`, { method: "POST", headers: await signedHeaders(ctx, body), body });
    if (o.kind === "response" && (o.status === 200 || o.status === 201)) return mapPayment(o.json);
    if (o.kind === "response" && o.status === 400) {
      const code = str(o.json, "code");
      return { status: "declined", failure: failure("invalid_payment_information", `dlocal_${code ?? "400"}`, str(o.json, "message") ?? "Rejected by dLocal.", { safeToFailover: true, providerCode: code }) };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    if (!q.providerReference) return { status: "unknown" };
    const o = await providerFetch(ctx, `${base(ctx)}/payments/${encodeURIComponent(q.providerReference)}/status`, {
      method: "GET",
      headers: await signedHeaders(ctx, ""),
    });
    if (o.kind === "response" && o.status === 200) return mapPayment({ ...(o.json as object), id: q.providerReference });
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    const body = JSON.stringify({
      payment_id: req.providerReference,
      amount: Number(minorToDecimalString(req.amountMinor, req.currency)),
      currency: req.currency,
      id: req.refundId,
      notification_url: callbackUrl(ctx, "dlocal"),
    });
    const o = await providerFetch(ctx, `${base(ctx)}/refunds`, { method: "POST", headers: await signedHeaders(ctx, body), body });
    if (o.kind === "response" && (o.status === 200 || o.status === 201)) {
      const s = str(o.json, "status");
      return { status: s === "SUCCESS" ? "successful" : s === "REJECTED" ? "failed" : "pending", providerRefundReference: str(o.json, "id") };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const auth = input.headers.get("authorization") ?? "";
    const xDate = input.headers.get("x-date") ?? "";
    const login = ctx.credentials.login;
    const secret = ctx.credentials.secretKey;
    const got = /Signature:\s*([0-9a-f]+)/i.exec(auth)?.[1];
    if (!got || !xDate || !login || !secret) return false;
    return timingSafeEqual(await hmacSha256Hex(secret, `${login}${xDate}${input.rawBody}`), got.toLowerCase());
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody);
    const isRefund = typeof get(evt, "payment_id") === "string";
    if (isRefund) {
      return [{ eventId: `refund:${str(evt, "id")}:${str(evt, "status")}`, type: "refund", rawType: `refund_${str(evt, "status")}`, status: str(evt, "status") === "SUCCESS" ? "refunded" : undefined, providerReference: str(evt, "payment_id") }];
    }
    const mapped = mapPayment(evt);
    return [
      {
        eventId: `${str(evt, "id")}:${str(evt, "status")}`,
        type: "payment",
        rawType: `payment_${str(evt, "status")}`,
        status: mapped.status === "requires_action" ? "pending" : mapped.status,
        providerReference: str(evt, "id"),
        reference: str(evt, "order_id"),
        amountMinor: mapped.reportedAmountMinor,
        currency: str(evt, "currency"),
        failure: mapped.failure,
      },
    ];
  },
};
