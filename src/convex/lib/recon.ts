// USOPGRID provider settlement-report reconciliation — pure.
//
// Parse a provider's settlement / balance report (CSV), normalize it to
// minor units, and match it line by line against USOPGRID's own records by
// provider reference. Every discrepancy becomes a typed exception that
// finance resolves through an audited workflow; nothing is auto-corrected.

import { decimalToMinor, isSupportedCurrency } from "../../lib/money";

export interface ReportRow {
  line: number;
  providerReference: string;
  amountMinor: number;
  currency: string;
  feeMinor?: number;
  status?: string;
}

export interface ExpectedRow {
  transactionId: string;
  providerReference?: string;
  amountMinor: number;
  currency: string;
  providerFeeMinor?: number;
  status: string;
}

export type ReconExceptionType =
  | "duplicate"
  | "missing_in_usopgrid"
  | "missing_in_provider_report"
  | "amount_mismatch"
  | "currency_mismatch"
  | "fee_discrepancy"
  | "status_mismatch";

export interface ReconFinding {
  type: ReconExceptionType;
  severity: "low" | "medium" | "high";
  providerReference?: string;
  transactionId?: string;
  detail: string;
  expectedAmountMinor?: number;
  reportedAmountMinor?: number;
  currency?: string;
}

export interface ReconResult {
  matched: number;
  findings: ReconFinding[];
  totals: Record<string, { reportedMinor: number; expectedMinor: number; feeReportedMinor: number; feeExpectedMinor: number }>;
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quoted fields, escaped quotes, CRLF)
// ---------------------------------------------------------------------------
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const COLS = {
  reference: ["provider_reference", "reference", "id", "charge_id", "payment_intent", "psp_reference", "pspreference", "transaction_id", "tx_ref", "flw_ref", "source_id"],
  amount: ["amount", "gross", "gross_amount", "amount_minor", "captured", "value"],
  currency: ["currency", "ccy", "currency_code"],
  fee: ["fee", "fees", "commission", "processing_fee", "fee_amount"],
  status: ["status", "type", "record_type", "reporting_category"],
};

