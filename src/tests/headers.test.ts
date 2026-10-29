// The hosting configs must carry exactly the reviewed security headers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const spec = JSON.parse(readFileSync(new URL("deploy/security-headers.json", root), "utf8")).headers as Record<string, string>;

describe("security headers", () => {
  test("policy forbids framing, plugins and foreign scripts", () => {
    const csp = spec["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).not.toContain("unsafe-eval");
    expect(spec["X-Frame-Options"]).toBe("DENY");
    expect(spec["Strict-Transport-Security"]).toContain("max-age=63072000");
  });
  test("public/_headers matches the spec", () => {
    const text = readFileSync(new URL("public/_headers", root), "utf8");
    for (const [k, v] of Object.entries(spec)) expect(text).toContain(`  ${k}: ${v}`);
  });
  test("vercel.json matches the spec", () => {
    const cfg = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
    const got = Object.fromEntries(cfg.headers[0].headers.map((h: { key: string; value: string }) => [h.key, h.value]));
    expect(got).toEqual(spec);
  });
});
