import { describe, expect, test } from "bun:test";
import { capShares, parseSplitInputs, refundReversals, resolveShares, SplitError, MAX_SPLITS } from "../convex/lib/splits";
import { maxPayoutFor } from "../convex/recipients";
import { payoutFee } from "../convex/payouts";

describe("parseSplitInputs", () => {
  test("accepts amount or percent shares", () => {
    expect(parseSplitInputs([{ recipient: "rcp_abc123", amount: 500 }, { recipient_id: "rcp_def456", percent: 12.5 }])).toEqual([
      { recipient: "rcp_abc123", amount: 500, percent: undefined },
      { recipient: "rcp_def456", amount: undefined, percent: 12.5 },
    ]);
    expect(parseSplitInputs(undefined)).toBeUndefined();
    expect(parseSplitInputs([])).toBeUndefined();
  });
  test("rejects malformed input", () => {
    expect(() => parseSplitInputs({})).toThrow(SplitError);
    expect(() => parseSplitInputs([{ recipient: "acct_1", amount: 1 }])).toThrow(/rcp_/);
    expect(() => parseSplitInputs([{ recipient: "rcp_abc123", amount: 1, percent: 2 }])).toThrow(/exactly one/);
    expect(() => parseSplitInputs([{ recipient: "rcp_abc123" }])).toThrow(/exactly one/);
    expect(() => parseSplitInputs([{ recipient: "rcp_abc123", amount: "5" }])).toThrow(/number/);
    expect(() => parseSplitInputs(Array.from({ length: MAX_SPLITS + 1 }, (_, i) => ({ recipient: `rcp_abcde${i}`, amount: 1 })))).toThrow(/at most/);
  });
});

describe("resolveShares", () => {
  test("percentages round down and the remainder stays with the merchant", () => {
    const s = resolveShares([{ recipient: "rcp_a00000", percent: 33.33 }, { recipient: "rcp_b00000", amount: 100 }], 1001, 1000);
    expect(s).toEqual([
      { recipient: "rcp_a00000", amountMinor: 333, percentBps: 3333 },
      { recipient: "rcp_b00000", amountMinor: 100 },
    ]);
  });
  test("refuses shares beyond the merchant's net, duplicates and bad values", () => {
    expect(() => resolveShares([{ recipient: "rcp_a00000", amount: 990 }], 1000, 985)).toThrow(/available after fees/);
    expect(() => resolveShares([{ recipient: "rcp_a00000", amount: 1 }, { recipient: "rcp_a00000", amount: 1 }], 1000, 1000)).toThrow(/more than once/);
    expect(() => resolveShares([{ recipient: "rcp_a00000", percent: 0 }], 1000, 1000)).toThrow(/above 0/);
    expect(() => resolveShares([{ recipient: "rcp_a00000", percent: 100.01 }], 1000, 1000)).toThrow(/at most 100/);
    expect(() => resolveShares([{ recipient: "rcp_a00000", percent: 1.234 }], 1000, 1000)).toThrow(/two decimals/);
    expect(() => resolveShares([{ recipient: "rcp_a00000", percent: 0.01 }], 50, 50)).toThrow(/less than one minor unit/);
    expect(() => resolveShares([{ recipient: "rcp_a00000", amount: 1.5 }], 1000, 1000)).toThrow(/positive integer/);
  });
});

describe("capShares", () => {
  test("allocates in order and reports any shortfall", () => {
    const { shares, shortfallMinor } = capShares([{ amountMinor: 600 }, { amountMinor: 400 }], 900);
    expect(shares.map((s) => s.allocatedMinor)).toEqual([600, 300]);
    expect(shortfallMinor).toBe(100);
    expect(capShares([{ amountMinor: 10 }], 50).shortfallMinor).toBe(0);
  });
});

describe("refundReversals", () => {
  const shares = [{ allocatedMinor: 333 }, { allocatedMinor: 100 }];
  test("partial refunds reverse proportionally and a full refund reverses exactly everything", () => {
    const steps = [[0, 300], [300, 301], [601, 400]] as const;
    const totals = [0, 0];
    for (const [before, amount] of steps) {
      const d = refundReversals(shares, 1001, before, amount);
      d.forEach((x, i) => {
        expect(x).toBeGreaterThanOrEqual(0);
        totals[i] += x;
      });
    }
    expect(totals).toEqual([333, 100]);
  });
  test("a single full refund reverses the whole share", () => {
    expect(refundReversals(shares, 1001, 0, 1001)).toEqual([333, 100]);
  });
  test("over-refund input is clamped to the payment amount", () => {
    expect(refundReversals(shares, 1001, 1001, 50)).toEqual([0, 0]);
  });
});

describe("maxPayoutFor", () => {
  test("the largest amount whose fee still fits the balance", () => {
    for (const bal of [1, 499, 500, 10_000, 1_234_567, 999_999_999]) {
      const a = maxPayoutFor(bal);
      expect(a + payoutFee(a)).toBeLessThanOrEqual(bal);
      expect(a + 1 + payoutFee(a + 1)).toBeGreaterThan(bal);
    }
    expect(maxPayoutFor(0)).toBe(0);
    expect(maxPayoutFor(-500)).toBe(0);
  });
});
