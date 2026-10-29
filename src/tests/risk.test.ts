// Unit tests: risk engine rules, scoring and decision bands.
import { describe, expect, test } from "bun:test";
import { evaluatePaymentRisk } from "../convex/lib/risk";

const quiet = {
  customerTxns10m: 0,
  customerFailed30m: 0,
  orgTxns1m: 0,
};

function input(overrides: Partial<Parameters<typeof evaluatePaymentRisk>[0]> = {}) {
  return {
    amountMinor: 100_000, // ₦1,000
    currency: "NGN",
    paymentMethod: "card",
    customerEmail: "shopper@example.com",
    signals: { ...quiet },
    ...overrides,
  };
}

describe("risk engine", () => {
  test("low-risk payment is ALLOWed with no reasons", () => {
    const r = evaluatePaymentRisk(input());
    expect(r.decision).toBe("ALLOW");
    expect(r.score).toBeLessThan(25);
    expect(r.reasons).toEqual([]);
  });

  test("high amount triggers REVIEW band", () => {
    const r = evaluatePaymentRisk(input({ amountMinor: 600_000_000 })); // ₦6,000,000 (no FX: NGN fallback)
    expect(r.reasons).toContain("amount_high");
    expect(["REVIEW", "HOLD"]).toContain(r.decision);
  });

  test("very high amount contributes more than high amount", () => {
    const hi = evaluatePaymentRisk(input({ amountMinor: 600_000_000 }));
    const vhi = evaluatePaymentRisk(input({ amountMinor: 2_600_000_000 }));
    expect(vhi.score).toBeGreaterThan(hi.score);
    expect(vhi.reasons).toContain("amount_very_high");
  });

  test("extreme customer velocity lands in HOLD (funds not taken)", () => {
    const r = evaluatePaymentRisk(
      input({ signals: { ...quiet, customerTxns10m: 12 } }),
    );
    expect(r.reasons).toContain("customer_velocity_extreme");
    expect(r.decision).toBe("HOLD");
    // Combined with repeated failures, the same traffic blocks:
    const worse = evaluatePaymentRisk(
      input({ signals: { customerTxns10m: 12, customerFailed30m: 3, orgTxns1m: 0 } }),
    );
    expect(worse.decision).toBe("BLOCK");
  });

  test("repeated failures (card-testing signal) trigger REVIEW", () => {
    const r = evaluatePaymentRisk(
      input({ signals: { ...quiet, customerFailed30m: 3 } }),
    );
    expect(r.reasons).toContain("repeated_failures");
    expect(r.decision).toBe("REVIEW");
    expect(r.score).toBeGreaterThanOrEqual(25);
  });

  test("disposable email domain is flagged", () => {
    const r = evaluatePaymentRisk(input({ customerEmail: "x@mailinator.com" }));
    expect(r.reasons).toContain("disposable_email_domain");
  });

  test("missing customer email adds a small penalty", () => {
    const withEmail = evaluatePaymentRisk(input());
    const without = evaluatePaymentRisk(input({ customerEmail: undefined }));
    expect(without.score).toBe(withEmail.score + 10);
    expect(without.reasons).toContain("no_customer_email");
  });

  test("score is capped at 100", () => {
    const r = evaluatePaymentRisk(
      input({
        amountMinor: 30_000_000,
        signals: { customerTxns10m: 20, customerFailed30m: 10, orgTxns1m: 50 },
        customerEmail: "y@tempmail.com",
      }),
    );
    expect(r.score).toBe(100);
    expect(r.decision).toBe("BLOCK");
  });

  test("every decision comes with explainable reasons when score > 0", () => {
    const r = evaluatePaymentRisk(input({ amountMinor: 600_000_000 }));
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("risk engine — global amount normalization", () => {
  test("USD-equivalent drives amount rules in every currency", () => {
    // ¥6,000,000 is ≈ $40,000 — very high — even though the integer is small for NGN rules.
    const jpy = evaluatePaymentRisk(input({ currency: "JPY", amountMinor: 6_000_000, amountUsdMinor: 4_000_000 }));
    expect(jpy.reasons).toContain("amount_very_high");
    // ₦6,000,000 kobo (₦60,000 ≈ $40) is small in USD terms.
    const ngn = evaluatePaymentRisk(input({ currency: "NGN", amountMinor: 6_000_000, amountUsdMinor: 4_000 }));
    expect(ngn.reasons).not.toContain("amount_high");
  });
  test("without an FX conversion non-NGN amounts are not mis-scored", () => {
    const r = evaluatePaymentRisk(input({ currency: "IDR", amountMinor: 50_000_000 }));
    expect(r.reasons).not.toContain("amount_high");
    expect(r.reasons).not.toContain("amount_very_high");
  });

  test("regression: an ordinary ₦500,000 business payment is not flagged when FX is unavailable", () => {
    const r = evaluatePaymentRisk(input({ amountMinor: 50_000_000 }));
    expect(r.reasons).not.toContain("amount_high");
    expect(r.reasons).not.toContain("amount_very_high");
    expect(r.decision).toBe("ALLOW");
  });
  test("non-USD/NGN amounts without FX are recorded as unassessed, not guessed", () => {
    const r = evaluatePaymentRisk(input({ currency: "KES", amountMinor: 999_999_999 }));
    expect(r.reasons).toContain("amount_unassessed_no_fx");
    expect(r.reasons).not.toContain("amount_very_high");
  });
});
