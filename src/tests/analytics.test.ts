import { describe, expect, test } from "bun:test";
import { computeOverview, providerPerformance, anomalyScore, linearForecast, toCsv, percentile, type TxnRow } from "../convex/lib/analytics";

const day = Date.UTC(2026, 9, 1);
const t = (o: Partial<TxnRow>): TxnRow => ({ status: "SUCCESSFUL", amountMinor: 1000, currency: "USD", paymentMethod: "card", provider: "stripe", createdAt: day, ...o });

describe("analytics", () => {
  test("success rate excludes pending and never sums currencies", () => {
    const o = computeOverview(
      [
        t({}),
        t({ currency: "NGN", amountMinor: 500_000, provider: "paystack", country: "NG" }),
        t({ status: "DECLINED", failureCategory: "issuer_decline", failureCode: "card_declined" }),
        t({ status: "PENDING" }),
        t({ status: "REFUNDED", refundedMinor: 1000 }),
      ],
      day,
      day + 86_400_000 - 1,
    );
    expect(o.totals.successful).toBe(3);
    expect(o.totals.pending).toBe(1);
    expect(o.totals.successRate).toBe(3 / 4);
    expect(o.volumeByCurrency).toEqual({ USD: 2000, NGN: 500_000 });
    expect(o.failureReasons[0]).toEqual({ category: "issuer_decline", code: "card_declined", count: 1 });
    expect(o.byCountry.find((b) => b.key === "NG")?.successRate).toBe(1);
    expect(o.daily).toHaveLength(1);
  });

  test("provider ranking prefers success then fewer provider errors", () => {
    const rows = [
      ...Array.from({ length: 9 }, () => ({ providerId: "a", status: "successful", latencyMs: 300, startedAt: 0, currency: "USD", paymentMethod: "card" })),
      { providerId: "a", status: "unknown", latencyMs: 20_000, startedAt: 0, currency: "USD", paymentMethod: "card" },
      ...Array.from({ length: 10 }, () => ({ providerId: "b", status: "successful", latencyMs: 900, startedAt: 0, currency: "USD", paymentMethod: "card" })),
    ];
    const p = providerPerformance(rows);
    expect(p[0].providerId).toBe("b");
    expect(p[1].providerErrorRate).toBe(0.1);
    expect(p[1].latencyP95Ms).toBe(20_000);
  });

  test("anomaly z-score flags a spike and ignores flat noise", () => {
    expect(anomalyScore([0.02, 0.03, 0.02, 0.025, 0.03, 0.3])!.z).toBeGreaterThan(3);
    expect(Math.abs(anomalyScore([10, 10, 10, 10, 10, 10])!.z)).toBeLessThan(0.01);
    expect(anomalyScore([1, 2])).toBe(null);
  });

  test("forecast follows the trend and never goes negative", () => {
    expect(linearForecast([1, 2, 3, 4], 2)).toEqual([5, 6]);
    expect(linearForecast([4, 3, 2, 1], 3)).toEqual([0, 0, 0]);
    expect(percentile([5, 1, 9, 3], 50)).toBe(3);
  });

  test("CSV export neutralizes formula injection", () => {
    expect(toCsv(["a", "b"], [["=HYPERLINK(1)", 'x,"y"']])).toBe(`a,b\n'=HYPERLINK(1),"x,""y"""`);
  });
});
