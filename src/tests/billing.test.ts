import { describe, expect, test } from "bun:test";
import { addInterval, isRetryableRenewalFailure, nextRetryAt, DUNNING_DAYS } from "../convex/lib/billing";
import { unsafeCallbackUrl } from "../convex/lib/ipallow";

const D = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString().slice(0, 10);

describe("billing calendar", () => {
  test("monthly renewals keep the billing day and clamp to short months", () => {
    let t = D("2026-01-31T09:00:00Z");
    const seen = [];
    for (let i = 0; i < 4; i++) {
      t = addInterval(t, "month", 1, 31);
      seen.push(iso(t));
    }
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });
  test("leap years, yearly, weekly, daily and multi-period intervals", () => {
    expect(iso(addInterval(D("2028-02-29T00:00:00Z"), "year", 1, 29))).toBe("2029-02-28");
    expect(iso(addInterval(D("2026-10-29T00:00:00Z"), "week", 2))).toBe("2026-11-12");
    expect(iso(addInterval(D("2026-10-29T00:00:00Z"), "day", 3))).toBe("2026-11-01");
    expect(iso(addInterval(D("2026-11-15T00:00:00Z"), "month", 3, 15))).toBe("2027-02-15");
    expect(() => addInterval(0, "month", 0)).toThrow();
  });
});

describe("renewal retries", () => {
  test("recoverable failures retry on days 1, 3, 5, 7 then stop", () => {
    const now = D("2026-10-29T00:00:00Z");
    expect(DUNNING_DAYS.map((_, i) => iso(nextRetryAt(i + 1, now)!))).toEqual(["2026-10-30", "2026-11-01", "2026-11-03", "2026-11-05"]);
    expect(nextRetryAt(DUNNING_DAYS.length + 1, now)).toBeNull();
  });
  test("hard declines are never retried", () => {
    expect(isRetryableRenewalFailure("insufficient_funds")).toBe(true);
    expect(isRetryableRenewalFailure("provider_outage")).toBe(true);
    for (const c of ["invalid_payment_information", "fraud_rejection", "compliance_block", "unsupported", "configuration_error", undefined]) expect(isRetryableRenewalFailure(c)).toBe(false);
  });
});

describe("webhook URL safety (SSRF)", () => {
  test("public HTTPS endpoints are accepted", () => {
    expect(unsafeCallbackUrl("https://api.merchant.com/hooks/usopgrid")).toBeNull();
    expect(unsafeCallbackUrl("https://hooks.example.ng:8443/x")).toBeNull();
  });
  test("internal, private, credentialed or plain-HTTP targets are refused", () => {
    for (const u of ["http://api.merchant.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x", "https://192.168.1.10/x", "https://[::1]/x", "https://[fd00::1]/x", "https://user:pass@api.merchant.com/x", "https://intranet/x", "https://db.internal/x", "https://api.merchant.com:22/x", "not a url"]) {
      expect(unsafeCallbackUrl(u)).not.toBeNull();
    }
  });
});
