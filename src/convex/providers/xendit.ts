// Xendit adapter — Invoices API (Southeast Asia).
// Docs: https://developers.xendit.co/api-reference/#invoices ,
//       https://docs.xendit.co/docs/handling-webhooks
// Auth: HTTP Basic with the secret key as username. AMOUNTS ARE MAJOR UNITS.
// Webhooks: x-callback-token must equal the account's verification token;
// successes are re-confirmed by invoice lookup before booking.

import type { ProviderAdapter, ChargeResult, AdapterContext } from "./types";
import { failure } from "./types";
import { providerFetch, classifyHttpFailure, unknownOutcome, requireCredential, str, get } from "./http";
import { timingSafeEqual } from "../lib/crypto";
import { minorToDecimalString, decimalToMinor } from "../../lib/money";

const API = "https://api.xendit.co";
const NAME = "Xendit";
// Xendit charges these currencies in whole units only.
const WHOLE_UNITS = new Set(["IDR", "VND"]);

function headers(ctx: AdapterContext): Record<string, string> {
  return {
    Authorization: `Basic ${btoa(`${requireCredential(ctx, "secretKey", NAME)}:`)}`,
    "Content-Type": "application/json",
  };
}

function mapInvoice(j: unknown): ChargeResult {
  const s = str(j, "status");
  const id = str(j, "id");
  const cur = str(j, "currency");
  const paid = get(j, "paid_amount") ?? get(j, "amount");
  let reportedAmountMinor: number | undefined;
  try {
    reportedAmountMinor = cur && paid !== undefined ? decimalToMinor(paid as number, cur) : undefined;
  } catch {
    reportedAmountMinor = undefined;
  }
  if (s === "PAID" || s === "SETTLED") return { status: "successful", providerReference: id, providerStatus: s, reportedAmountMinor, reportedCurrency: cur };
  if (s === "EXPIRED") return { status: "failed", providerReference: id, providerStatus: s, failure: failure("customer_cancellation", "invoice_expired", "Invoice expired unpaid.") };
  if (s === "PENDING") {
    const url = str(j, "invoice_url");
    return { status: "requires_action", providerReference: id, providerStatus: s, nextAction: url ? { type: "redirect", url } : undefined };
  }
  return { status: "unknown", providerReference: id, providerStatus: s };
}

export const xenditAdapter: ProviderAdapter = {
  descriptor: {
    id: "xendit",
    displayName: "Xendit",
    category: "regional_psp",
    description: "Southeast Asia collections: virtual accounts, e-wallets, QRIS/QR Ph, cards, retail outlets.",
    website: "https://www.xendit.co",
    docsUrl: "https://developers.xendit.co/api-reference/",
    countries: ["ID", "PH", "TH", "VN", "MY"],
    currencies: ["IDR", "PHP", "THB", "VND", "MYR", "USD"],
    methods: ["bank_transfer", "wallet", "qr", "card", "cash_voucher", "direct_debit"],
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true },
    limits: { IDR: { minMinor: 1_000_00 }, PHP: { minMinor: 1_00 } },
    pricing: { pctBps: 290, fixedMinor: 2_000_00, fixedCurrency: "IDR", notes: "Varies by method: VA flat fee, e-wallet %, cards 2.9% + fixed." },
    credentials: [
      { key: "secretKey", label: "Secret API key", secret: true, required: true },
      { key: "callbackToken", label: "Webhook verification token", secret: true, required: true },
    ],
    envCredentials: { secretKey: "XENDIT_SECRET_KEY", callbackToken: "XENDIT_CALLBACK_TOKEN" },
  },

  async charge(ctx, req) {
    if (WHOLE_UNITS.has(req.currency) && req.amountMinor % 100 !== 0) {
      return { status: "failed", failure: failure("unsupported", "whole_units_only", `Xendit requires whole ${req.currency} amounts.`, { safeToFailover: true }) };
    }
    const o = await providerFetch(ctx, `${API}/v2/invoices`, {
      method: "POST",
      headers: { ...headers(ctx), "Idempotency-key": req.idempotencyKey },
      body: JSON.stringify({
        external_id: req.transactionId,
        amount: Number(minorToDecimalString(req.amountMinor, req.currency)),
        currency: req.currency,
        payer_email: req.customer?.email,
        description: req.description ?? req.reference,
        success_redirect_url: req.returnUrl,
        failure_redirect_url: req.returnUrl,
        customer: req.customer?.name ? { given_names: req.customer.name, email: req.customer.email, mobile_number: req.customer.phone } : undefined,
        metadata: { usopgrid_transaction_id: req.transactionId },
      }),
    });
    if (o.kind === "response" && o.status === 200) return mapInvoice(o.json);
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async getStatus(ctx, q) {
    const url = q.providerReference
      ? `${API}/v2/invoices/${encodeURIComponent(q.providerReference)}`
      : `${API}/v2/invoices?external_id=${encodeURIComponent(q.transactionId)}`;
    const o = await providerFetch(ctx, url, { method: "GET", headers: headers(ctx) });
    if (o.kind === "response" && o.status === 200) {
      if (q.providerReference) return mapInvoice(o.json);
      const first = Array.isArray(o.json) ? o.json[0] : undefined;
      if (!first) return { status: "failed", failure: failure("network_error", "not_found_at_provider", "No invoice at Xendit.", { safeToFailover: true }) };
      return mapInvoice(first);
    }
    return { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async refund(ctx, req) {
    const o = await providerFetch(ctx, `${API}/refunds`, {
      method: "POST",
      headers: { ...headers(ctx), "Idempotency-key": req.idempotencyKey },
      body: JSON.stringify({
        invoice_id: req.providerReference,
        reference_id: req.refundId,
        amount: Number(minorToDecimalString(req.amountMinor, req.currency)),
        currency: req.currency,
        reason: "REQUESTED_BY_CUSTOMER",
      }),
    });
    if (o.kind === "response" && (o.status === 200 || o.status === 201)) {
      const s = str(o.json, "status");
      return { status: s === "SUCCEEDED" ? "successful" : s === "FAILED" ? "failed" : "pending", providerRefundReference: str(o.json, "id") };
    }
    const f = classifyHttpFailure(o, NAME);
    return f ? { status: "failed", failure: f } : { status: "unknown", failure: unknownOutcome(o, NAME) };
  },

  async verifyWebhook(ctx, input) {
    const expected = ctx.credentials.callbackToken;
    const got = input.headers.get("x-callback-token");
    return !!expected && !!got && timingSafeEqual(expected, got);
  },

  parseWebhook(_ctx, input) {
    const evt = JSON.parse(input.rawBody);
    const mapped = mapInvoice(evt);
    return [
      {
        eventId: `${str(evt, "id")}:${str(evt, "status")}`,
        type: "payment",
        rawType: `invoice_${str(evt, "status")}`,
        status: mapped.status === "requires_action" ? "pending" : mapped.status,
        providerReference: str(evt, "id"),
        reference: str(evt, "external_id"),
        amountMinor: mapped.reportedAmountMinor,
        currency: str(evt, "currency"),
        failure: mapped.failure,
      },
    ];
  },
};
