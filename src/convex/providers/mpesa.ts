// Safaricom M-Pesa adapter — Daraja STK Push (Lipa na M-Pesa Online).
// Docs: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate
// Auth: OAuth client-credentials (consumer key/secret) → bearer token.
// Password = base64(Shortcode + Passkey + Timestamp), Timestamp YYYYMMDDHHmmss (EAT).
// Amounts: whole KES only. Callbacks are unsigned, so the callback URL carries
// an HMAC token bound to the connection, and every success is re-confirmed
// with STK Query before it is booked.

import type { ProviderAdapter, ChargeResult, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, unknownOutcome, requireCredential, str, get, callbackUrl, classifyHttpFailure } from "./http";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";

const NAME = "M-Pesa";

const base = (ctx: AdapterContext) =>
  ctx.environment === "sandbox" ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";

function eatTimestamp(nowMs: number): string {
  const d = new Date(nowMs + 3 * 3_600_000); // EAT = UTC+3, no DST
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Normalize a Kenyan MSISDN to 2547XXXXXXXX / 2541XXXXXXXX. */
export function normalizeKenyanMsisdn(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const m = /^(?:254|0)?([17]\d{8})$/.exec(digits);
  return m ? `254${m[1]}` : null;
}

async function token(ctx: AdapterContext): Promise<string | null> {
  const key = requireCredential(ctx, "consumerKey", NAME);
  const secret = requireCredential(ctx, "consumerSecret", NAME);
  const o = await providerFetch(ctx, `${base(ctx)}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${btoa(`${key}:${secret}`)}` },
    timeoutMs: 10_000,
  });
  if (o.kind === "response" && o.status === 200) return str(o.json, "access_token") ?? null;
  return null;
}

async function callbackToken(ctx: AdapterContext): Promise<string> {
  return (await hmacSha256Hex(requireCredential(ctx, "callbackSecret", NAME), `mpesa:${ctx.connectionId ?? "platform"}`)).slice(0, 32);
}

function mapResultCode(code: string | undefined, desc: string | undefined, ref?: string): ChargeResult {
  switch (code) {
    case "0":
      return { status: "successful", providerReference: ref, providerStatus: "0" };
    case "1":
      return { status: "declined", providerReference: ref, providerStatus: code, failure: failure("insufficient_funds", "insufficient_funds", desc ?? "Insufficient M-Pesa balance.") };
    case "1032":
      return { status: "failed", providerReference: ref, providerStatus: code, failure: failure("customer_cancellation", "cancelled_by_user", desc ?? "Request cancelled by user.", { retryable: true }) };
    case "1037":
      return { status: "failed", providerReference: ref, providerStatus: code, failure: failure("timeout", "user_unreachable", desc ?? "Customer could not be reached.", { retryable: true }) };
    case "2001":
      return { status: "declined", providerReference: ref, providerStatus: code, failure: failure("invalid_payment_information", "wrong_pin", desc ?? "Wrong PIN entered.") };
    case undefined:
      return { status: "unknown", providerReference: ref };
    default:
      return { status: "declined", providerReference: ref, providerStatus: code, failure: failure("issuer_decline", `mpesa_${code}`, desc ?? "Declined.") };
  }
}

