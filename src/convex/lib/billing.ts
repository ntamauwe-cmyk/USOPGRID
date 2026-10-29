// Recurring billing rules, pure and tested: billing calendar, retry schedule
// for failed renewals ("dunning"), and which failures are worth retrying.

import type { FailureCategory } from "../providers/types";

export type Interval = "day" | "week" | "month" | "year";
export const INTERVALS: readonly Interval[] = ["day", "week", "month", "year"];

/** Days after a failed renewal on which to retry. After the last, the subscription stops. */
export const DUNNING_DAYS = [1, 3, 5, 7] as const;

const DAY = 86_400_000;

/**
 * Advance a UTC timestamp by `count` intervals. Months and years keep the
 * billing day and clamp to the month's last day (Jan 31 → Feb 28/29 → Mar 31
 * stays anchored to the original day via `anchorDay`).
 */
export function addInterval(fromMs: number, interval: Interval, count: number, anchorDay?: number): number {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("interval count must be a positive integer");
  if (interval === "day") return fromMs + count * DAY;
  if (interval === "week") return fromMs + count * 7 * DAY;
  const d = new Date(fromMs);
  const months = interval === "month" ? count : count * 12;
  const day = anchorDay ?? d.getUTCDate();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/**
 * Failures that may succeed later (funds arrive, issuer recovers). Hard
 * declines (invalid card, fraud, compliance, unsupported) are not retried:
 * repeating them annoys customers and can get a merchant flagged by schemes.
 */
export function isRetryableRenewalFailure(category: FailureCategory | string | undefined): boolean {
  return (
    category === "insufficient_funds" ||
    category === "temporary_provider_failure" ||
    category === "provider_outage" ||
    category === "timeout" ||
    category === "network_error" ||
    category === "rate_limited" ||
    category === "issuer_decline"
  );
}

/** When to retry after the Nth consecutive failure (1-based), or null to stop. */
export function nextRetryAt(failedAttempts: number, nowMs: number): number | null {
  const d = DUNNING_DAYS[failedAttempts - 1];
  return d === undefined ? null : nowMs + d * DAY;
}

export function describeInterval(interval: Interval, count: number): string {
  if (count === 1) return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[interval];
  return `Every ${count} ${interval}s`;
}
