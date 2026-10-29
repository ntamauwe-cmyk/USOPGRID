// Backoff schedules for retries and recovery polling.

/** Exponential backoff with "full jitter" (AWS architecture blog): uniform in [0, min(cap, base·2^n)]. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(rand() * exp);
}

/** Deterministic schedule (no jitter) for status polling of unknown outcomes. */
export const RECOVERY_SCHEDULE_MS = [15_000, 60_000, 300_000, 900_000, 3_600_000, 10_800_000, 43_200_000];

/** After this long without a definitive provider answer, finance must look at it. */
export const RECOVERY_DEADLINE_MS = 72 * 3_600_000;

export function nextRecoveryAt(checksDone: number, now: number): number | null {
  const step = RECOVERY_SCHEDULE_MS[checksDone];
  return step === undefined ? null : now + step;
}

/** Customer-action flows (redirect, STK push) expire if never completed. */
export const REQUIRES_ACTION_TTL_MS = 24 * 3_600_000;
