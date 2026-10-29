// FX engine: exact rational conversion, spreads, cross rates and quotes.
import { describe, expect, test } from "bun:test";
import { parseRate, convertMinor, buildQuote, pairRate, convertAtMid, mergeSnapshots, isQuoteValid, applySpread, rationalToString } from "../convex/lib/fx";
import { decimalToMinor, minorToDecimalString } from "../lib/money";

const snap = { base: "USD", rates: { NGN: "1530.25", EUR: "0.92", JPY: "151.4", KWD: "0.3071", GBP: "0.79" }, source: "t", timestamp: 0 };

describe("fx engine", () => {
  test("parses decimal rates exactly", () => {
    expect(parseRate("1530.25")).toEqual({ num: 6121n, den: 4n });
    expect(() => parseRate("-1")).toThrow();
    expect(() => parseRate("0")).toThrow();
  });
  test("converts across exponents with half-even rounding", () => {
    // $10.00 → ₦15,302.50
    expect(convertMinor(1000, "USD", "NGN", parseRate("1530.25"))).toBe(1_530_250);
    // $10.00 → ¥1,514 (JPY has 0 decimals)
    expect(convertMinor(1000, "USD", "JPY", parseRate("151.4"))).toBe(1514);
    // $10.00 → 3.071 KWD (3 decimals)
    expect(convertMinor(1000, "USD", "KWD", parseRate("0.3071"))).toBe(3071);
  });
  test("cross rates through the base", () => {
    expect(pairRate(snap, "EUR", "NGN")).toBe(rationalToString(parseRate("1663.315217391304"), 12));
    expect(convertAtMid(snap, 1_530_250, "NGN", "USD")).toBe(1000);
    expect(pairRate(snap, "USD", "XYZ")).toBe(undefined);
  });
  test("quotes apply the spread against the customer and expire", () => {
    const q = buildQuote({ from: "USD", to: "NGN", amountMinor: 10_000, midRate: "1530.25", spreadBps: 100, source: "t", sourceTimestamp: 0, now: 1000, ttlMs: 60_000 });
    expect(q.targetAmountMinor).toBe(15_149_475); // 1% below mid
    expect(q.spreadCostMinor).toBe(15_302_500 - 15_149_475);
    expect(isQuoteValid(q, 60_999)).toBe(true);
    expect(isQuoteValid(q, 61_000)).toBe(false);
    expect(() => applySpread(parseRate("1"), 10_000)).toThrow();
  });
  test("snapshots merge with first-source precedence", () => {
    const m = mergeSnapshots([
      { base: "USD", rates: { EUR: "0.92" }, source: "ecb", timestamp: 5 },
      { base: "USD", rates: { EUR: "0.95", NGN: "1500" }, source: "er", timestamp: 9 },
    ])!;
    expect(m.rates).toEqual({ EUR: "0.92", NGN: "1500" });
    expect(m.source).toBe("ecb+er");
    expect(m.timestamp).toBe(5);
  });
  test("money string conversions are exact and reject excess precision", () => {
    expect(minorToDecimalString(125050, "USD")).toBe("1250.50");
    expect(minorToDecimalString(1234, "KWD")).toBe("1.234");
    expect(decimalToMinor("1250.5", "USD")).toBe(125050);
    expect(() => decimalToMinor("10.005", "USD")).toThrow();
    expect(decimalToMinor(1500, "JPY")).toBe(1500);
  });
});
