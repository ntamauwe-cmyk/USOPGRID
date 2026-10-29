// Orchestration: state machine, circuit breaker, router and the charge-chain
// executor running against the real sandbox rails.
import { describe, expect, test } from "bun:test";
import { canTransition, resolveProviderOutcome, TX_STATES, TERMINAL_STATES } from "../convex/orchestration/states";
import { CLOSED, isAvailable, recordOutcome, beginProbe, DEFAULT_CIRCUIT } from "../convex/orchestration/circuit";
import { route, smoothedSuccessRate, estimateFeeMinor, type Candidate } from "../convex/orchestration/router";
import { executeChain, circuitOutcomeFor, txStateForCharge, type ChainStep, type AttemptRecord } from "../convex/orchestration/engine";
import { backoffMs, nextRecoveryAt, RECOVERY_SCHEDULE_MS } from "../convex/orchestration/retry";
import { evaluateJurisdiction } from "../convex/orchestration/compliance";
import { getAdapter, listDescriptors, ADAPTERS } from "../convex/providers/index";
import type { AdapterContext } from "../convex/providers/types";

const ctxFor = (): AdapterContext => ({ environment: "sandbox", credentials: {}, fetch: fetch, now: () => Date.now() });

describe("transaction state machine", () => {
  test("happy path is legal", () => {
    const path = ["CREATED", "VALIDATED", "ACCEPTED", "PROCESSING", "SUCCESSFUL", "PARTIALLY_REFUNDED", "REFUNDED"];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });
  test("terminal states cannot move back to success directly", () => {
    expect(canTransition("FAILED", "SUCCESSFUL")).toBe(false);
    expect(canTransition("REFUNDED", "SUCCESSFUL")).toBe(false);
    for (const s of TERMINAL_STATES) expect(canTransition(s, "PROCESSING")).toBe(false);
  });
  test("duplicate and out-of-order provider events are harmless", () => {
    expect(resolveProviderOutcome("SUCCESSFUL", "SUCCESSFUL")).toBe("noop");
    expect(resolveProviderOutcome("SUCCESSFUL", "PENDING")).toBe("stale");
    expect(resolveProviderOutcome("PENDING", "SUCCESSFUL")).toBe("apply");
    expect(resolveProviderOutcome("REFUNDED", "PENDING")).toBe("stale");
  });
  test("late success on a failed payment becomes a reconciliation exception", () => {
    expect(resolveProviderOutcome("FAILED", "SUCCESSFUL")).toBe("exception");
    expect(resolveProviderOutcome("EXPIRED", "SUCCESSFUL")).toBe("exception");
  });
  test("every state has a label-able transition table", () => {
    expect(TX_STATES.length).toBe(16);
  });
});

describe("circuit breaker", () => {
  test("opens after threshold provider failures and ignores declines", () => {
    let s = CLOSED;
    for (let i = 0; i < DEFAULT_CIRCUIT.failureThreshold - 1; i++) s = recordOutcome(s, "provider_failure", 1000);
    expect(s.state).toBe("closed");
    s = recordOutcome(s, "neutral", 1000);
    expect(s.state).toBe("closed");
    s = recordOutcome(s, "provider_failure", 1000);
    expect(s.state).toBe("open");
    expect(isAvailable(s, 1001).available).toBe(false);
  });
  test("half-open probe closes on success and doubles cooldown on failure", () => {
    let s = CLOSED;
    for (let i = 0; i < 5; i++) s = recordOutcome(s, "provider_failure", 0);
    const probeAt = s.nextProbeAt!;
    expect(isAvailable(s, probeAt)).toEqual({ available: true, probe: true });
    const probing = beginProbe(s);
    expect(probing.state).toBe("half_open");
    const reopened = recordOutcome(probing, "provider_failure", probeAt);
    expect(reopened.state).toBe("open");
    expect(reopened.cooldownMs).toBe(DEFAULT_CIRCUIT.baseCooldownMs * 2);
    expect(recordOutcome(probing, "success", probeAt).state).toBe("closed");
  });
});

