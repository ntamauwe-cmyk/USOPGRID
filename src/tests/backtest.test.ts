// Routing backtest and provider scorecards.
import { describe, expect, test } from "bun:test";
import { backtest, historyFromAttempts, percentile, scorecards, wilson, MIN_SAMPLE, type HistoricalPayment, type AttemptRow } from "../convex/lib/backtest";
import type { Candidate } from "../convex/orchestration/router";
import { getAdapter } from "../convex/providers/index";

const cand = (providerId: string, connectionId: string, pricing?: Candidate["pricing"]): Candidate => ({
  providerId,
  connectionId,
  descriptor: getAdapter("sandbox")!.descriptor,
  priority: 0,
  enabled: true,
  pricing,
});

function hist(n: number, provider: string, conn: string, successEvery: number, latency = 400): HistoricalPayment[] {
  return Array.from({ length: n }, (_, i) => ({
    amountMinor: 1_000_000,
    currency: "NGN",
    method: "card",
    country: "NG",
    first: { providerId: provider, connectionId: conn, success: i % successEvery !== 0, latencyMs: latency },
  }));
}

describe("wilson interval", () => {
  test("is null with no data, brackets the rate, and narrows with more data", () => {
    expect(wilson(0, 0).rate).toBeNull();
    const small = wilson(9, 10);
    const big = wilson(900, 1000);
    expect(small.low!).toBeLessThan(0.9);
    expect(small.high!).toBeGreaterThan(0.9);
    expect(big.high! - big.low!).toBeLessThan(small.high! - small.low!);
    // Known value: 95% Wilson for 9/10 ≈ [0.596, 0.982]
    expect(small.low!).toBeCloseTo(0.596, 2);
    expect(small.high!).toBeCloseTo(0.982, 2);
  });
  test("percentile uses nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});

describe("routing backtest", () => {
  const candidates = [cand("alpha", "c-alpha", { pctBps: 150, fixedMinor: 0, fixedCurrency: "NGN" }), cand("beta", "c-beta", { pctBps: 100, fixedMinor: 0, fixedCurrency: "NGN" })];
  // alpha handled 60 payments (1 in 3 failed); beta handled 60 (1 in 20 failed).
  const history = [...hist(60, "alpha", "c-alpha", 3, 300), ...hist(60, "beta", "c-beta", 20, 900)];
  const preferAlpha = { rules: [{ id: "r1", name: "alpha", enabled: true, order: 1, match: {}, action: { type: "only" as const, providers: ["alpha"] } }] };
  const preferBeta = { rules: [{ id: "r2", name: "beta", enabled: true, order: 1, match: {}, action: { type: "only" as const, providers: ["beta"] } }] };

  test("uses observed outcomes where the choice is unchanged and estimates the rest", () => {
    const r = backtest(history, candidates, {}, preferAlpha, preferBeta);
    expect(r.current.observed).toBe(60);
    expect(r.current.estimated).toBe(60);
    expect(r.proposed.observed).toBe(60);
    expect(r.changedDecisions).toBe(120);
    // Moving everything to the more reliable provider improves expected success…
    expect(r.delta.successRatePoints!).toBeGreaterThan(10);
    // …at the cost of latency, which the backtest surfaces as a trade-off.
    expect(r.delta.avgLatencyMs!).toBeGreaterThan(0);
    // …and lower fees per success.
    expect(r.proposed.costPerSuccessByCurrency.NGN!).toBeLessThan(r.current.costPerSuccessByCurrency.NGN!);
  });

  test("an identical policy changes nothing and is fully observed", () => {
    const r = backtest(history, candidates, {}, preferAlpha, preferAlpha);
    expect(r.changedDecisions).toBe(0);
    expect(r.delta.successRatePoints).toBe(0);
  });

  test("estimates on thin data are flagged low confidence", () => {
    const thin = [...hist(60, "alpha", "c-alpha", 3), ...hist(5, "beta", "c-beta", 2)];
    const r = backtest(thin, candidates, {}, preferAlpha, preferBeta);
    expect(r.proposed.lowConfidence).toBe(60);
  });

  test("payments nobody can route are counted, not hidden", () => {
    const none = { rules: [{ id: "x", name: "none", enabled: true, order: 1, match: {}, action: { type: "only" as const, providers: ["gamma"] } }] };
    const r = backtest(history, candidates, {}, preferAlpha, none);
    expect(r.proposed.unroutable).toBe(120);
    expect(r.proposed.successRate).toBeNull();
  });
});

describe("provider scorecards", () => {
  const row = (o: Partial<AttemptRow>): AttemptRow => ({ providerId: "alpha", connectionId: "c-alpha", status: "successful", latencyMs: 100, probe: false, currency: "NGN", amountMinor: 100_000, ...o });

  test("separates provider faults, customer declines, timeouts, probes and in-flight attempts", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row({ latencyMs: 100 + i })),
      row({ status: "declined", failureCategory: "insufficient_funds" }),
      row({ status: "failed", failureCategory: "provider_outage" }),
      row({ status: "unknown", failureCategory: "timeout" }),
      row({ status: "pending" }),
      row({ probe: true }),
    ];
    const [s] = scorecards(rows, () => ({ pctBps: 100, fixedMinor: 0, fixedCurrency: "NGN" }));
    expect(s.attempts).toBe(34);
    expect(s.decided).toBe(33);
    expect(s.inFlight).toBe(1);
    expect(s.probes).toBe(1);
    expect(s.successRate.rate).toBeCloseTo(30 / 33, 5);
    expect(s.approvalRate).toBeCloseTo(30 / 31, 5);
    expect(s.providerErrorRate).toBeCloseTo(1 / 33, 5);
    expect(s.timeoutRate).toBeCloseTo(1 / 33, 5);
    expect(s.costPerSuccessByCurrency.NGN).toBe(1000);
    expect(s.sufficient).toBe(true);
  });

  test("small samples are marked insufficient with a stated limitation", () => {
    const [s] = scorecards([row({}), row({})], () => undefined);
    expect(s.sufficient).toBe(false);
    expect(s.limitations.join(" ")).toContain(String(MIN_SAMPLE));
    expect(s.costPerSuccessByCurrency.NGN).toBeNull();
  });

  test("history keeps only first attempts of decided customer payments", () => {
    const base = { paymentMethod: "card", ...row({}) };
    const h = historyFromAttempts([
      { ...base, transactionId: "t1", attempt: 1, status: "failed", failureCategory: "provider_outage" },
      { ...base, transactionId: "t1", attempt: 2, connectionId: "c-beta", providerId: "beta" },
      { ...base, transactionId: "t2", attempt: 1, probe: true },
      { ...base, transactionId: "t3", attempt: 1, status: "pending" },
    ]);
    expect(h).toHaveLength(1);
    expect(h[0].first.connectionId).toBe("c-alpha");
    expect(h[0].first.success).toBe(false);
  });
});
