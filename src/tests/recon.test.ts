import { describe, expect, test } from "bun:test";
import { parseCsv, parseSettlementReport, reconcile, type ExpectedRow } from "../convex/lib/recon";

describe("settlement report parsing", () => {
  test("RFC 4180 quoting", () => {
    expect(parseCsv('a,b\r\n"x, ""y""",2\n')).toEqual([["a", "b"], ['x, "y"', "2"]]);
  });
  test("major-unit amounts are converted exactly per currency", () => {
    const { rows, errors } = parseSettlementReport("id,amount,currency,fee\npi_1,12.50,USD,0.66\nch_2,1500,JPY,45\nk_3,1.234,KWD,", { amountsIn: "major" });
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.amountMinor, r.feeMinor])).toEqual([[1250, 66], [1500, 45], [1234, undefined]]);
  });
  test("bad rows are reported, not guessed", () => {
    const { rows, errors } = parseSettlementReport("id,amount,currency\npi_1,12.505,USD\n,1,USD\npi_3,1,ZZZ", { amountsIn: "major" });
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(3);
  });
});

describe("reconcile", () => {
  const expected: ExpectedRow[] = [
    { transactionId: "t1", providerReference: "p1", amountMinor: 1000, currency: "USD", providerFeeMinor: 59, status: "SUCCESSFUL" },
    { transactionId: "t2", providerReference: "p2", amountMinor: 2000, currency: "USD", status: "SUCCESSFUL" },
    { transactionId: "t3", providerReference: "p3", amountMinor: 3000, currency: "USD", status: "SUCCESSFUL" },
    { transactionId: "t4", providerReference: "p4", amountMinor: 4000, currency: "USD", status: "FAILED" },
  ];
  test("finds every discrepancy class", () => {
    const report = [
      { line: 2, providerReference: "p1", amountMinor: 1000, currency: "USD", feeMinor: 60 },
      { line: 3, providerReference: "p2", amountMinor: 1999, currency: "USD" },
      { line: 4, providerReference: "p2", amountMinor: 1999, currency: "USD" },
      { line: 5, providerReference: "zz", amountMinor: 777, currency: "USD" },
      { line: 6, providerReference: "p4", amountMinor: 4000, currency: "USD" },
    ];
    const r = reconcile(report, expected);
    const types = r.findings.map((f) => f.type).sort();
    expect(types).toEqual(["amount_mismatch", "duplicate", "fee_discrepancy", "missing_in_provider_report", "missing_in_usopgrid", "status_mismatch"].sort());
    expect(r.matched).toBe(2);
    expect(r.totals.USD.expectedMinor).toBe(6000);
  });
  test("clean report reconciles fully", () => {
    const r = reconcile(
      [
        { line: 2, providerReference: "p1", amountMinor: 1000, currency: "USD", feeMinor: 59 },
        { line: 3, providerReference: "p2", amountMinor: 2000, currency: "USD" },
        { line: 4, providerReference: "p3", amountMinor: 3000, currency: "USD" },
        { line: 5, providerReference: "p1", amountMinor: 1000, currency: "USD", status: "refund" },
      ],
      expected.slice(0, 3),
    );
    expect(r.matched).toBe(3);
    expect(r.findings.filter((f) => f.type !== "status_mismatch")).toEqual([]);
  });
});
