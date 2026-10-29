// Bulk payout file validation (CSV, RFC 4180). Pure and tested.
//
// Required columns: name, bank_name, account_number, currency, amount
// Optional: bank_code, country, account_type (bank_account | mobile_money),
//           narration, reference
// A file is accepted only if every row is valid; otherwise each problem is
// reported with its line number and nothing is created.

import { parseCsv } from "./recon";
import { decimalToMinor, isSupportedCurrency } from "../../lib/money";

export const BULK_MAX_ROWS = 1000;
export const BULK_TEMPLATE =
  "name,bank_name,bank_code,account_number,currency,country,amount,narration,reference,account_type\n" +
  "Okonkwo Logistics,GTBank,058,0123456789,NGN,NG,450000.00,Invoice 1182,INV-1182,bank_account\n" +
  "Wanjiku Supplies,Safaricom M-Pesa,MPESA,254712345678,KES,KE,8500.00,Weekly supplies,WK-44,mobile_money\n";

export interface BulkRow {
  line: number;
  name: string;
  bankName: string;
  bankCode?: string;
  accountNumber: string;
  currency: string;
  country?: string;
  accountType: "bank_account" | "mobile_money";
  amountMinor: number;
  narration?: string;
  reference?: string;
}
export interface BulkParse {
  rows: BulkRow[];
  errors: { line: number; message: string }[];
  totalsByCurrency: Record<string, number>;
}

const REQUIRED = ["name", "bank_name", "account_number", "currency", "amount"] as const;

/** Neutralise spreadsheet formula injection in values echoed back to users. */
const clean = (s: string) => s.replace(/^[=+\-@\t\r]+/, "").trim();

export function parseBulkPayoutCsv(text: string): BulkParse {
  const out: BulkParse = { rows: [], errors: [], totalsByCurrency: {} };
  let table: string[][];
  try {
    table = parseCsv(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    out.errors.push({ line: 1, message: err instanceof Error ? err.message : "The file is not valid CSV." });
    return out;
  }
  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) {
    out.errors.push({ line: 1, message: "The file is empty." });
    return out;
  }
  const header = nonEmpty[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    out.errors.push({ line: 1, message: `Missing column(s): ${missing.join(", ")}. Download the template for the expected layout.` });
    return out;
  }
  const col = (row: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? (row[i] ?? "").trim() : "";
  };
  const body = nonEmpty.slice(1);
  if (body.length === 0) out.errors.push({ line: 2, message: "The file has a header but no payout rows." });
  if (body.length > BULK_MAX_ROWS) {
    out.errors.push({ line: BULK_MAX_ROWS + 2, message: `At most ${BULK_MAX_ROWS} payouts per file. Split it into smaller files.` });
    return out;
  }
  const seen = new Map<string, number>();
  body.forEach((row, i) => {
    const line = i + 2;
    const problems: string[] = [];
    const name = clean(col(row, "name"));
    const bankName = clean(col(row, "bank_name"));
    const bankCode = clean(col(row, "bank_code")) || undefined;
    const accountNumber = col(row, "account_number").replace(/[\s-]+/g, "");
    const currency = col(row, "currency").toUpperCase();
    const country = col(row, "country").toUpperCase() || undefined;
    const typeRaw = col(row, "account_type").toLowerCase() || "bank_account";
    const narration = clean(col(row, "narration")).slice(0, 100) || undefined;
    const reference = clean(col(row, "reference")).slice(0, 64) || undefined;
    if (!name || name.length > 120) problems.push("name is required (up to 120 characters)");
    if (!bankName) problems.push("bank_name is required");
    if (!/^\+?\d{6,34}$/.test(accountNumber)) problems.push("account_number must be 6–34 digits");
    if (!isSupportedCurrency(currency)) problems.push(`currency '${currency || "(blank)"}' is not supported`);
    if (country && !/^[A-Z]{2}$/.test(country)) problems.push("country must be a 2-letter ISO code");
    if (typeRaw !== "bank_account" && typeRaw !== "mobile_money") problems.push("account_type must be bank_account or mobile_money");
    let amountMinor = 0;
    if (isSupportedCurrency(currency)) {
      try {
        amountMinor = decimalToMinor(col(row, "amount").replace(/,/g, ""), currency);
        if (amountMinor <= 0) problems.push("amount must be greater than zero");
      } catch (err) {
        problems.push(err instanceof Error ? err.message : "amount is not a number");
      }
    }
    if (reference) {
      const prev = seen.get(reference);
      if (prev) problems.push(`reference '${reference}' is repeated (also on line ${prev})`);
      else seen.set(reference, line);
    }
    if (problems.length) {
      out.errors.push({ line, message: problems.join("; ") });
      return;
    }
    out.rows.push({ line, name, bankName, bankCode, accountNumber, currency, country, accountType: typeRaw as BulkRow["accountType"], amountMinor, narration, reference });
    out.totalsByCurrency[currency] = (out.totalsByCurrency[currency] ?? 0) + amountMinor;
  });
  return out;
}
