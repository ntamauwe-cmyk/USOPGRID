import { describe, expect, test } from "bun:test";
import { ipAllowed, normaliseRules, parseIp, parseRule } from "../convex/lib/ipallow";
import { trustedClientIp } from "../convex/lib/httpservice";
import { ssoProviders } from "../convex/lib/sso";

describe("IP allowlists", () => {
  test("parses IPv4, IPv6, mapped IPv4 and rejects junk", () => {
    expect(parseIp("203.0.113.7")?.v).toBe(4);
    expect(parseIp("2001:db8::1")?.v).toBe(6);
    expect(parseIp("::ffff:203.0.113.7")).toEqual(parseIp("203.0.113.7"));
    for (const bad of ["256.1.1.1", "1.2.3", "01.2.3.4", "2001:db8:::1", "hello", ""]) expect(parseIp(bad)).toBeNull();
  });
  test("matches exact addresses and CIDR ranges, both families", () => {
    const rules = ["203.0.113.7", "198.51.100.0/24", "2001:db8:abcd::/48"];
    expect(ipAllowed("203.0.113.7", rules)).toBe(true);
    expect(ipAllowed("203.0.113.8", rules)).toBe(false);
    expect(ipAllowed("198.51.100.254", rules)).toBe(true);
    expect(ipAllowed("198.51.101.1", rules)).toBe(false);
    expect(ipAllowed("2001:db8:abcd:12::5", rules)).toBe(true);
    expect(ipAllowed("2001:db8:abce::5", rules)).toBe(false);
    expect(ipAllowed("::ffff:198.51.100.9", rules)).toBe(true);
  });
  test("empty list allows any address; a list with no client address refuses", () => {
    expect(ipAllowed(null, [])).toBe(true);
    expect(ipAllowed(null, ["203.0.113.7"])).toBe(false);
  });
  test("over-broad or malformed rules are rejected with a readable message", () => {
    expect(parseRule("0.0.0.0/0")).toBeNull();
    expect(parseRule("10.0.0.0/7")).toBeNull();
    expect(parseRule("::/0")).toBeNull();
    expect(() => normaliseRules(["203.0.113.0/24", "nonsense"])).toThrow(/not a valid IP/);
    expect(normaliseRules([" 203.0.113.7 ", "", "203.0.113.7"])).toEqual(["203.0.113.7"]);
  });
  test("security decisions use the proxy-appended address, not a forged first entry", () => {
    const req = new Request("https://x", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" } });
    expect(trustedClientIp(req)).toBe("203.0.113.7");
  });
});

describe("enterprise single sign-on", () => {
  test("providers switch on only with complete, HTTPS settings", () => {
    expect(ssoProviders({})).toEqual([]);
    expect(ssoProviders({ AUTH_GOOGLE_ID: "a" })).toEqual([]);
    expect(ssoProviders({ AUTH_GOOGLE_ID: "a", AUTH_GOOGLE_SECRET: "b" }).map((p) => p.id)).toEqual(["google"]);
    expect(ssoProviders({ AUTH_OKTA_ID: "a", AUTH_OKTA_SECRET: "b", AUTH_OKTA_ISSUER: "http://insecure" })).toEqual([]);
    expect(ssoProviders({ AUTH_OIDC_ID: "a", AUTH_OIDC_SECRET: "b", AUTH_OIDC_ISSUER: "https://idp.example.com", AUTH_OIDC_NAME: "Acme SSO" })).toEqual([{ id: "oidc", label: "Acme SSO" }]);
  });
});
