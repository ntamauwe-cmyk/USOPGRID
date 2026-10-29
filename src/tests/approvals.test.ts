import { describe, expect, test } from "bun:test";
import { bulkNeedsApproval, isLoosening, payoutNeedsApproval, validatePolicy } from "../convex/lib/approvals";
import { parseBulkPayoutCsv, BULK_TEMPLATE } from "../convex/lib/bulk";

describe("two-person approval policy", () => {
  test("off / all / above-threshold", () => {
    expect(payoutNeedsApproval(undefined, 10_000_000)).toBe(false);
    expect(payoutNeedsApproval({ payouts: "all" }, 1)).toBe(true);
    const p = { payouts: "above" as const, payoutThresholdUsd: 10_000 };
    expect(payoutNeedsApproval(p, 999_999)).toBe(false);
    expect(payoutNeedsApproval(p, 1_000_000)).toBe(true);
  });
  test("unknown USD value fails safe (needs approval)", () => {
    expect(payoutNeedsApproval({ payouts: "above", payoutThresholdUsd: 10_000 }, null)).toBe(true);
  });
  test("weakening the control is detected; tightening is not", () => {
    const off = { payouts: "off" as const }, all = { payouts: "all" as const };
    const a10k = { payouts: "above" as const, payoutThresholdUsd: 10_000 }, a50k = { payouts: "above" as const, payoutThresholdUsd: 50_000 };
    expect(isLoosening(all, off)).toBe(true);
    expect(isLoosening(all, a10k)).toBe(true);
    expect(isLoosening(a10k, a50k)).toBe(true);
    expect(isLoosening(a50k, a10k)).toBe(false);
    expect(isLoosening(off, all)).toBe(false);
    expect(isLoosening(undefined, a10k)).toBe(false);
    expect(bulkNeedsApproval(a10k)).toBe(true);
    expect(bulkNeedsApproval(off)).toBe(false);
  });
  test("threshold must be positive", () => {
    expect(validatePolicy({ payouts: "above", payoutThresholdUsd: 0 })).not.toBeNull();
    expect(validatePolicy({ payouts: "above", payoutThresholdUsd: 500 })).toBeNull();
  });
});

describe("bulk payout files", () => {
  test("the published template is valid", () => {
    const r = parseBulkPayoutCsv(BULK_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.rows.length).toBe(2);
    expect(r.totalsByCurrency).toEqual({ NGN: 45_000_000, KES: 850_000 });
  });
  test("every problem is reported with its line; nothing passes when one row is bad", () => {
    const csv = "name,bank_name,account_number,currency,amount,reference\n" +
      "A Ltd,GTBank,0123456789,NGN,100.00,R1\n" +
      ",GTBank,12,XXX,abc,R1\n" +
      "B Ltd,Access,0987654321,JPY,10.5,R3\n";
    const r = parseBulkPayoutCsv(csv);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(r.errors[0].message).toMatch(/name is required/);
    expect(r.errors[0].message).toMatch(/account_number/);
    expect(r.errors[0].message).toMatch(/repeated/);
    expect(r.errors[1].message).toMatch(/precision/);
  });
  test("missing columns and formula injection are handled", () => {
    expect(parseBulkPayoutCsv("name,amount\nA,1").errors[0].message).toMatch(/Missing column/);
    const r = parseBulkPayoutCsv('name,bank_name,account_number,currency,amount\n"=HYPERLINK(1)",GTBank,0123456789,NGN,"1,250.50"\n');
    expect(r.errors).toEqual([]);
    expect(r.rows[0].name.startsWith("=")).toBe(false);
    expect(r.rows[0].amountMinor).toBe(125_050);
  });
});
