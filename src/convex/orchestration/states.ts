// USOPGRID transaction state machine.
//
// Every status change in the platform — engine, provider webhooks, recovery
// jobs, operators — goes through canTransition(). That single rule is what
// makes duplicate and out-of-order provider events harmless: a late
// "pending" webhook can never drag a SUCCESSFUL payment backwards.

export const TX_STATES = [
  "CREATED",
  "VALIDATED",
  "ACCEPTED",
  "PROCESSING",
  "PENDING",
  "SUCCESSFUL",
  "FAILED",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "REFUND_PENDING",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "REVERSED",
  "DISPUTED",
  "RECONCILIATION_EXCEPTION",
] as const;

export type TxState = (typeof TX_STATES)[number];

/** Allowed forward transitions. Anything not listed is rejected. */
const TRANSITIONS: Record<TxState, readonly TxState[]> = {
  CREATED: ["VALIDATED", "DECLINED", "FAILED", "CANCELLED"],
  VALIDATED: ["ACCEPTED", "DECLINED", "FAILED", "CANCELLED"],
  ACCEPTED: ["PROCESSING", "FAILED", "CANCELLED"],
  PROCESSING: ["PENDING", "SUCCESSFUL", "FAILED", "DECLINED", "CANCELLED", "EXPIRED", "RECONCILIATION_EXCEPTION"],
  PENDING: ["SUCCESSFUL", "FAILED", "DECLINED", "CANCELLED", "EXPIRED", "RECONCILIATION_EXCEPTION"],
  SUCCESSFUL: ["REFUND_PENDING", "PARTIALLY_REFUNDED", "REFUNDED", "REVERSED", "DISPUTED", "RECONCILIATION_EXCEPTION"],
  REFUND_PENDING: ["PARTIALLY_REFUNDED", "REFUNDED", "SUCCESSFUL", "RECONCILIATION_EXCEPTION"],
  PARTIALLY_REFUNDED: ["REFUND_PENDING", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED", "RECONCILIATION_EXCEPTION"],
  DISPUTED: ["SUCCESSFUL", "REVERSED", "PARTIALLY_REFUNDED", "REFUNDED", "RECONCILIATION_EXCEPTION"],
  // A late success for an EXPIRED/FAILED attempt means money moved anyway:
  // route it to an exception for finance instead of silently flipping state.
  FAILED: ["RECONCILIATION_EXCEPTION"],
  DECLINED: ["RECONCILIATION_EXCEPTION"],
  EXPIRED: ["RECONCILIATION_EXCEPTION"],
  CANCELLED: ["RECONCILIATION_EXCEPTION"],
  REFUNDED: ["RECONCILIATION_EXCEPTION"],
  REVERSED: ["RECONCILIATION_EXCEPTION"],
  RECONCILIATION_EXCEPTION: ["SUCCESSFUL", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "REVERSED"],
};

export const TERMINAL_STATES: ReadonlySet<TxState> = new Set([
  "FAILED",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
  "REVERSED",
]);

/** States in which a provider may still change its mind — recovery jobs poll these. */
export const IN_FLIGHT_STATES: ReadonlySet<TxState> = new Set(["PROCESSING", "PENDING", "REFUND_PENDING"]);

export function isTxState(s: string): s is TxState {
  return (TX_STATES as readonly string[]).includes(s);
}

export function canTransition(from: string, to: string): boolean {
  if (!isTxState(from) || !isTxState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: string): readonly TxState[] {
  return isTxState(from) ? TRANSITIONS[from] : [];
}

/**
 * Resolve an incoming provider outcome against the current state.
 * - "apply":     legal forward transition
 * - "noop":      already in that state (duplicate event)
 * - "stale":     the event is older than what we know (out-of-order) — record, don't apply
 * - "exception": provider reports money movement on a terminal-failed record
 */
export type OutcomeResolution = "apply" | "noop" | "stale" | "exception";

const RANK: Partial<Record<TxState, number>> = {
  CREATED: 0,
  VALIDATED: 1,
  ACCEPTED: 2,
  PROCESSING: 3,
  PENDING: 4,
  SUCCESSFUL: 5,
};

export function resolveProviderOutcome(current: string, reported: TxState): OutcomeResolution {
  if (current === reported) return "noop";
  if (
    reported === "SUCCESSFUL" &&
    (current === "FAILED" || current === "DECLINED" || current === "EXPIRED" || current === "CANCELLED")
  ) {
    return "exception";
  }
  if (canTransition(current, reported)) return "apply";
  const a = RANK[current as TxState];
  const b = RANK[reported];
  if (a !== undefined && b !== undefined && b < a) return "stale";
  // Anything else (e.g. a "pending" event for a refunded payment) is an event
  // the state machine has already moved past: record it, never apply it.
  return "stale";
}

/** Human labels for UI and docs. */
export const STATE_LABELS: Record<TxState, string> = {
  CREATED: "Created",
  VALIDATED: "Validated",
  ACCEPTED: "Accepted",
  PROCESSING: "Processing",
  PENDING: "Pending",
  SUCCESSFUL: "Successful",
  FAILED: "Failed",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REFUND_PENDING: "Refund pending",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  REVERSED: "Reversed",
  DISPUTED: "Disputed",
  RECONCILIATION_EXCEPTION: "Reconciliation exception",
};
