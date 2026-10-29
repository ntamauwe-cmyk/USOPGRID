// Circuit breaker per provider connection — pure state transitions.
//
// closed ──(N consecutive provider-side failures)──▶ open
// open ──(cooldown elapsed)──▶ half_open (one probe allowed)
// half_open ──success──▶ closed      half_open ──failure──▶ open (cooldown doubles)
//
// Only provider-side failures count (outage, timeout, transport, 5xx).
// Customer declines are healthy provider behaviour and never trip the breaker.

export interface CircuitState {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt?: number;
  nextProbeAt?: number;
  cooldownMs?: number;
  lastFailureReason?: string;
}

export interface CircuitConfig {
  failureThreshold: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
}

export const DEFAULT_CIRCUIT: CircuitConfig = {
  failureThreshold: 5,
  baseCooldownMs: 30_000,
  maxCooldownMs: 300_000,
};

export const CLOSED: CircuitState = { state: "closed", consecutiveFailures: 0 };

export function isAvailable(s: CircuitState, now: number): { available: boolean; probe: boolean } {
  if (s.state === "closed") return { available: true, probe: false };
  if (s.state === "open") {
    if (s.nextProbeAt !== undefined && now >= s.nextProbeAt) return { available: true, probe: true };
    return { available: false, probe: false };
  }
  return { available: true, probe: true }; // half_open: let the probe through
}

export type CircuitOutcome = "success" | "provider_failure" | "neutral";

export function recordOutcome(
  s: CircuitState,
  outcome: CircuitOutcome,
  now: number,
  cfg: CircuitConfig = DEFAULT_CIRCUIT,
  reason?: string,
): CircuitState {
  if (outcome === "neutral") return s;
  if (outcome === "success") return { ...CLOSED };

  // provider_failure
  const wasProbing = s.state === "half_open" || (s.state === "open" && s.nextProbeAt !== undefined && now >= s.nextProbeAt);
  if (wasProbing) {
    const cooldown = Math.min((s.cooldownMs ?? cfg.baseCooldownMs) * 2, cfg.maxCooldownMs);
    return { state: "open", consecutiveFailures: s.consecutiveFailures + 1, openedAt: now, nextProbeAt: now + cooldown, cooldownMs: cooldown, lastFailureReason: reason };
  }
  const failures = s.consecutiveFailures + 1;
  if (failures >= cfg.failureThreshold) {
    return { state: "open", consecutiveFailures: failures, openedAt: now, nextProbeAt: now + cfg.baseCooldownMs, cooldownMs: cfg.baseCooldownMs, lastFailureReason: reason };
  }
  return { ...s, consecutiveFailures: failures, lastFailureReason: reason };
}

/** When a probe is granted, mark half_open so concurrent requests don't all probe. */
export function beginProbe(s: CircuitState): CircuitState {
  return s.state === "open" ? { ...s, state: "half_open" } : s;
}
