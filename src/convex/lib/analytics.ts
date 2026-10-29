// USOPGRID analytics — pure metric definitions over real records.
//
// Definitions (used identically by the dashboard, reports and exports):
//   attempted            = every payment that reached a provider decision
//   success rate         = SUCCESSFUL-ish ÷ (SUCCESSFUL-ish + DECLINED + FAILED + EXPIRED)
//                          where SUCCESSFUL-ish includes refunded/disputed payments
//                          (they succeeded first). Pending payments are excluded
//                          until they resolve, so the rate never flatters itself.
//   approval rate        = 1 − DECLINED ÷ decided   (issuer view)
//   volume               = per currency, minor units — currencies are NEVER summed
//   cost per success     = provider fees ÷ successful count, per currency
//   failover rate        = payments with ≥1 failover ÷ payments routed

export const SUCCESS_LIKE = new Set(["SUCCESSFUL", "REFUND_PENDING", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED", "REVERSED"]);
export const DECIDED_FAIL = new Set(["DECLINED", "FAILED", "EXPIRED", "CANCELLED"]);

export interface TxnRow {
  status: string;
  amountMinor: number;
  currency: string;
  country?: string;
  paymentMethod: string;
  provider: string;
  createdAt: number;
  feeMinor?: number;
  providerFeeMinor?: number;
  refundedMinor?: number;
  failoverCount?: number;
  attemptCount?: number;
  failureCategory?: string;
  failureCode?: string;
  outcomeUnknown?: boolean;
  merchantId?: string;
}

export interface AttemptRow {
  providerId: string;
  status: string;
  latencyMs: number;
  failureCategory?: string;
  startedAt: number;
  currency: string;
  country?: string;
  paymentMethod: string;
}

export interface Breakdown {
  key: string;
  count: number;
  successful: number;
  failed: number;
  successRate: number | null;
  volumeByCurrency: Record<string, number>;
}

const rate = (num: number, den: number) => (den > 0 ? num / den : null);

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function addVol(m: Record<string, number>, currency: string, amount: number) {
  m[currency] = (m[currency] ?? 0) + amount;
}

export function breakdownBy(rows: TxnRow[], keyOf: (r: TxnRow) => string | undefined): Breakdown[] {
  const map = new Map<string, Breakdown>();
  for (const r of rows) {
    const key = keyOf(r) ?? "unknown";
    let b = map.get(key);
    if (!b) {
      b = { key, count: 0, successful: 0, failed: 0, successRate: null, volumeByCurrency: {} };
      map.set(key, b);
    }
    b.count++;
    if (SUCCESS_LIKE.has(r.status)) {
      b.successful++;
      addVol(b.volumeByCurrency, r.currency, r.amountMinor);
    } else if (DECIDED_FAIL.has(r.status)) b.failed++;
  }
  for (const b of map.values()) b.successRate = rate(b.successful, b.successful + b.failed);
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function dayRange(from: number, to: number): string[] {
  const out: string[] = [];
  const start = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate());
  for (let t = start; t <= to; t += 86_400_000) out.push(utcDay(t));
  return out;
}

export interface Overview {
  window: { from: number; to: number };
  totals: {
    payments: number;
    successful: number;
    declined: number;
    failed: number;
    pending: number;
    outcomeUnknown: number;
    exceptions: number;
    successRate: number | null;
    approvalRate: number | null;
    failoverRate: number | null;
    refundRate: number | null;
  };
  volumeByCurrency: Record<string, number>;
  feesByCurrency: Record<string, number>;
  providerCostByCurrency: Record<string, number>;
  refundedByCurrency: Record<string, number>;
  daily: { day: string; payments: number; successful: number; failed: number; successRate: number | null }[];
  byCountry: Breakdown[];
  byCurrency: Breakdown[];
  byMethod: Breakdown[];
  byProvider: Breakdown[];
  failureReasons: { category: string; code: string; count: number }[];
}

export function computeOverview(rows: TxnRow[], from: number, to: number): Overview {
  let successful = 0, declined = 0, failed = 0, pending = 0, unknown = 0, exceptions = 0, failedOver = 0, routed = 0, refunded = 0;
  const volume: Record<string, number> = {};
  const fees: Record<string, number> = {};
  const providerCost: Record<string, number> = {};
  const refundedBy: Record<string, number> = {};
  const reasons = new Map<string, { category: string; code: string; count: number }>();
  const days = new Map(dayRange(from, to).map((d) => [d, { day: d, payments: 0, successful: 0, failed: 0, successRate: null as number | null }]));

  for (const r of rows) {
    const d = days.get(utcDay(r.createdAt));
    if (d) d.payments++;
    if ((r.attemptCount ?? 0) > 0) routed++;
    if ((r.failoverCount ?? 0) > 0) failedOver++;
    if (r.outcomeUnknown) unknown++;
    if (SUCCESS_LIKE.has(r.status)) {
      successful++;
      if (d) d.successful++;
      addVol(volume, r.currency, r.amountMinor);
      if (r.feeMinor) addVol(fees, r.currency, r.feeMinor);
      if (r.providerFeeMinor) addVol(providerCost, r.currency, r.providerFeeMinor);
      if (r.refundedMinor) {
        refunded++;
        addVol(refundedBy, r.currency, r.refundedMinor);
      }
    } else if (r.status === "DECLINED") {
      declined++;
      if (d) d.failed++;
    } else if (DECIDED_FAIL.has(r.status)) {
      failed++;
      if (d) d.failed++;
    } else if (r.status === "RECONCILIATION_EXCEPTION") {
      exceptions++;
    } else {
      pending++;
    }
    if (r.failureCode && !SUCCESS_LIKE.has(r.status)) {
      const k = `${r.failureCategory}|${r.failureCode}`;
      const e = reasons.get(k) ?? { category: r.failureCategory ?? "unknown", code: r.failureCode, count: 0 };
      e.count++;
      reasons.set(k, e);
    }
  }
  for (const d of days.values()) d.successRate = rate(d.successful, d.successful + d.failed);
  const decided = successful + declined + failed;
  return {
    window: { from, to },
    totals: {
      payments: rows.length,
      successful,
      declined,
      failed,
      pending,
      outcomeUnknown: unknown,
      exceptions,
      successRate: rate(successful, decided),
      approvalRate: decided > 0 ? 1 - declined / decided : null,
      failoverRate: rate(failedOver, routed),
      refundRate: rate(refunded, successful),
    },
    volumeByCurrency: volume,
    feesByCurrency: fees,
    providerCostByCurrency: providerCost,
    refundedByCurrency: refundedBy,
    daily: [...days.values()],
    byCountry: breakdownBy(rows, (r) => r.country),
    byCurrency: breakdownBy(rows, (r) => r.currency),
    byMethod: breakdownBy(rows, (r) => r.paymentMethod),
    byProvider: breakdownBy(rows.filter((r) => r.provider !== "unassigned"), (r) => r.provider),
    failureReasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 12),
  };
}

export interface ProviderPerformance {
  providerId: string;
  attempts: number;
  successful: number;
  declined: number;
  failed: number;
  unknown: number;
  successRate: number | null;
  approvalRate: number | null;
  providerErrorRate: number | null;
  latencyAvgMs: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  rank: number;
}

const PROVIDER_ERRORS = new Set(["provider_outage", "temporary_provider_failure", "timeout", "network_error", "rate_limited", "configuration_error"]);

export function providerPerformance(attempts: AttemptRow[]): ProviderPerformance[] {
  const by = new Map<string, AttemptRow[]>();
  for (const a of attempts) by.set(a.providerId, [...(by.get(a.providerId) ?? []), a]);
  const out: ProviderPerformance[] = [];
  for (const [providerId, rows] of by) {
    const ok = rows.filter((r) => r.status === "successful" || r.status === "pending" || r.status === "requires_action").length;
    const dec = rows.filter((r) => r.status === "declined").length;
    const unk = rows.filter((r) => r.status === "unknown").length;
    const fail = rows.filter((r) => r.status === "failed").length;
    const provErr = rows.filter((r) => r.status === "unknown" || (r.status === "failed" && PROVIDER_ERRORS.has(r.failureCategory ?? ""))).length;
    const lat = rows.map((r) => r.latencyMs);
    out.push({
      providerId,
      attempts: rows.length,
      successful: ok,
      declined: dec,
      failed: fail,
      unknown: unk,
      successRate: rate(ok, rows.length),
      approvalRate: rate(ok, ok + dec),
      providerErrorRate: rate(provErr, rows.length),
      latencyAvgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      latencyP50Ms: percentile(lat, 50),
      latencyP95Ms: percentile(lat, 95),
      rank: 0,
    });
  }
  // Rank: success rate first, then provider-error rate, then p95 latency.
  out.sort(
    (a, b) =>
      (b.successRate ?? 0) - (a.successRate ?? 0) ||
      (a.providerErrorRate ?? 1) - (b.providerErrorRate ?? 1) ||
      (a.latencyP95Ms ?? Infinity) - (b.latencyP95Ms ?? Infinity),
  );
  out.forEach((p, i) => (p.rank = i + 1));
  return out;
}

/** z-score of the last point against the preceding window. Null when there is too little history. */
export function anomalyScore(series: number[], minHistory = 5): { z: number; mean: number; std: number } | null {
  if (series.length < minHistory + 1) return null;
  const hist = series.slice(0, -1);
  const last = series[series.length - 1];
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const variance = hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length;
  const std = Math.sqrt(variance);
  // Floor the deviation so a perfectly flat history doesn't make any blip "infinite".
  const z = (last - mean) / Math.max(std, Math.abs(mean) * 0.05, 1e-9);
  return { z, mean, std };
}

/** Ordinary least-squares trend forecast, floored at zero. */
export function linearForecast(series: number[], horizon: number): number[] {
  const n = series.length;
  if (n === 0) return Array(horizon).fill(0);
  if (n === 1) return Array(horizon).fill(Math.max(0, series[0]));
  const xs = series.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = series.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (series[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  return Array.from({ length: horizon }, (_, h) => Math.max(0, Math.round((intercept + slope * (n + h)) * 100) / 100));
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  // Neutralize spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}