describe("router", () => {
  const d = (id: string) => getAdapter(id)!.descriptor;
  const cands: Candidate[] = [
    { providerId: "stripe", connectionId: "c_stripe", descriptor: d("stripe"), priority: 0, enabled: true },
    { providerId: "paystack", connectionId: "c_paystack", descriptor: d("paystack"), priority: 0, enabled: true },
    { providerId: "flutterwave", connectionId: "c_flw", descriptor: d("flutterwave"), priority: 0, enabled: true },
  ];

  test("only providers whose envelope covers the payment are eligible", () => {
    const dec = route({ request: { country: "NG", currency: "NGN", method: "ussd", amountMinor: 500_000 }, candidates: cands, stats: {}, circuits: {}, rules: [], now: 0 });
    const ids = dec.chain.map((c) => c.providerId);
    expect(ids).not.toContain("stripe");
    expect(ids.length).toBeGreaterThan(0);
    expect(dec.explanation).toMatch(/Selected/);
  });

  test("historical success rate moves a provider up", () => {
    const req = { country: "NG", currency: "NGN", method: "card", amountMinor: 500_000 };
    const good = { attempts: 1000, successes: 990, avgLatencyMs: 800 };
    const bad = { attempts: 1000, successes: 600, avgLatencyMs: 800 };
    const a = route({ request: req, candidates: cands, stats: { c_paystack: bad, c_flw: good }, circuits: {}, rules: [], now: 0 });
    const b = route({ request: req, candidates: cands, stats: { c_paystack: good, c_flw: bad }, circuits: {}, rules: [], now: 0 });
    expect(a.chain[0].providerId).toBe("flutterwave");
    expect(b.chain[0].providerId).toBe("paystack");
  });

  test("open circuit removes a provider and rules can exclude/prefer", () => {
    const req = { country: "NG", currency: "NGN", method: "card", amountMinor: 500_000 };
    const open = { c_paystack: { state: "open" as const, consecutiveFailures: 9, nextProbeAt: 10_000 } };
    const dec = route({ request: req, candidates: cands, stats: {}, circuits: open, rules: [], now: 0 });
    expect(dec.chain.map((c) => c.providerId)).not.toContain("paystack");
    const ex = route({
      request: req, candidates: cands, stats: {}, circuits: {}, now: 0,
      rules: [{ id: "r1", name: "No FLW", enabled: true, order: 1, match: { countries: ["NG"] }, action: { type: "exclude", providers: ["flutterwave"] } }],
    });
    expect(ex.chain.map((c) => c.providerId)).not.toContain("flutterwave");
    expect(ex.chain.map((c) => c.providerId)).toContain("paystack");
    const only = route({
      request: req, candidates: cands, stats: {}, circuits: {}, now: 0,
      rules: [{ id: "r2", name: "Local only", enabled: true, order: 1, match: { currencies: ["NGN"] }, action: { type: "only", providers: ["paystack"] } }],
    });
    expect(only.chain.map((c) => c.providerId)).toEqual(["paystack"]);
    expect(ex.matchedRules).toEqual(["r1"]);
  });

  test("no eligible provider explains why", () => {
    const dec = route({ request: { country: "BR", currency: "BRL", method: "pix", amountMinor: 1000 }, candidates: cands.slice(1), stats: {}, circuits: {}, rules: [], now: 0 });
    expect(dec.chain).toHaveLength(0);
    expect(dec.explanation).toMatch(/No eligible provider/);
  });

  test("success smoothing and fee estimate use integer minor units", () => {
    expect(smoothedSuccessRate(undefined)).toBeCloseTo(0.85);
    expect(estimateFeeMinor({ pctBps: 150, fixedMinor: 10_000, fixedCurrency: "NGN" }, 1_000_000, "NGN")).toEqual({ feeMinor: 25_000, partial: false });
    expect(estimateFeeMinor({ pctBps: 290, fixedMinor: 30, fixedCurrency: "USD" }, 10_000, "EUR")).toEqual({ feeMinor: 290, partial: true });
    // Paystack-style cap: 1.5% + ₦100 on ₦500,000 would be ₦7,600 but is capped at ₦2,000.
    expect(estimateFeeMinor({ pctBps: 150, fixedMinor: 10_000, fixedCurrency: "NGN", capMinor: 200_000 }, 50_000_000, "NGN").feeMinor).toBe(200_000);
  });
});

