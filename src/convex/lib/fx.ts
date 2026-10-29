// USOPGRID FX engine — exact currency conversion, spreads and expiring quotes.
//
// Rates are carried as decimal STRINGS and converted with BigInt rational
// arithmetic, so conversion is exact and deterministic: no float drift between
// the quote shown to a customer and the amount that is booked.
//
// Rate sources are pluggable (see FX_SOURCES). USOPGRID never fabricates a
// rate: if no source answers, quoting fails loudly.

import { currencyDecimals, isSupportedCurrency } from "../../lib/money";

export interface Rational {
  num: bigint;
  den: bigint;
}

/** Parse "1543.2187" → 15432187/10000. Rejects anything that is not a plain positive decimal. */
export function parseRate(rate: string | number): Rational {
  const s = typeof rate === "number" ? rate.toPrecision(15) : rate.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) throw new RangeError(`invalid FX rate '${rate}'`);
  const [, whole, frac = "", expRaw] = m;
  let num = BigInt(whole + frac);
  let den = 10n ** BigInt(frac.length);
  const exp = expRaw ? Number(expRaw) : 0;
  if (exp > 0) num *= 10n ** BigInt(exp);
  if (exp < 0) den *= 10n ** BigInt(-exp);
  if (num === 0n) throw new RangeError("FX rate must be positive");
  return reduce({ num, den });
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

function reduce(r: Rational): Rational {
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

export function invert(r: Rational): Rational {
  return { num: r.den, den: r.num };
}

export function multiply(a: Rational, b: Rational): Rational {
  return reduce({ num: a.num * b.num, den: a.den * b.den });
}

/** Render a rational as a fixed-precision decimal string (half-even). */
export function rationalToString(r: Rational, places = 10): string {
  const scaled = divRoundHalfEven(r.num * 10n ** BigInt(places), r.den);
  const s = scaled.toString().padStart(places + 1, "0");
  const out = `${s.slice(0, -places)}.${s.slice(-places)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

function divRoundHalfEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  const twice = 2n * (r < 0n ? -r : r);
  if (twice < d) return q;
  if (twice > d) return q + (n < 0n ? -1n : 1n);
  return q % 2n === 0n ? q : q + (n < 0n ? -1n : 1n);
}

/**
 * Convert `amountMinor` of `from` into minor units of `to` at `rate`
 * (units of `to` per 1 unit of `from`). Half-even rounding at the very end.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rate: Rational): number {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("amountMinor must be a safe integer");
  const scaleExp = currencyDecimals(to) - currencyDecimals(from);
  let num = BigInt(amountMinor) * rate.num;
  let den = rate.den;
  if (scaleExp > 0) num *= 10n ** BigInt(scaleExp);
  if (scaleExp < 0) den *= 10n ** BigInt(-scaleExp);
  const out = divRoundHalfEven(num, den);
  const n = Number(out);
  if (!Number.isSafeInteger(n)) throw new RangeError("converted amount exceeds safe integer range");
  return n;
}

/** Apply a spread (basis points) against the customer: the rate gets worse by `bps`. */
export function applySpread(mid: Rational, spreadBps: number): Rational {
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) {
    throw new RangeError("spreadBps must be an integer in [0, 10000)");
  }
  return reduce({ num: mid.num * BigInt(10_000 - spreadBps), den: mid.den * 10_000n });
}

export interface FxQuote {
  from: string;
  to: string;
  /** Mid-market rate from the source, decimal string. */
  midRate: string;
  /** Customer rate after spread, decimal string. */
  rate: string;
  spreadBps: number;
  sourceAmountMinor: number;
  targetAmountMinor: number;
  /** What the spread is worth, in target minor units (FX revenue / cost). */
  spreadCostMinor: number;
  source: string;
  sourceTimestamp: number;
  createdAt: number;
  expiresAt: number;
}

export function buildQuote(params: {
  from: string;
  to: string;
  amountMinor: number;
  midRate: string;
  spreadBps: number;
  source: string;
  sourceTimestamp: number;
  now: number;
  ttlMs: number;
}): FxQuote {
  const { from, to, amountMinor } = params;
  if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) {
    throw new RangeError(`unsupported currency pair ${from}/${to}`);
  }
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new RangeError("amount must be a positive integer");
  const mid = from === to ? { num: 1n, den: 1n } : parseRate(params.midRate);
  const customer = from === to ? mid : applySpread(mid, params.spreadBps);
  const atMid = convertMinor(amountMinor, from, to, mid);
  const target = convertMinor(amountMinor, from, to, customer);
  return {
    from,
    to,
    midRate: rationalToString(mid),
    rate: rationalToString(customer),
    spreadBps: from === to ? 0 : params.spreadBps,
    sourceAmountMinor: amountMinor,
    targetAmountMinor: target,
    spreadCostMinor: atMid - target,
    source: params.source,
    sourceTimestamp: params.sourceTimestamp,
    createdAt: params.now,
    expiresAt: params.now + params.ttlMs,
  };
}

export function isQuoteValid(q: Pick<FxQuote, "expiresAt">, now: number): boolean {
  return now < q.expiresAt;
}

/** Derive a cross rate through a common base: rate(A→B) = rate(base→B) / rate(base→A). */
export function crossRate(baseToFrom: string, baseToTo: string): Rational {
  return multiply(invert(parseRate(baseToFrom)), parseRate(baseToTo));
}

// ---------------------------------------------------------------------------
// Rate sources. Each returns base-relative rates; cross rates are derived.
// ---------------------------------------------------------------------------
export interface RateSnapshot {
  base: string;
  rates: Record<string, string>;
  source: string;
  timestamp: number;
}

export interface FxSource {
  id: string;
  /** Documented coverage; used to pick a source per pair. */
  description: string;
  fetchRates(base: string, fetchImpl: typeof fetch): Promise<RateSnapshot>;
}

/** European Central Bank reference rates via Frankfurter — free, ~30 majors, daily. */
export const frankfurterSource: FxSource = {
  id: "ecb_frankfurter",
  description: "ECB reference rates (≈30 major currencies), published each TARGET business day",
  async fetchRates(base, fetchImpl) {
    const res = await fetchImpl(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}`);
    if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
    const j = (await res.json()) as { base: string; date: string; rates: Record<string, number> };
    return {
      base: j.base,
      rates: Object.fromEntries(Object.entries(j.rates).map(([k, val]) => [k, String(val)])),
      source: "ecb_frankfurter",
      timestamp: Date.parse(`${j.date}T16:00:00Z`),
    };
  },
};

