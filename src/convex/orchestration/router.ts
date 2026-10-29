// USOPGRID routing engine — pure, deterministic, explainable.
//
// Pipeline for every payment:
//   1. eligibility: capability envelope (country/currency/method/limits),
//      connection enabled, environment, circuit breaker, merchant rules
//   2. scoring:     smoothed success rate, estimated cost, latency, priority
//   3. ordering:    best score first; the rest form the failover chain
//
// Every candidate's verdict and score components are returned so operators
// (and merchants) can see exactly why a provider was or wasn't chosen.

import type { ProviderDescriptor } from "../providers/types";
import { descriptorSupports } from "../providers/types";
import { isAvailable, type CircuitState } from "./circuit";

export interface RoutingRequest {
  country?: string;
  currency: string;
  method: string;
  amountMinor: number;
  riskScore?: number;
}

export interface Candidate {
  providerId: string;
  connectionId: string;
  descriptor: ProviderDescriptor;
  /** Operator priority −100…100: higher wins ties and adds a small bonus. */
  priority: number;
  enabled: boolean;
  /** Agreed pricing on this connection, overriding list pricing. */
  pricing?: { pctBps: number; fixedMinor: number; fixedCurrency: string; capMinor?: number };
}

export interface ProviderStats {
  attempts: number;
  successes: number;
  avgLatencyMs: number;
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  match: {
    countries?: string[];
    currencies?: string[];
    methods?: string[];
    minAmountMinor?: number;
    maxAmountMinor?: number;
    minRiskScore?: number;
  };
  action: { type: "prefer" | "exclude" | "only"; providers: string[] };
}

export interface RoutingStrategy {
  weights: { success: number; cost: number; latency: number };
  /** Max providers tried for one payment (primary + failovers). */
  maxAttempts: number;
}

/** Latency assumed for a provider we have never measured. */
export const UNKNOWN_LATENCY_MS = 2_500;
/** Latency at or beyond which the latency component scores 0. */
export const LATENCY_CAP_MS = 10_000;
/** Effective fee rate at or beyond which the cost component scores 0 (8%). */
export const COST_CAP_RATE = 0.08;
/** Operator priority (−100…100) adds up to ±0.05; a "prefer" rule adds 0.25. */
const PRIORITY_BONUS = 0.05;
const RULE_BONUS = 0.25;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export const DEFAULT_STRATEGY: RoutingStrategy = {
  weights: { success: 0.6, cost: 0.25, latency: 0.15 },
  maxAttempts: 3,
};

export interface CandidateEvaluation {
  providerId: string;
  connectionId: string;
  eligible: boolean;
  reasons: string[];
  score: number;
  components: { success: number; cost: number; latency: number; priority: number; rule: number };
  estimatedFeeMinor: number | null;
  observedSuccessRate: number | null;
  circuit: CircuitState["state"];
}

export interface RoutingDecision {
  chain: { providerId: string; connectionId: string }[];
  evaluations: CandidateEvaluation[];
  matchedRules: string[];
  strategy: RoutingStrategy;
  explanation: string;
}

/** Bayesian-smoothed success rate: new providers start near the prior instead of 0% or 100%. */
export function smoothedSuccessRate(stats: ProviderStats | undefined, prior = 0.85, weight = 20): number {
  const a = stats?.attempts ?? 0;
  const s = stats?.successes ?? 0;
  return (s + prior * weight) / (a + weight);
}

/** Estimated provider fee in transaction minor units. Fixed fees in another currency are ignored (flagged). */
export function estimateFeeMinor(
  pricing: { pctBps: number; fixedMinor: number; fixedCurrency: string; capMinor?: number },
  amountMinor: number,
  currency: string,
): { feeMinor: number; partial: boolean } {
  const pct = Math.round((amountMinor * pricing.pctBps) / 10_000);
  if (pricing.fixedCurrency === currency) {
    const fee = pct + pricing.fixedMinor;
    return { feeMinor: pricing.capMinor !== undefined ? Math.min(fee, pricing.capMinor) : fee, partial: false };
  }
  // Without an FX quote we cannot price a cross-currency fixed fee honestly.
  return { feeMinor: pct, partial: pricing.fixedMinor > 0 };
}

export function ruleMatches(rule: RoutingRule, req: RoutingRequest): boolean {
  if (!rule.enabled) return false;
  const m = rule.match;
  if (m.countries?.length && (!req.country || !m.countries.includes(req.country))) return false;
  if (m.currencies?.length && !m.currencies.includes(req.currency)) return false;
  if (m.methods?.length && !m.methods.includes(req.method)) return false;
  if (m.minAmountMinor !== undefined && req.amountMinor < m.minAmountMinor) return false;
  if (m.maxAmountMinor !== undefined && req.amountMinor > m.maxAmountMinor) return false;
  if (m.minRiskScore !== undefined && (req.riskScore ?? 0) < m.minRiskScore) return false;
  return true;
}

