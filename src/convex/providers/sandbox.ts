// USOPGRID sandbox rails — deterministic simulation, sandbox keys only.
//
// Two rails ("sandbox" primary, "sandbox_backup") so failover, circuit
// breaking and unknown-outcome recovery can be exercised end to end.
// Drive outcomes with metadata.simulate:
//   success (default) | pending | requires_action | issuer_decline |
//   insufficient_funds | fraud_rejection | invalid_payment_information |
//   customer_cancellation | timeout (unknown → resolves successful) |
//   timeout_declined (unknown → resolves declined) | failover (primary down,
//   backup succeeds) | provider_down (every rail down)

import type { ProviderAdapter, ProviderDescriptor, ChargeResult, FailureInfo } from "./types";
import { PAYMENT_METHODS, failure } from "./types";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto";

const DECLINES: Record<string, FailureInfo> = {
  issuer_decline: failure("issuer_decline", "sandbox_card_declined", "The issuer declined this payment (simulated)."),
  insufficient_funds: failure("insufficient_funds", "sandbox_insufficient_funds", "Insufficient funds (simulated)."),
  fraud_rejection: failure("fraud_rejection", "sandbox_fraud_rejected", "Blocked by provider-side fraud screening (simulated)."),
  invalid_payment_information: failure("invalid_payment_information", "sandbox_invalid_details", "Payment details failed validation (simulated)."),
  customer_cancellation: failure("customer_cancellation", "sandbox_cancelled", "Customer cancelled (simulated).", { retryable: true }),
};

export const SANDBOX_SIMULATION_KEYS = [
  "success",
  "pending",
  "requires_action",
  ...Object.keys(DECLINES),
  "timeout",
  "timeout_declined",
  "failover",
  "provider_down",
];

function ref(prefix: string, txn: string): string {
  return `${prefix}_${txn.slice(-10)}_${Math.floor(Math.random() * 1e6).toString().padStart(6, "0")}`;
}

