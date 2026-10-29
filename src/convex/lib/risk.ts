// USOPGRID risk engine — deterministic rules scoring.
//
// This is a transparent, auditable rules engine, NOT machine learning. Every
// score is explainable: each rule that fires adds a reason string and a
// weighted contribution. Decisions map to review workflows:
//   ALLOW  → process normally
//   REVIEW → process, flag for operations review (score recorded)
//   HOLD   → decline, may be released by operations
//   BLOCK  → decline, do not retry (fraud signal)
//
// Inputs that require database reads (velocity counters) are supplied by the
// caller, so this module stays pure and unit-testable.

export interface RiskSignals {
  /** Transactions for the same org+customerEmail in the last 10 minutes. */
  customerTxns10m: number;
  /** Failed transactions for the same org+customerEmail in the last 30 min. */
  customerFailed30m: number;
  /** Total transactions for the org in the last 60 seconds (burst). */
  orgTxns1m: number;
}

export interface RiskInput {
  amountMinor: number;
  /**
   * Amount converted to USD cents by the FX engine. Amount rules are scored on
   * this so ₦50,000 (≈$30) and $50,000 are not treated alike. When absent,
   * amount rules apply only to NGN (legacy thresholds) and are otherwise skipped.
   */
  amountUsdMinor?: number;
  currency: string;
  paymentMethod: string;
  customerEmail?: string;
  signals: RiskSignals;
}

export interface RiskAssessment {
  score: number; // 0..100
  decision: "ALLOW" | "REVIEW" | "HOLD" | "BLOCK";
  reasons: string[];
}

// Amount thresholds. USD cents are the global basis; NGN kobo thresholds are
// kept for records created before USD normalization existed.
const HIGH_AMOUNT_USD = 300_000; // $3,000
const VERY_HIGH_AMOUNT_USD = 1_500_000; // $15,000
// Fallback when no fresh FX rate is available: the USD limits converted at a
// conservative ₦1,650/US$ and rounded (≈ $3,000 and ≈ $15,000). The earlier
// ₦50,000 / ₦200,000 limits were ~100x stricter than the USD rule and blocked
// ordinary business payments.
const HIGH_AMOUNT_NGN = 500_000_000; // ₦5,000,000
const VERY_HIGH_AMOUNT_NGN = 2_500_000_000; // ₦25,000,000

// Small, honest disposable-email list — extendable data, not code.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
]);

export function evaluatePaymentRisk(input: RiskInput): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];

  // --- Amount-based rules -------------------------------------------------
  const usd = input.amountUsdMinor;
  const [amt, hi, vhi] =
    usd !== undefined
      ? [usd, HIGH_AMOUNT_USD, VERY_HIGH_AMOUNT_USD]
      : input.currency === "NGN"
        ? [input.amountMinor, HIGH_AMOUNT_NGN, VERY_HIGH_AMOUNT_NGN]
        : [0, Infinity, Infinity];
  if (usd === undefined && input.currency !== "NGN" && input.currency !== "USD") {
    // No reliable USD value: record it rather than guess (scored as 0).
    reasons.push("amount_unassessed_no_fx");
  }
  if (amt >= vhi) {
    score += 45;
    reasons.push("amount_very_high");
  } else if (amt >= hi) {
    score += 25;
    reasons.push("amount_high");
  }

  // --- Customer velocity (10-minute window) -------------------------------
  if (input.signals.customerTxns10m > 10) {
    score += 55;
    reasons.push("customer_velocity_extreme");
  } else if (input.signals.customerTxns10m > 5) {
    score += 30;
    reasons.push("customer_velocity_high");
  }

  // --- Failed-payment velocity (card-testing signal) ----------------------
  if (input.signals.customerFailed30m >= 3) {
    score += 35;
    reasons.push("repeated_failures");
  }

  // --- Org-wide burst ------------------------------------------------------
  if (input.signals.orgTxns1m > 30) {
    score += 20;
    reasons.push("org_burst");
  }

  // --- Email signals -------------------------------------------------------
  const email = input.customerEmail?.toLowerCase();
  if (!email) {
    score += 10;
    reasons.push("no_customer_email");
  } else {
    const domain = email.split("@")[1];
    if (domain && DISPOSABLE_DOMAINS.has(domain)) {
      score += 25;
      reasons.push("disposable_email_domain");
    }
  }

  // --- Payment-method weighting -------------------------------------------
  // Card-not-present carries the highest fraud exposure; bank rails are
  // account-verified and effectively pre-authenticated.
  if (input.paymentMethod === "card") {
    score += 5;
  }

  score = Math.min(100, score);

  const decision: RiskAssessment["decision"] =
    score >= 70 ? "BLOCK" : score >= 45 ? "HOLD" : score >= 25 ? "REVIEW" : "ALLOW";

  return { score, decision, reasons };
}