export function route(params: {
  request: RoutingRequest;
  candidates: Candidate[];
  stats: Record<string, ProviderStats>;
  circuits: Record<string, CircuitState>;
  rules: RoutingRule[];
  strategy?: RoutingStrategy;
  now: number;
}): RoutingDecision {
  const { request: req, now } = params;
  const strategy = params.strategy ?? DEFAULT_STRATEGY;
  const rules = [...params.rules].sort((a, b) => a.order - b.order).filter((r) => ruleMatches(r, req));

  const preferred = new Set<string>();
  const excluded = new Set<string>();
  let only: Set<string> | null = null;
  for (const r of rules) {
    if (r.action.type === "prefer") r.action.providers.forEach((p) => preferred.add(p));
    if (r.action.type === "exclude") r.action.providers.forEach((p) => excluded.add(p));
    if (r.action.type === "only" && only === null) only = new Set(r.action.providers);
  }

  const evals: CandidateEvaluation[] = params.candidates.map((c) => {
    const reasons: string[] = [];
    const circuit = params.circuits[c.connectionId] ?? { state: "closed", consecutiveFailures: 0 };
    if (!c.enabled) reasons.push("connection disabled");
    const sup = descriptorSupports(c.descriptor, { country: req.country, currency: req.currency, method: req.method, amountMinor: req.amountMinor });
    if (!sup.ok) reasons.push(sup.reason);
    if (excluded.has(c.providerId)) reasons.push("excluded by routing rule");
    if (only && !only.has(c.providerId)) reasons.push("not in rule's allowed providers");
    const avail = isAvailable(circuit, now);
    if (!avail.available) reasons.push(`circuit ${circuit.state} until ${new Date(circuit.nextProbeAt ?? now).toISOString()}`);

    const pricing = c.pricing ?? c.descriptor.pricing;
    const fee = estimateFeeMinor(pricing, req.amountMinor, req.currency);
    const stats = params.stats[c.connectionId] ?? params.stats[c.providerId];
    return {
      providerId: c.providerId,
      connectionId: c.connectionId,
      eligible: reasons.length === 0,
      reasons: reasons.length ? reasons : [fee.partial ? "eligible (fixed fee in other currency excluded from estimate)" : "eligible"],
      score: 0,
      components: { success: smoothedSuccessRate(stats), cost: 0, latency: 0, priority: c.priority, rule: preferred.has(c.providerId) ? 1 : 0 },
      estimatedFeeMinor: fee.feeMinor,
      observedSuccessRate: stats && stats.attempts > 0 ? stats.successes / stats.attempts : null,
      circuit: circuit.state,
    };
  });

  const eligible = evals.filter((e) => e.eligible);
  // Absolute scales (not relative to whichever peers happen to be eligible),
  // so a score means the same thing across payments and over time.
  for (const e of eligible) {
    const s = params.stats[e.connectionId] ?? params.stats[e.providerId];
    const lat = s && s.attempts > 0 ? s.avgLatencyMs : UNKNOWN_LATENCY_MS;
    const rate = req.amountMinor > 0 ? (e.estimatedFeeMinor ?? 0) / req.amountMinor : 0;
    e.components.cost = round4(1 - Math.min(rate, COST_CAP_RATE) / COST_CAP_RATE);
    e.components.latency = round4(1 - Math.min(lat, LATENCY_CAP_MS) / LATENCY_CAP_MS);
    const w = strategy.weights;
    e.score = round4(
      w.success * e.components.success +
        w.cost * e.components.cost +
        w.latency * e.components.latency +
        PRIORITY_BONUS * Math.max(-1, Math.min(1, e.components.priority / 100)) +
        RULE_BONUS * e.components.rule,
    );
  }

  eligible.sort((a, b) => b.score - a.score || b.components.priority - a.components.priority || a.providerId.localeCompare(b.providerId));
  const chain = eligible.slice(0, Math.max(1, strategy.maxAttempts)).map((e) => ({ providerId: e.providerId, connectionId: e.connectionId }));

  const top = eligible[0];
  const explanation = top
    ? `Selected ${top.providerId} (score ${top.score.toFixed(3)}: success ${(top.components.success * 100).toFixed(1)}%, ` +
      `cost ${(top.components.cost * 100).toFixed(0)}, latency ${(top.components.latency * 100).toFixed(0)}` +
      `${top.components.rule ? ", preferred by rule" : ""})` +
      (chain.length > 1 ? `; failover: ${chain.slice(1).map((c) => c.providerId).join(" → ")}` : "; no failover available") +
      (rules.length ? `. Rules applied: ${rules.map((r) => r.name).join(", ")}.` : ".")
    : `No eligible provider for ${req.method}/${req.currency}${req.country ? `/${req.country}` : ""}: ` +
      evals.map((e) => `${e.providerId} — ${e.reasons.join("; ")}`).join(" | ");

  return { chain, evaluations: evals, matchedRules: rules.map((r) => r.id), strategy, explanation };
}
