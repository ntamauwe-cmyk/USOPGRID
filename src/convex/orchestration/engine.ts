// USOPGRID charge-chain executor — pure orchestration, no database.
//
// Given the ordered provider chain chosen by the router, attempt the charge on
// each provider in turn until one gives a definitive answer. The rules that
// keep customers from being charged twice live here and nowhere else:
//
//   successful / pending / requires_action  → stop, money is (or may be) moving
//   declined                                → stop, the customer's issuer said no
//   unknown (timeout, 5xx, transport)       → stop, NEVER fail over — the first
//                                             provider may have accepted it; the
//                                             recovery queue resolves it by
//                                             status lookup
//   failed + safeToFailover                 → try the next provider
//   failed (not safe)                       → stop
//
// Persistence (attempt rows, circuit state, health) is injected through deps
// so the same code runs in Convex actions and in unit tests.

import type { AdapterContext, ChargeRequest, ChargeResult, FailureInfo, ProviderAdapter } from "../providers/types";
import { failure } from "../providers/types";
import type { CircuitOutcome } from "./circuit";
import type { TxState } from "./states";

export interface ChainStep {
  providerId: string;
  connectionId: string;
}

export interface AttemptRecord {
  attempt: number;
  providerId: string;
  connectionId: string;
  idempotencyKey: string;
  result: ChargeResult;
  latencyMs: number;
  startedAt: number;
  probe: boolean;
  skipped?: string;
}

export interface ExecuteDeps {
  /** Resolve adapter + credentials for a step; an error means "not usable", never "maybe sent". */
  resolve(step: ChainStep): Promise<{ adapter: ProviderAdapter; ctx: AdapterContext } | { error: FailureInfo }>;
  /** Circuit breaker gate; may atomically mark the circuit half-open when granting a probe. */
  gate(step: ChainStep): Promise<{ allowed: boolean; probe: boolean; reason?: string }>;
  /** Persist one attempt (attempt row, circuit transition, health counters). */
  onAttempt(rec: AttemptRecord, circuit: CircuitOutcome): Promise<void>;
  now(): number;
}

export type ChainOutcomeKind = "successful" | "pending" | "requires_action" | "declined" | "unknown" | "failed" | "no_route";

export interface ChainOutcome {
  kind: ChainOutcomeKind;
  /** The attempt whose answer decided the outcome (null when nothing was attempted). */
  decisive: AttemptRecord | null;
  attempts: AttemptRecord[];
  /** Number of times the engine moved to another provider after a safe failure. */
  failovers: number;
  failure?: FailureInfo;
}

const PROVIDER_SIDE: ReadonlySet<string> = new Set([
  "provider_outage",
  "temporary_provider_failure",
  "timeout",
  "network_error",
  "rate_limited",
  "configuration_error",
]);

/** How a charge result should move the provider's circuit breaker. */
export function circuitOutcomeFor(r: ChargeResult): CircuitOutcome {
  switch (r.status) {
    case "successful":
    case "pending":
    case "requires_action":
    case "declined": // an issuer decline is a healthy provider giving a real answer
      return "success";
    case "unknown":
      return "provider_failure";
    case "failed":
      return r.failure && PROVIDER_SIDE.has(r.failure.category) ? "provider_failure" : "neutral";
  }
}

/** Provider charge status → USOPGRID transaction state. */
export function txStateForCharge(status: ChargeResult["status"]): TxState {
  switch (status) {
    case "successful":
      return "SUCCESSFUL";
    case "pending":
    case "requires_action":
    case "unknown":
      return "PENDING";
    case "declined":
      return "DECLINED";
    case "failed":
      return "FAILED";
  }
}

/** Stable provider-side idempotency key: retries to the same connection reuse it. */
export function attemptIdempotencyKey(transactionId: string, connectionId: string): string {
  return `${transactionId}:${connectionId}`.slice(0, 255);
}

export async function executeChain(
  base: Omit<ChargeRequest, "idempotencyKey">,
  chain: readonly ChainStep[],
  deps: ExecuteDeps,
): Promise<ChainOutcome> {
  const attempts: AttemptRecord[] = [];
  let failovers = 0;
  let lastFailure: FailureInfo | undefined;
  let tried = 0;

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const gate = await deps.gate(step);
    if (!gate.allowed) {
      lastFailure = failure("provider_outage", "circuit_open", gate.reason ?? `${step.providerId} circuit is open`, {
        retryable: true,
        safeToFailover: true,
      });
      continue;
    }

    const idempotencyKey = attemptIdempotencyKey(base.transactionId, step.connectionId);
    const startedAt = deps.now();
    let result: ChargeResult;

    const resolved = await deps.resolve(step);
    if ("error" in resolved) {
      result = { status: "failed", failure: { ...resolved.error, safeToFailover: true } };
    } else {
      try {
        result = await resolved.adapter.charge(resolved.ctx, { ...base, idempotencyKey });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Adapters only throw before the network call (e.g. a missing
        // credential). Anything else is treated as ambiguous to stay safe.
        result = /missing credential/i.test(msg)
          ? { status: "failed", failure: failure("configuration_error", "provider_misconfigured", msg, { safeToFailover: true }) }
          : { status: "unknown", failure: failure("temporary_provider_failure", "adapter_exception", msg, { retryable: true }) };
      }
    }

    tried++;
    const rec: AttemptRecord = {
      attempt: tried,
      providerId: step.providerId,
      connectionId: step.connectionId,
      idempotencyKey,
      result,
      latencyMs: Math.max(0, deps.now() - startedAt),
      startedAt,
      probe: gate.probe,
    };
    attempts.push(rec);
    await deps.onAttempt(rec, circuitOutcomeFor(result));

    if (result.status === "failed") {
      lastFailure = result.failure;
      const hasNext = i < chain.length - 1;
      if (result.failure?.safeToFailover && hasNext) {
        failovers++;
        continue;
      }
      return { kind: "failed", decisive: rec, attempts, failovers, failure: result.failure };
    }
    return { kind: result.status, decisive: rec, attempts, failovers, failure: result.failure };
  }

  if (tried === 0) {
    return {
      kind: chain.length === 0 ? "no_route" : "failed",
      decisive: null,
      attempts,
      failovers,
      failure:
        lastFailure ??
        failure("unsupported", "no_eligible_provider", "No provider can process this payment for the given country, currency and method.", {
          safeToFailover: false,
        }),
    };
  }
  return {
    kind: "failed",
    decisive: attempts[attempts.length - 1] ?? null,
    attempts,
    failovers,
    failure: lastFailure,
  };
}
