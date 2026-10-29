// USOPGRID — currency + money primitives.
// Money is ALWAYS integer minor units (cents, kobo, fils…). Never floats in
// financial math. Conversions to/from provider "major unit" decimals go
// through exact string arithmetic below.

import { CURRENCIES, getCurrency, type CurrencyInfo } from "./geo";

export type { CurrencyInfo };
export { CURRENCIES };

/** True for any active ISO 4217 currency (155 codes). */
export function isSupportedCurrency(code: string): boolean {
  return getCurrency(code)?.active === true;
}

export function currencyDecimals(code: string): number {
  return getCurrency(code)?.decimals ?? 2;
}

function currencySymbol(code: string): string {
  return getCurrency(code)?.symbol ?? `${code} `;
}

// ---------------------------------------------------------------------------
// Exact conversions — used by provider adapters that speak major units.
// ---------------------------------------------------------------------------

/**
 * Minor units → canonical decimal string. 125050 USD → "1250.50";
 * 1500 JPY → "1500"; 1234 KWD → "1.234". Exact for any safe integer.
 */
export function minorToDecimalString(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("amountMinor must be a safe integer");
  const decimals = currencyDecimals(currency);
  const negative = amountMinor < 0;
  const digits = Math.abs(amountMinor).toString();
  if (decimals === 0) return (negative ? "-" : "") + digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Decimal string or number (as returned by a provider) → minor units.
 * Rejects values with more precision than the currency allows instead of
 * silently rounding — a provider reporting 10.005 USD is a data error.
 */
export function decimalToMinor(value: string | number, currency: string): number {
  const decimals = currencyDecimals(currency);
  const s = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`not a decimal amount: '${value}'`);
  const [, neg, whole, fracRaw = ""] = m;
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > decimals) {
    throw new RangeError(`amount '${value}' has more precision than ${currency} allows (${decimals} decimals)`);
  }
  const minor = Number(whole + frac.padEnd(decimals, "0"));
  if (!Number.isSafeInteger(minor)) throw new RangeError("amount exceeds safe integer range");
  return neg ? -minor : minor;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError("amount must be finite");
  // toPrecision(15) then strip exponent/trailing noise for typical JSON numbers.
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/\.?0+$/, "");
}

/** Convert between currencies' minor units when only exponents differ (e.g. fee normalization). */
export function rescaleMinor(amountMinor: number, fromCurrency: string, toCurrency: string): number {
  const diff = currencyDecimals(toCurrency) - currencyDecimals(fromCurrency);
  if (diff === 0) return amountMinor;
  if (diff > 0) return amountMinor * 10 ** diff;
  return roundHalfEven(amountMinor, 10 ** -diff);
}

/** Integer division with banker's rounding — avoids systematic bias in aggregate rounding. */
export function roundHalfEven(numerator: number, denominator: number): number {
  const q = Math.trunc(numerator / denominator);
  const r = numerator - q * denominator;
  const twice = Math.abs(r) * 2;
  if (twice < denominator) return q;
  if (twice > denominator) return q + Math.sign(numerator);
  return q % 2 === 0 ? q : q + Math.sign(numerator);
}

// ---------------------------------------------------------------------------
// Display formatting (UI only — never feed these back into calculations)
// ---------------------------------------------------------------------------

/** Format minor units into a display string, e.g. 125000 NGN -> "₦1,250.00". */
export function formatMoney(amountMinor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const [whole, frac] = minorToDecimalString(Math.abs(Math.trunc(amountMinor)), currency).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = amountMinor < 0 ? "-" : "";
  return `${sign}${currencySymbol(currency)}${grouped}${decimals > 0 ? `.${frac}` : ""}`;
}

/** Signed variant for ledger-style tables (credits positive, debits negative). */
export function formatMoneySigned(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "−" : "+";
  return `${sign} ${formatMoney(Math.abs(amountMinor), currency)}`;
}

/** "₦1,250.00 NGN" — display amount with explicit ISO code for tables. */
export function formatMoneyWithCode(amountMinor: number, currency: string): string {
  return `${formatMoney(amountMinor, currency)} ${currency}`;
}

/** Compact axis label for charts: 1_250_000 kobo -> "₦12.5k" */
export function formatMoneyCompact(amountMinor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const value = amountMinor / 10 ** decimals; // display only
  const symbol = currencySymbol(currency);
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${symbol}${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${symbol}${(value / 1_000).toFixed(1)}k`;
  return `${symbol}${value.toFixed(0)}`;
}