export const mpesaAdapter: ProviderAdapter = {
  descriptor: {
    id: "mpesa",
    displayName: "M-Pesa (Safaricom Daraja)",
    category: "mobile_money",
    description: "Direct STK-push collections from M-Pesa wallets in Kenya.",
    website: "https://developer.safaricom.co.ke",
    docsUrl: "https://developer.safaricom.co.ke/APIs",
    countries: ["KE"],
    currencies: ["KES"],
    methods: ["mobile_money"],
    operations: { charge: true, status: true, refund: false, partialRefund: false, webhooks: true, settlementReports: false },
    limits: { KES: { minMinor: 100, maxMinor: 25_000_000 } },
    pricing: { pctBps: 0, fixedMinor: 0, fixedCurrency: "KES", notes: "Tariff depends on Paybill/Till agreement with Safaricom." },
    credentials: [
      { key: "consumerKey", label: "Consumer key", secret: true, required: true },
      { key: "consumerSecret", label: "Consumer secret", secret: true, required: true },
      { key: "shortcode", label: "Business shortcode", secret: false, required: true },
      { key: "passkey", label: "Lipa na M-Pesa passkey", secret: true, required: true },
      { key: "callbackSecret", label: "Callback secret (any random string)", secret: true, required: true },
    ],
    envCredentials: {
      consumerKey: "MPESA_CONSUMER_KEY",
      consumerSecret: "MPESA_CONSUMER_SECRET",
      shortcode: "MPESA_SHORTCODE",
      passkey: "MPESA_PASSKEY",
      callbackSecret: "MPESA_CALLBACK_SECRET",
    },
  },

  async charge(ctx, req) {
    if (req.amountMinor % 100 !== 0) {
      return { status: "failed", failure: failure("unsupported", "whole_shillings_only", "M-Pesa accepts whole KES amounts only.", { safeToFailover: true }) };
    }
    const phone = normalizeKenyanMsisdn(req.customer?.phone);
    if (!phone) {
      return { status: "failed", failure: failure("invalid_payment_information", "phone_required", "A valid Kenyan phone number is required for M-Pesa.", { safeToFailover: true }) };
    }
    const cb = callbackUrl(ctx, "mpesa");
    if (!cb) return { status: "failed", failure: failure("configuration_error", "no_callback_url", "No public callback URL is configured (CONVEX_SITE_URL).", { safeToFailover: true }) };
    const bearer = await token(ctx);
    if (!bearer) return { status: "failed", failure: failure("configuration_error", "oauth_failed", "Could not obtain an M-Pesa access token.", { safeToFailover: true }) };
    const shortcode = requireCredential(ctx, "shortcode", NAME);
    const ts = eatTimestamp(ctx.now());
    const o = await providerFetch(ctx, `${base(ctx)}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: btoa(`${shortcode}${requireCredential(ctx, "passkey", NAME)}${ts}`),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: req.amountMinor / 100,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: `${cb}?token=${await callbackToken(ctx)}`,
        AccountReference: req.reference.slice(0, 12),
        TransactionDesc: (req.description ?? "Payment").slice(0, 13),
      }),
    });
    if (o.kind === "response" && o.status === 200 && str(o.json, "ResponseCode") === "0") {
      return {
        status: "requires_action",
        providerReference: str(o.json, "CheckoutRequestID"),
        providerStatus: "stk_sent",
        nextAction: { type: "await_customer_confirmation", instructions: "Approve the M-Pesa prompt on your phone and enter your PIN." },
      };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    if (!q.providerReference) return { status: "unknown" };
    const bearer = await token(ctx);
    if (!bearer) return { status: "unknown" };
    const shortcode = requireCredential(ctx, "shortcode", NAME);
    const ts = eatTimestamp(ctx.now());
    const o = await providerFetch(ctx, `${base(ctx)}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: btoa(`${shortcode}${requireCredential(ctx, "passkey", NAME)}${ts}`),
        Timestamp: ts,
        CheckoutRequestID: q.providerReference,
      }),
    });
    if (o.kind === "response" && o.status === 200) {
      return mapResultCode(str(o.json, "ResultCode"), str(o.json, "ResultDesc"), q.providerReference);
    }
    // 500.001.1001 = "The transaction is being processed".
    if (o.kind === "response" && str(o.json, "errorCode")?.startsWith("500.001.1001")) {
      return { status: "pending", providerReference: q.providerReference };
    }
    return { status: "unknown", providerReference: q.providerReference };
  },

  async refund() {
    return {
      status: "failed",
      failure: failure("unsupported", "refund_unsupported", "M-Pesa reversals require the Reversal API with an initiator certificate; process via the Safaricom portal and record manually."),
    };
  },

  async verifyWebhook(ctx, input) {
    const tok = new URL(input.url).searchParams.get("token");
    if (!tok || !ctx.credentials.callbackSecret) return false;
    return timingSafeEqual(tok, await callbackToken(ctx));
  },

  parseWebhook(_ctx, input) {
    const body = JSON.parse(input.rawBody);
    const cb = get(body, "Body.stkCallback");
    const items = (get(cb, "CallbackMetadata.Item") as { Name: string; Value?: unknown }[] | undefined) ?? [];
    const meta = Object.fromEntries(items.map((i) => [i.Name, i.Value]));
    const code = str(cb, "ResultCode");
    const mapped = mapResultCode(code, str(cb, "ResultDesc"), str(cb, "CheckoutRequestID"));
    return [
      {
        eventId: `${str(cb, "CheckoutRequestID")}:${code}`,
        type: "payment",
        rawType: `stk_callback_${code}`,
        status: mapped.status,
        providerReference: str(cb, "CheckoutRequestID"),
        amountMinor: typeof meta.Amount === "number" ? Math.round(meta.Amount * 100) : undefined,
        currency: "KES",
        failure: mapped.failure,
      },
    ];
  },
};