function findCol(header: string[], names: string[]): number {
  const h = header.map((x) => x.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse a settlement report. `amountsIn` says whether amount/fee columns are
 * decimal major units ("12.50") or integer minor units ("1250").
 */
export function parseSettlementReport(
  csv: string,
  opts: { amountsIn: "major" | "minor"; defaultCurrency?: string },
): { rows: ReportRow[]; errors: string[] } {
  const table = parseCsv(csv);
  if (table.length < 2) return { rows: [], errors: ["report has no data rows"] };
  const [header, ...data] = table;
  const ci = {
    ref: findCol(header, COLS.reference),
    amt: findCol(header, COLS.amount),
    cur: findCol(header, COLS.currency),
    fee: findCol(header, COLS.fee),
    st: findCol(header, COLS.status),
  };
  const errors: string[] = [];
  if (ci.ref < 0) errors.push(`no reference column (expected one of: ${COLS.reference.join(", ")})`);
  if (ci.amt < 0) errors.push(`no amount column (expected one of: ${COLS.amount.join(", ")})`);
  if (ci.cur < 0 && !opts.defaultCurrency) errors.push("no currency column and no default currency given");
  if (errors.length) return { rows: [], errors };

  const rows: ReportRow[] = [];
  data.forEach((r, idx) => {
    const line = idx + 2;
    const currency = (ci.cur >= 0 ? r[ci.cur] : opts.defaultCurrency ?? "").trim().toUpperCase();
    const ref = (r[ci.ref] ?? "").trim();
    if (!ref) return errors.push(`line ${line}: empty reference`), undefined;
    if (!isSupportedCurrency(currency)) return errors.push(`line ${line}: unsupported currency '${currency}'`), undefined;
    const toMinor = (raw: string | undefined): number | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      const clean = raw.trim().replace(/[,\s]/g, "");
      if (opts.amountsIn === "minor") {
        if (!/^-?\d+$/.test(clean)) throw new RangeError(`'${raw}' is not an integer minor-unit amount`);
        return Number(clean);
      }
      return decimalToMinor(clean, currency);
    };
    try {
      const amountMinor = toMinor(r[ci.amt]);
      if (amountMinor === undefined) throw new RangeError("missing amount");
      rows.push({
        line,
        providerReference: ref,
        amountMinor: Math.abs(amountMinor),
        currency,
        feeMinor: ci.fee >= 0 ? (toMinor(r[ci.fee]) !== undefined ? Math.abs(toMinor(r[ci.fee])!) : undefined) : undefined,
        status: ci.st >= 0 ? r[ci.st]?.trim().toLowerCase() : undefined,
      });
    } catch (err) {
      errors.push(`line ${line}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { rows, errors };
}

const REPORT_REVERSAL = /refund|reversal|chargeback|dispute|failed|declined|void/;

export function reconcile(report: ReportRow[], expected: ExpectedRow[], opts: { feeToleranceMinor?: number } = {}): ReconResult {
  const tol = opts.feeToleranceMinor ?? 0;
  const findings: ReconFinding[] = [];
  const totals: ReconResult["totals"] = {};
  const tot = (c: string) => (totals[c] ??= { reportedMinor: 0, expectedMinor: 0, feeReportedMinor: 0, feeExpectedMinor: 0 });

  const byRef = new Map<string, ExpectedRow>();
  for (const e of expected) if (e.providerReference) byRef.set(e.providerReference, e);

  const seen = new Map<string, number>();
  let matched = 0;
  for (const r of report) {
    // Charges only; refund/chargeback lines reconcile against refunds/disputes.
    if (r.status && REPORT_REVERSAL.test(r.status)) {
      const e = byRef.get(r.providerReference);
      if (e && /refund/.test(r.status) && !/REFUND/.test(e.status)) {
        findings.push({ type: "status_mismatch", severity: "medium", providerReference: r.providerReference, transactionId: e.transactionId, detail: `Provider shows '${r.status}' but USOPGRID status is ${e.status}.`, currency: r.currency });
      }
      continue;
    }
    tot(r.currency).reportedMinor += r.amountMinor;
    if (r.feeMinor !== undefined) tot(r.currency).feeReportedMinor += r.feeMinor;

    const prev = seen.get(r.providerReference);
    if (prev !== undefined) {
      findings.push({ type: "duplicate", severity: "high", providerReference: r.providerReference, detail: `Reference appears on lines ${prev} and ${r.line}.`, reportedAmountMinor: r.amountMinor, currency: r.currency });
      continue;
    }
    seen.set(r.providerReference, r.line);

    const e = byRef.get(r.providerReference);
    if (!e) {
      findings.push({ type: "missing_in_usopgrid", severity: "high", providerReference: r.providerReference, detail: `Provider settled ${r.amountMinor} ${r.currency} (line ${r.line}) with no matching USOPGRID payment.`, reportedAmountMinor: r.amountMinor, currency: r.currency });
      continue;
    }
    if (e.currency !== r.currency) {
      findings.push({ type: "currency_mismatch", severity: "high", providerReference: r.providerReference, transactionId: e.transactionId, detail: `Expected ${e.currency}, provider reported ${r.currency}.`, expectedAmountMinor: e.amountMinor, reportedAmountMinor: r.amountMinor, currency: r.currency });
      continue;
    }
    if (e.amountMinor !== r.amountMinor) {
      findings.push({ type: "amount_mismatch", severity: "high", providerReference: r.providerReference, transactionId: e.transactionId, detail: `Expected ${e.amountMinor}, provider reported ${r.amountMinor} ${r.currency} (Δ ${r.amountMinor - e.amountMinor}).`, expectedAmountMinor: e.amountMinor, reportedAmountMinor: r.amountMinor, currency: r.currency });
      continue;
    }
    if (r.feeMinor !== undefined && e.providerFeeMinor !== undefined && Math.abs(r.feeMinor - e.providerFeeMinor) > tol) {
      findings.push({ type: "fee_discrepancy", severity: "low", providerReference: r.providerReference, transactionId: e.transactionId, detail: `Provider fee ${r.feeMinor} vs expected ${e.providerFeeMinor} ${r.currency}.`, expectedAmountMinor: e.providerFeeMinor, reportedAmountMinor: r.feeMinor, currency: r.currency });
    }
    if (!["SUCCESSFUL", "PARTIALLY_REFUNDED", "REFUNDED", "REFUND_PENDING", "DISPUTED", "REVERSED"].includes(e.status)) {
      findings.push({ type: "status_mismatch", severity: "high", providerReference: r.providerReference, transactionId: e.transactionId, detail: `Provider settled funds but USOPGRID status is ${e.status}.`, reportedAmountMinor: r.amountMinor, currency: r.currency });
    }
    matched++;
  }

  for (const e of expected) {
    if (!["SUCCESSFUL", "PARTIALLY_REFUNDED", "REFUNDED", "REFUND_PENDING"].includes(e.status)) continue;
    tot(e.currency).expectedMinor += e.amountMinor;
    if (e.providerFeeMinor !== undefined) tot(e.currency).feeExpectedMinor += e.providerFeeMinor;
    if (!e.providerReference || !seen.has(e.providerReference)) {
      findings.push({ type: "missing_in_provider_report", severity: "medium", providerReference: e.providerReference, transactionId: e.transactionId, detail: `Successful payment ${e.transactionId} is not in the provider report.`, expectedAmountMinor: e.amountMinor, currency: e.currency });
    }
  }
  return { matched, findings, totals };
}