function makeSandbox(id: string, displayName: string, isBackup: boolean): ProviderAdapter {
  const descriptor: ProviderDescriptor = {
    id,
    displayName,
    category: "sandbox",
    description: isBackup
      ? "Secondary simulated rail — receives traffic when the primary sandbox rail is unavailable."
      : "Simulated rail covering every country, currency and method. Never moves real money.",
    website: "https://usopgrid.com/developers",
    docsUrl: "https://usopgrid.com/developers#sandbox",
    countries: "global",
    currencies: "all",
    methods: PAYMENT_METHODS,
    operations: { charge: true, status: true, refund: true, partialRefund: true, webhooks: true, settlementReports: true, payouts: true, recurring: true },
    pricing: isBackup
      ? { pctBps: 250, fixedMinor: 20, fixedCurrency: "USD", notes: "Simulated pricing (backup)" }
      : { pctBps: 200, fixedMinor: 25, fixedCurrency: "USD", notes: "Simulated pricing" },
    credentials: [],
    envCredentials: {},
  };

  return {
    descriptor,
    async charge(_ctx, req): Promise<ChargeResult> {
      const sim = String(req.metadata?.simulate ?? "success").toLowerCase();
      const pref = isBackup ? "sbb" : "sbx";
      if (sim === "provider_down" || (sim === "failover" && !isBackup)) {
        return {
          status: "failed",
          failure: failure("provider_outage", "sandbox_provider_down", `${displayName} is unavailable (simulated).`, { retryable: true, safeToFailover: true }),
        };
      }
      if (DECLINES[sim]) return { status: "declined", providerReference: ref(pref, req.transactionId), failure: DECLINES[sim] };
      if (sim === "pending") return { status: "pending", providerReference: ref(pref, req.transactionId), providerStatus: "processing" };
      if (sim === "requires_action") {
        return {
          status: "requires_action",
          providerReference: ref(pref, req.transactionId),
          nextAction: { type: "redirect", url: `https://sandbox.usopgrid.com/authenticate/${req.transactionId}` },
        };
      }
      if (sim === "timeout" || sim === "timeout_declined") {
        // The provider "accepted" the request but the response was lost.
        return {
          status: "unknown",
          providerReference: `${pref}_${sim === "timeout" ? "late_ok" : "late_dec"}_${req.transactionId.slice(-10)}`,
          failure: failure("timeout", "outcome_unknown", `${displayName} timed out after accepting the request (simulated).`, { retryable: true }),
        };
      }
      if (!DECLINES[sim] && !["success", "failover"].includes(sim)) {
        return { status: "failed", failure: failure("invalid_payment_information", "sandbox_unknown_simulation", `Unknown simulate directive '${sim}'. Try one of: ${SANDBOX_SIMULATION_KEYS.join(", ")}.`, { safeToFailover: false }) };
      }
      if (req.recurring && !/^sbx_tok_[A-Za-z0-9]+$/.test(req.paymentToken ?? "")) {
        return { status: "failed", failure: failure("invalid_payment_information", "sandbox_bad_token", "Saved payment method token is not recognised by the sandbox.", { safeToFailover: false }) };
      }
      return {
        status: "successful",
        providerReference: ref(pref, req.transactionId),
        providerStatus: "captured",
        providerFeeMinor: Math.round((req.amountMinor * descriptor.pricing.pctBps) / 10_000),
        reportedAmountMinor: req.amountMinor,
        reportedCurrency: req.currency,
        reusableToken: req.savePaymentMethod && !req.recurring ? { token: `sbx_tok_${req.transactionId.replace(/[^A-Za-z0-9]/g, "").slice(-16)}`, brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 } : undefined,
      };
    },
    async getStatus(_ctx, q) {
      const r = q.providerReference ?? "";
      if (r.includes("_late_ok_")) return { status: "successful", providerReference: r, providerStatus: "captured" };
      if (r.includes("_late_dec_")) return { status: "declined", providerReference: r, failure: DECLINES.issuer_decline };
      if (!r) return { status: "failed", failure: failure("network_error", "not_found_at_provider", "No record at sandbox rail.", { safeToFailover: true }) };
      // Simulated async rails settle on first status check.
      return { status: "successful", providerReference: r, providerStatus: "captured" };
    },
    async refund(_ctx, req) {
      return { status: "successful", providerRefundReference: `${isBackup ? "sbbr" : "sbxr"}_${req.refundId.slice(-8)}` };
    },
    async payout(_ctx, req) {
      // metadata.simulate: success (default) | pending | failed | insufficient_funds | timeout
      const sim = String(req.metadata?.simulate ?? "success").toLowerCase();
      const ref = `${isBackup ? "sbbp" : "sbxp"}_${req.reference.slice(-12)}`;
      if (sim === "pending") return { status: "pending", providerReference: ref, providerStatus: "processing" };
      if (sim === "timeout") return { status: "unknown", providerReference: `${ref}_late_ok`, failure: failure("timeout", "outcome_unknown", "Payout rail timed out (simulated).", { retryable: true }) };
      if (sim !== "success") {
        return { status: "failed", providerReference: ref, failure: failure(sim === "insufficient_funds" ? "insufficient_funds" : "temporary_provider_failure", `sandbox_payout_${sim}`, `Payout failed in sandbox simulation (${sim}).`, { retryable: sim !== "insufficient_funds" }) };
      }
      return { status: "successful", providerReference: ref, providerStatus: "paid" };
    },
    async getPayoutStatus(_ctx, q) {
      return { status: "successful", providerReference: q.providerReference ?? q.reference, providerStatus: "paid" };
    },
    async verifyWebhook(ctx, input) {
      // Sandbox events are signed like USOPGRID's own outbound webhooks.
      const secret = ctx.credentials.webhookSecret ?? "whsec_sandbox";
      const sig = input.headers.get("x-usopgrid-signature") ?? "";
      const m = /t=(\d+),v1=([0-9a-f]+)/.exec(sig);
      if (!m) return false;
      return timingSafeEqual(await hmacSha256Hex(secret, `${m[1]}.${input.rawBody}`), m[2]);
    },
    parseWebhook(_ctx, input) {
      const e = JSON.parse(input.rawBody) as { id: string; type: string; providerReference?: string; reference?: string; status?: string; amount?: number; currency?: string };
      return [
        {
          eventId: e.id,
          type: e.type.startsWith("refund") ? "refund" : "payment",
          rawType: e.type,
          status: e.status as never,
          providerReference: e.providerReference,
          reference: e.reference,
          amountMinor: e.amount,
          currency: e.currency,
        },
      ];
    },
  };
}

export const sandboxAdapter = makeSandbox("sandbox", "USOPGRID Sandbox Rail", false);
export const sandboxBackupAdapter = makeSandbox("sandbox_backup", "USOPGRID Sandbox Backup Rail", true);
