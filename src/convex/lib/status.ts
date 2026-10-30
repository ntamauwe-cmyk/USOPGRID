// Public status page rules (pure, unit-tested).
//
// Every 5 minutes the platform records a sample of its own health. The
// public page shows the current sample, provider health measured from real
// live traffic, and a 90-day history built from daily rollups. Nothing here
// exposes tenant data: only states, never volumes or amounts.

export type ComponentState = "operational" | "degraded" | "outage";

export const SAMPLE_INTERVAL_MS = 5 * 60_000;
export const SAMPLES_PER_DAY = (24 * 60 * 60_000) / SAMPLE_INTERVAL_MS; // 288
export const HISTORY_DAYS = 90;
/** A queued webhook or recovery check this late means our own queue is behind. */
export const OVERDUE_MS = 10 * 60_000;
/** Provider health needs enough live attempts to say anything. */
export const PROVIDER_WINDOW_MS = 30 * 60_000;
export const PROVIDER_MIN_ATTEMPTS = 20;

/** Failures that point at the provider, not at the customer or the card. */
const PROVIDER_FAULTS = new Set(["timeout", "temporary_provider_failure", "network_error", "provider_outage", "rate_limited"]);

export function isProviderFault(status: string, failureCategory?: string): boolean {
  if (status === "unknown") return true;
  return (status === "failed" || status === "declined") && !!failureCategory && PROVIDER_FAULTS.has(failureCategory);
}

export function providerState(attempts: number, providerFaults: number): ComponentState | null {
  if (attempts < PROVIDER_MIN_ATTEMPTS) return null; // not enough evidence to publish anything
  const rate = providerFaults / attempts;
  if (rate >= 0.5) return "outage";
  if (rate >= 0.1) return "degraded";
  return "operational";
}

export function queueState(overdue: number): ComponentState {
  if (overdue >= 100) return "outage";
  if (overdue > 0) return "degraded";
  return "operational";
}

const RANK: Record<ComponentState, number> = { operational: 0, degraded: 1, outage: 2 };
export function worst(...states: ComponentState[]): ComponentState {
  return states.reduce<ComponentState>((w, s) => (RANK[s] > RANK[w] ? s : w), "operational");
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Uptime for one day: healthy samples over the 5-minute intervals that day.
 * Intervals with no sample count as down (the platform could not even
 * record its own health). Measuring starts at `sinceAt` (the first sample
 * ever) and stops at `now` for today. Returns null before monitoring began.
 */
export function dayUptime(okSamples: number, day: string, now: number, sinceAt: number): number | null {
  const start = Date.parse(`${day}T00:00:00Z`);
  const from = Math.max(start, sinceAt);
  const to = Math.min(start + 86_400_000, now);
  if (to <= from) return null;
  const expected = Math.max(1, Math.round((to - from) / SAMPLE_INTERVAL_MS));
  return Math.min(1, okSamples / expected);
}
