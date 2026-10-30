import { describe, expect, test } from "bun:test";
import { dayUptime, isProviderFault, providerState, queueState, worst, PROVIDER_MIN_ATTEMPTS } from "../convex/lib/status";

describe("status rules", () => {
  test("only provider-side failures count against a provider", () => {
    expect(isProviderFault("unknown")).toBe(true);
    expect(isProviderFault("failed", "timeout")).toBe(true);
    expect(isProviderFault("failed", "provider_outage")).toBe(true);
    expect(isProviderFault("declined", "insufficient_funds")).toBe(false);
    expect(isProviderFault("declined", "issuer_decline")).toBe(false);
    expect(isProviderFault("successful")).toBe(false);
  });

  test("no provider state is published without enough evidence", () => {
    expect(providerState(PROVIDER_MIN_ATTEMPTS - 1, 0)).toBeNull();
    expect(providerState(100, 5)).toBe("operational");
    expect(providerState(100, 10)).toBe("degraded");
    expect(providerState(100, 50)).toBe("outage");
  });

  test("queues and overall state", () => {
    expect(queueState(0)).toBe("operational");
    expect(queueState(3)).toBe("degraded");
    expect(queueState(100)).toBe("outage");
    expect(worst("operational", "degraded", "operational")).toBe("degraded");
    expect(worst("operational", "outage", "degraded")).toBe("outage");
    expect(worst()).toBe("operational");
  });

  test("daily uptime counts missed checks as downtime and starts when monitoring began", () => {
    const day = "2026-10-29";
    const midnight = Date.parse(`${day}T00:00:00Z`);
    const end = midnight + 86_400_000;
    expect(dayUptime(288, day, end + 1, midnight - 1)).toBe(1);
    expect(dayUptime(144, day, end + 1, midnight - 1)).toBe(0.5);
    // Monitoring began at noon: only the afternoon is measured.
    expect(dayUptime(144, day, end + 1, midnight + 43_200_000)).toBe(1);
    // Today, two hours in, all checks healthy.
    expect(dayUptime(24, day, midnight + 2 * 3_600_000, midnight - 1)).toBe(1);
    // Before monitoring began: no data rather than a fake 100%.
    expect(dayUptime(0, day, end + 1, end + 5)).toBeNull();
  });
});