describe("provider registry", () => {
  test("every adapter declares a complete descriptor", () => {
    const ids = new Set<string>();
    for (const a of ADAPTERS) {
      const d = a.descriptor;
      expect(ids.has(d.id)).toBe(false);
      ids.add(d.id);
      expect(d.methods.length).toBeGreaterThan(0);
      expect(d.docsUrl).toMatch(/^https:\/\//);
      for (const c of d.credentials) expect(c.key.length).toBeGreaterThan(0);
    }
    expect(listDescriptors().length).toBeGreaterThanOrEqual(12);
  });
  test("together the live adapters reach every inhabited region", () => {
    const live = listDescriptors().filter((d) => d.category !== "sandbox");
    const global = live.filter((d) => d.countries === "global");
    expect(global.length).toBeGreaterThanOrEqual(2);
  });
});

function harness(chainIds: string[]) {
  const attempts: AttemptRecord[] = [];
  const chain: ChainStep[] = chainIds.map((id) => ({ providerId: id, connectionId: `conn_${id}` }));
  const circuits: Record<string, string> = {};
  const deps = {
    resolve: async (s: ChainStep) => ({ adapter: getAdapter(s.providerId)!, ctx: ctxFor() }),
    gate: async (s: ChainStep) => ({ allowed: circuits[s.connectionId] !== "open", probe: false }),
    onAttempt: async (r: AttemptRecord) => {
      attempts.push(r);
    },
    now: () => Date.now(),
  };
  return { chain, deps, attempts, circuits };
}

const base = (simulate: string) => ({
  transactionId: "txn_test123456789",
  amountMinor: 10_000,
  currency: "USD",
  reference: "ref_1",
  paymentMethod: "card",
  metadata: { simulate },
});

describe("charge chain executor (sandbox rails)", () => {
  test("success on primary, no failover", async () => {
    const h = harness(["sandbox", "sandbox_backup"]);
    const out = await executeChain(base("success"), h.chain, h.deps);
    expect(out.kind).toBe("successful");
    expect(out.failovers).toBe(0);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0].idempotencyKey).toBe("txn_test123456789:conn_sandbox");
  });

  test("primary outage fails over to backup", async () => {
    const h = harness(["sandbox", "sandbox_backup"]);
    const out = await executeChain(base("failover"), h.chain, h.deps);
    expect(out.kind).toBe("successful");
    expect(out.failovers).toBe(1);
    expect(out.decisive?.providerId).toBe("sandbox_backup");
    expect(circuitOutcomeFor(h.attempts[0].result)).toBe("provider_failure");
  });

  test("all rails down → failed with the last provider failure", async () => {
    const h = harness(["sandbox", "sandbox_backup"]);
    const out = await executeChain(base("provider_down"), h.chain, h.deps);
    expect(out.kind).toBe("failed");
    expect(out.failure?.category).toBe("provider_outage");
    expect(h.attempts).toHaveLength(2);
  });

  test("timeout is ambiguous: never fails over (no double charge)", async () => {
    const h = harness(["sandbox", "sandbox_backup"]);
    const out = await executeChain(base("timeout"), h.chain, h.deps);
    expect(out.kind).toBe("unknown");
    expect(h.attempts).toHaveLength(1);
    expect(txStateForCharge("unknown")).toBe("PENDING");
    // Recovery resolves it by status lookup on the SAME provider.
    const status = await getAdapter("sandbox")!.getStatus(ctxFor(), {
      transactionId: "txn_test123456789", reference: "ref_1", currency: "USD", providerReference: out.decisive!.result.providerReference,
    });
    expect(status.status).toBe("successful");
  });

  test("issuer decline is definitive: no failover", async () => {
    const h = harness(["sandbox", "sandbox_backup"]);
    const out = await executeChain(base("issuer_decline"), h.chain, h.deps);
    expect(out.kind).toBe("declined");
    expect(h.attempts).toHaveLength(1);
    expect(circuitOutcomeFor(h.attempts[0].result)).toBe("success");
  });

  test("open circuit is skipped without an attempt", async () => {
    const h = harness(["sandbox", "sandbox_backup"]);
    h.circuits.conn_sandbox = "open";
    const out = await executeChain(base("success"), h.chain, h.deps);
    expect(out.kind).toBe("successful");
    expect(out.decisive?.providerId).toBe("sandbox_backup");
    expect(h.attempts).toHaveLength(1);
  });

  test("missing credentials fail over safely; empty chain is no_route", async () => {
    const h = harness(["stripe", "sandbox"]);
    const out = await executeChain(base("success"), h.chain, {
      ...h.deps,
      resolve: async (s) => (s.providerId === "stripe" ? { error: { category: "configuration_error", code: "no_credentials", message: "x", retryable: false, safeToFailover: true } } : h.deps.resolve(s)),
    });
    expect(out.kind).toBe("successful");
    expect(out.failovers).toBe(1);
    const none = await executeChain(base("success"), [], h.deps);
    expect(none.kind).toBe("no_route");
  });
});

describe("retry + compliance", () => {
  test("backoff is bounded and recovery schedule ends", () => {
    for (let i = 0; i < 20; i++) expect(backoffMs(i, 1000, 60_000, () => 0.999)).toBeLessThan(60_000);
    expect(nextRecoveryAt(0, 0)).toBe(RECOVERY_SCHEDULE_MS[0]);
    expect(nextRecoveryAt(RECOVERY_SCHEDULE_MS.length, 0)).toBe(null);
  });
  test("embargoed jurisdictions are blocked, high-risk go to review", () => {
    expect(evaluateJurisdiction({ payerCountry: "KP", currency: "USD", amountMinor: 1 }).decision).toBe("BLOCK");
    expect(evaluateJurisdiction({ payerCountry: "RU", currency: "USD", amountMinor: 1 }).decision).toBe("REVIEW");
    expect(evaluateJurisdiction({ payerCountry: "NG", currency: "NGN", amountMinor: 1 }).decision).toBe("ALLOW");
  });
});
