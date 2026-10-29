// Unit tests: fee engine — deterministic integer rounding and cross-currency
// fixed-fee normalization. Financial math must be exact.
import { describe, expect, test } from "bun:test";
import { computeFees } from "../convex/lib/fees";
import type { Doc } from "../convex/_generated/dataModel";

function merchant(over: Partial<Doc<"merchants">> = {}): Doc<"merchants"> {
  return {
    _id: "m1" as never,
    _creationTime: 0,
    orgId: "o1" as never,
    name: "Fee Test Merchant",
    environment: "sandbox",
    status: "active",
    feeBps: 150, // 1.5%
    feeFixedMinor: 0,
    feeCurrency: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Doc<"merchants">;
}

describe("fee engine", () => {
  test("percentage-only fee, exact half-up rounding", () => {
    // 2500 * 150 / 10000 = 37.5 -> round half-up = 38
    const f = computeFees(merchant(), 2500, "NGN");
    expect(f.feeMinor).toBe(38);
    expect(f.netMinor).toBe(2500 - 38);
    expect(f.currency).toBe("NGN");
    expect(f.parts).toHaveLength(1);
  });

  test("exact percentage has no rounding drift", () => {
    // 150000 * 150 / 10000 = 2250 exactly
    const f = computeFees(merchant(), 150_000, "NGN");
    expect(f.feeMinor).toBe(2250);
    expect(f.netMinor).toBe(147_750);
  });

  test("percentage + fixed fee sum", () => {
    const f = computeFees(merchant({ feeFixedMinor: 100 }), 10_000, "NGN");
    // 10_000 * 150/10000 = 150, + 100 fixed = 250
    expect(f.feeMinor).toBe(250);
    expect(f.parts.map((p) => p.label)).toEqual(["1.50%", "fixed"]);
  });

  test("tiny amounts: exact math, no hidden clamping", () => {
    // 100 * 150/10000 = 1.5 -> rounds to 2; + 5000 fixed = 5002.
    // Net can go negative if merchant pricing is misconfigured — the engine
    // must stay exact (fee parts remain auditable), never silently clamp,
    // because the ledger must reconcile against provider statements.
    const f = computeFees(merchant({ feeFixedMinor: 5000 }), 100, "NGN");
    expect(f.feeMinor).toBe(5002);
    expect(f.netMinor).toBe(100 - 5002);
    expect(f.parts.map((p) => p.amountMinor)).toEqual([2, 5000]);
  });

  test("fixed fee in another currency is never reinterpreted as local minor units", () => {
    // Merchant priced a USD 0.50 fixed fee; transaction in NGN. 50 cents is
    // NOT 50 kobo — without an FX conversion the fixed part is withheld and flagged.
    const f = computeFees(merchant({ feeCurrency: "USD", feeFixedMinor: 50 }), 10_000, "NGN");
    expect(f.feeMinor).toBe(150);
    expect(f.currency).toBe("NGN");
    expect(f.fixedFeeUnconverted).toEqual({ amountMinor: 50, currency: "USD" });
    // With the FX engine's conversion (e.g. 0.50 USD = ₦765.00) it is charged.
    const g = computeFees(merchant({ feeCurrency: "USD", feeFixedMinor: 50 }), 10_000, "NGN", { fixedFeeInTxnMinor: 76_500 });
    expect(g.feeMinor).toBe(150 + 76_500);
    expect(g.fixedFeeUnconverted).toBe(undefined);
  });

  test("zero-fee merchant yields zero fee and full net", () => {
    const f = computeFees(merchant({ feeBps: 0 }), 99_999, "NGN");
    expect(f.feeMinor).toBe(0);
    expect(f.netMinor).toBe(99_999);
    expect(f.parts).toHaveLength(0);
  });
});
