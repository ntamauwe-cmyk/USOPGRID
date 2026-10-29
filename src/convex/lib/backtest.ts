// Routing policy backtest and provider scorecard statistics. Pure and tested.
//
// Method (shown to users verbatim in the product):
// - Each historical payment is routed again under the current and the
//   proposed policy, assuming every provider was available (circuits closed).
// - Outcomes compare FIRST-ATTEMPT success, so failover recovery does not
//   flatter either policy.
// - Where the proposed policy picks the provider that actually handled the
//   payment, the OBSERVED outcome and latency are used.
// - Otherwise the outcome is ESTIMATED from that provider's first-attempt
//   success rate for the same payment method and currency in the window
//   (falling back to the provider overall), Bayesian-smoothed toward 85% with
//   weight 20 so tiny samples cannot dominate. Estimates resting on fewer
//   than MIN_SAMPLE attempts are counted as low confidence.
// - Cost uses each connection's agreed pricing (or list pricing).

import { estimateFeeMinor, route, smoothedSuccessRate, type Candidate, type ProviderStats, type RoutingRule, type RoutingStrategy } from "../orchestration/router";

export const MIN_SAMPLE = 30;

/** Wilson score interval (95% by default) for a success proportion. */
export function wilson(successes: number, n: number, z = 1.96): { rate: number | null; low: number | null; high: number | null } {
  if (n <= 0) return { rate: null, low: null, high: null };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export interface HistoricalPayment {
  amountMinor: number;
  currency: string;
  method: string;
  country?: string;
  riskScore?: number;
  /** First attempt as it actually happened. */
  first: { providerId: string; connectionId: string; success: boolean; latencyMs: number };
}

export interface SegmentStat {
  attempts: number;
  successes: number;
  latencySum: number;
}

export function segmentKey(providerId: string, method?: string, currency?: string) {
  return `${providerId}|${method ?? "*"}|${currency ?? "*"}`;
}

/** First-attempt statistics per provider, per (provider, method, currency). */
export function buildSegments(history: HistoricalPayment[]): Map<string, SegmentStat> {
  const m = new Map<string, SegmentStat>();
  const add = (k: string, h: HistoricalPayment) => {
    const s = m.get(k) ?? { attempts: 0, successes: 0, latencySum: 0 };
    s.attempts++;
    if (h.first.success) s.successes++;
    s.latencySum += h.first.latencyMs;
    m.set(k, s);
  };
  for (const h of history) {
    add(segmentKey(h.first.providerId), h);
    add(segmentKey(h.first.providerId, h.method, h.currency), h);
  }
  return m;
}

export interface Policy {
  rules: RoutingRule[];
  strategy?: RoutingStrategy;
}

export interface PolicyResult {
  payments: number;
  expectedSuccesses: number;
  successRate: number | null;
  /** Payments whose result was observed vs estimated. */
  observed: number;
  estimated: number;
  lowConfidence: number;
  avgLatencyMs: number | null;
  /** Estimated provider fees for expected successes, per currency (minor units). */
  feesByCurrency: Record<string, number>;
  costPerSuccessByCurrency: Record<string, number | null>;
  share: Record<string, number>;
  unroutable: number;
}

function emptyResult(): PolicyResult {
  return { payments: 0, expectedSuccesses: 0, successRate: null, observed: 0, estimated: 0, lowConfidence: 0, avgLatencyMs: null, feesByCurrency: {}, costPerSuccessByCurrency: {}, share: {}, unroutable: 0 };
}

export function evaluatePolicy(
  history: HistoricalPayment[],
  candidates: Candidate[],
  routingStats: Record<string, ProviderStats>,
  segments: Map<string, SegmentStat>,
  policy: Policy,
): { result: PolicyResult; choices: (string | null)[] } {
  const r = emptyResult();
  let latencySum = 0;
  let latencyN = 0;
  const choices: (string | null)[] = [];
  for (const h of history) {
    r.payments++;
    const d = route({
      request: { amountMinor: h.amountMinor, currency: h.currency, method: h.method, country: h.country, riskScore: h.riskScore },
      candidates,
      stats: routingStats,
      circuits: {},
      rules: policy.rules,
      strategy: policy.strategy,
      now: 0,
    });
    const step = d.chain[0];
    choices.push(step?.connectionId ?? null);
    if (!step) {
      r.unroutable++;
      continue;
    }
    r.share[step.providerId] = (r.share[step.providerId] ?? 0) + 1;
    let p: number;
    let latency: number;
    if (step.connectionId === h.first.connectionId) {
      r.observed++;
      p = h.first.success ? 1 : 0;
      latency = h.first.latencyMs;
    } else {
      r.estimated++;
      const seg = segments.get(segmentKey(step.providerId, h.method, h.currency));
      const base = seg && seg.attempts >= MIN_SAMPLE ? seg : segments.get(segmentKey(step.providerId));
      if (!base || base.attempts < MIN_SAMPLE) r.lowConfidence++;
      p = smoothedSuccessRate(base ? { attempts: base.attempts, successes: base.successes, avgLatencyMs: 0 } : undefined);
      latency = base && base.attempts > 0 ? base.latencySum / base.attempts : routingStats[step.connectionId]?.avgLatencyMs || 2500;
    }
    r.expectedSuccesses += p;
    latencySum += latency;
    latencyN++;
    const cand = candidates.find((c) => c.connectionId === step.connectionId);
    const pricing = cand?.pricing ?? cand?.descriptor.pricing;
    if (pricing) {
      const fee = estimateFeeMinor(pricing, h.amountMinor, h.currency).feeMinor;
      r.feesByCurrency[h.currency] = (r.feesByCurrency[h.currency] ?? 0) + fee * p;
    }
  }
  const routed = r.payments - r.unroutable;
  r.successRate = routed > 0 ? r.expectedSuccesses / routed : null;
  r.avgLatencyMs = latencyN > 0 ? Math.round(latencySum / latencyN) : null;
  // Expected successes per currency for cost-per-success.
  const expByCur: Record<string, number> = {};
  history.forEach((h, i) => {
    const c = choices[i];
    if (!c) return;
    const same = c === h.first.connectionId;
    const prov = candidates.find((x) => x.connectionId === c)?.providerId ?? "";
    const seg = segments.get(segmentKey(prov, h.method, h.currency));
    const base = seg && seg.attempts >= MIN_SAMPLE ? seg : segments.get(segmentKey(prov));
    const p = same ? (h.first.success ? 1 : 0) : smoothedSuccessRate(base ? { attempts: base.attempts, successes: base.successes, avgLatencyMs: 0 } : undefined);
    expByCur[h.currency] = (expByCur[h.currency] ?? 0) + p;
  });
  for (const [cur, fee] of Object.entries(r.feesByCurrency)) {
    r.feesByCurrency[cur] = Math.round(fee);
    r.costPerSuccessByCurrency[cur] = expByCur[cur] ? Math.round(fee / expByCur[cur]) : null;
  }
  r.expectedSuccesses = Math.round(r.expectedSuccesses * 10) / 10;
  return { result: r, choices };
}

export function backtest(
  history: HistoricalPayment[],
  candidates: Candidate[],
  routingStats: Record<string, ProviderStats>,
  current: Policy,
  proposed: Policy,
) {
  const segments = buildSegments(history);
  const a = evaluatePolicy(history, candidates, routingStats, segments, current);
  const b = evaluatePolicy(history, candidates, routingStats, segments, proposed);
  const changed = a.choices.filter((c, i) => c !== b.choices[i]).length;
  return {
    current: a.result,
    proposed: b.result,
    changedDecisions: changed,
    delta: {
      successRatePoints: a.result.successRate !== null && b.result.successRate !== null ? Math.round((b.result.successRate - a.result.successRate) * 1000) / 10 : null,
      avgLatencyMs: a.result.avgLatencyMs !== null && b.result.avgLatencyMs !== null ? b.result.avgLatencyMs - a.result.avgLatencyMs : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider scorecards
// ---------------------------------------------------------------------------

export interface AttemptRow {
  providerId: string;
  connectionId: string;
  status: string; // provider ChargeStatus
  failureCategory?: string;
  latencyMs: number;
  probe: boolean;
  currency: string;
  amountMinor: number;
}

const PROVIDER_FAULTS = new Set(["temporary_provider_failure", "provider_outage", "network_error", "rate_limited"]);
const CUSTOMER_DECLINES = new Set(["issuer_decline", "insufficient_funds", "invalid_payment_information", "fraud_rejection", "customer_cancellation"]);

export interface Scorecard {
  providerId: string;
  connectionId: string;
  attempts: number;
  /** Attempts with a final answer (excludes pending / awaiting customer). */
  decided: number;
  inFlight: number;
  successes: number;
  successRate: { rate: number | null; low: number | null; high: number | null };
  /** Successes / (successes + customer or issuer declines): how often the provider gets a yes when the request reached a decision maker. */
  approvalRate: number | null;
  providerErrorRate: number | null;
  timeoutRate: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  costPerSuccessByCurrency: Record<string, number | null>;
  probes: number;
  sufficient: boolean;
  limitations: string[];
}

export const SCORECARD_METHOD =
  "Customer payment attempts only (health-check probes are counted separately and excluded). " +
  "Success rate = successful ÷ decided attempts, with a 95% Wilson confidence interval. " +
  "Approval rate = successful ÷ (successful + issuer or customer declines). " +
  "Provider error rate = provider outages, temporary failures, network errors and rate limits ÷ decided attempts. " +
  "Timeout rate = timeouts or unknown outcomes ÷ decided attempts. " +
  "Latency is time from request to provider answer (p50 and p95). " +
  `Cost per success uses the connection's agreed or list pricing; it is an estimate, not an invoice. Scores with fewer than ${MIN_SAMPLE} decided attempts are marked insufficient.`;

export function scorecards(
  rows: AttemptRow[],
  pricingFor: (connectionId: string) => Candidate["pricing"] | undefined,
): Scorecard[] {
  const groups = new Map<string, AttemptRow[]>();
  for (const r of rows) {
    const g = groups.get(r.connectionId) ?? [];
    g.push(r);
    groups.set(r.connectionId, g);
  }
  const out: Scorecard[] = [];
  for (const [connectionId, all] of groups) {
    const probes = all.filter((r) => r.probe).length;
    const real = all.filter((r) => !r.probe);
    const inFlight = real.filter((r) => r.status === "pending" || r.status === "requires_action").length;
    const decidedRows = real.filter((r) => r.status !== "pending" && r.status !== "requires_action");
    const decided = decidedRows.length;
    const ok = decidedRows.filter((r) => r.status === "successful");
    const declines = decidedRows.filter((r) => r.status !== "successful" && r.failureCategory && CUSTOMER_DECLINES.has(r.failureCategory)).length;
    const providerErr = decidedRows.filter((r) => r.failureCategory && PROVIDER_FAULTS.has(r.failureCategory)).length;
    const timeouts = decidedRows.filter((r) => r.status === "unknown" || r.failureCategory === "timeout").length;
    const lat = decidedRows.map((r) => r.latencyMs);
    const pricing = pricingFor(connectionId);
    const fees: Record<string, number> = {};
    const succ: Record<string, number> = {};
    for (const r of ok) {
      succ[r.currency] = (succ[r.currency] ?? 0) + 1;
      if (pricing) fees[r.currency] = (fees[r.currency] ?? 0) + estimateFeeMinor(pricing, r.amountMinor, r.currency).feeMinor;
    }
    const cps: Record<string, number | null> = {};
    for (const cur of Object.keys(succ)) cps[cur] = pricing ? Math.round((fees[cur] ?? 0) / succ[cur]) : null;
    const limitations: string[] = [];
    if (decided < MIN_SAMPLE) limitations.push(`Only ${decided} decided attempts in this period; at least ${MIN_SAMPLE} are needed before the score is meaningful.`);
    if (inFlight > 0) limitations.push(`${inFlight} attempts were still awaiting an outcome and are excluded.`);
    if (!pricing) limitations.push("No pricing recorded for this connection, so cost per success is not shown.");
    if (decidedRows.some((r) => r.status === "unknown")) limitations.push("Unknown outcomes count as timeouts here even if later recovery confirmed them.");
    out.push({
      providerId: all[0].providerId,
      connectionId,
      attempts: real.length,
      decided,
      inFlight,
      successes: ok.length,
      successRate: wilson(ok.length, decided),
      approvalRate: ok.length + declines > 0 ? ok.length / (ok.length + declines) : null,
      providerErrorRate: decided > 0 ? providerErr / decided : null,
      timeoutRate: decided > 0 ? timeouts / decided : null,
      latencyP50: percentile(lat, 50),
      latencyP95: percentile(lat, 95),
      costPerSuccessByCurrency: cps,
      probes,
      sufficient: decided >= MIN_SAMPLE,
      limitations,
    });
  }
  return out.sort((a, b) => b.attempts - a.attempts);
}

/** Collapse attempts into first-attempt history for backtesting. */
export function historyFromAttempts(rows: (AttemptRow & { transactionId: string; attempt: number; country?: string; paymentMethod: string })[]): HistoricalPayment[] {
  const firsts = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.probe) continue;
    if (r.status === "pending" || r.status === "requires_action") continue;
    const cur = firsts.get(r.transactionId);
    if (!cur || r.attempt < cur.attempt) firsts.set(r.transactionId, r);
  }
  return [...firsts.values()]
    .filter((r) => r.attempt === 1)
    .map((r) => ({
      amountMinor: r.amountMinor,
      currency: r.currency,
      method: r.paymentMethod,
      country: r.country,
      first: { providerId: r.providerId, connectionId: r.connectionId, success: r.status === "successful", latencyMs: r.latencyMs },
    }));
}