/** open.er-api.com — free tier, ~160 currencies incl. frontier markets, updated daily. */
export const openErApiSource: FxSource = {
  id: "open_er_api",
  description: "ExchangeRate-API open endpoint (≈160 currencies), daily",
  async fetchRates(base, fetchImpl) {
    const res = await fetchImpl(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
    if (!res.ok) throw new Error(`open.er-api HTTP ${res.status}`);
    const j = (await res.json()) as { result: string; base_code: string; time_last_update_unix: number; rates: Record<string, number> };
    if (j.result !== "success") throw new Error("open.er-api returned an error result");
    return {
      base: j.base_code,
      rates: Object.fromEntries(Object.entries(j.rates).map(([k, val]) => [k, String(val)])),
      source: "open_er_api",
      timestamp: j.time_last_update_unix * 1000,
    };
  },
};

/** Premium source slot (e.g. a bank or a licensed FX API) — enabled when FX_RATE_PROVIDER_URL/KEY are set. */
export function configuredPremiumSource(url?: string, key?: string): FxSource | null {
  if (!url || !key) return null;
  return {
    id: "premium",
    description: "Operator-configured FX provider",
    async fetchRates(base, fetchImpl) {
      const res = await fetchImpl(`${url.replace(/\/$/, "")}/latest?base=${encodeURIComponent(base)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`premium FX HTTP ${res.status}`);
      const j = (await res.json()) as { base: string; timestamp?: number; rates: Record<string, number | string> };
      return {
        base: j.base,
        rates: Object.fromEntries(Object.entries(j.rates).map(([k, val]) => [k, String(val)])),
        source: "premium",
        timestamp: j.timestamp ? j.timestamp * 1000 : Date.now(),
      };
    },
  };
}

export const FX_SOURCES: FxSource[] = [frankfurterSource, openErApiSource];

/** Max age before a rate snapshot is considered stale for quoting. */
export const FX_MAX_SOURCE_AGE_MS = 36 * 3_600_000;

// ---------------------------------------------------------------------------
// Snapshot helpers — a snapshot holds base→X rates; any pair is a cross rate.
// ---------------------------------------------------------------------------
export function baseRate(snap: Pick<RateSnapshot, "base" | "rates">, code: string): string | undefined {
  if (code === snap.base) return "1";
  return snap.rates[code];
}

/** Mid rate from→to as a decimal string, or undefined when the snapshot lacks either side. */
export function pairRate(snap: Pick<RateSnapshot, "base" | "rates">, from: string, to: string): string | undefined {
  if (from === to) return "1";
  const a = baseRate(snap, from);
  const b = baseRate(snap, to);
  if (!a || !b) return undefined;
  return rationalToString(crossRate(a, b), 12);
}

/** Convert at mid-market (no spread). Used for analytics and risk normalization, never for charging. */
export function convertAtMid(snap: Pick<RateSnapshot, "base" | "rates">, amountMinor: number, from: string, to: string): number | undefined {
  const r = pairRate(snap, from, to);
  return r === undefined ? undefined : convertMinor(amountMinor, from, to, parseRate(r));
}

export function isSnapshotFresh(snap: Pick<RateSnapshot, "timestamp">, now: number): boolean {
  return now - snap.timestamp <= FX_MAX_SOURCE_AGE_MS;
}

/** Merge snapshots that share a base; earlier sources win per currency (put the most authoritative first). */
export function mergeSnapshots(snaps: RateSnapshot[]): RateSnapshot | null {
  const usable = snaps.filter((s) => s && Object.keys(s.rates).length > 0);
  if (usable.length === 0) return null;
  const base = usable[0].base;
  const rates: Record<string, string> = {};
  for (const s of usable) {
    if (s.base !== base) continue;
    for (const [k, val] of Object.entries(s.rates)) if (!(k in rates)) rates[k] = val;
  }
  return {
    base,
    rates,
    source: usable.filter((s) => s.base === base).map((s) => s.source).join("+"),
    timestamp: Math.min(...usable.filter((s) => s.base === base).map((s) => s.timestamp)),
  };
}
