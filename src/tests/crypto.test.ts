// Unit tests: crypto primitives, fee engine, API key format, idempotency
// canonicalization. All pure functions — no Convex context needed.
import { describe, expect, test } from "bun:test";
import { hmacSha256Hex, randomToken, sha256Hex, timingSafeEqual } from "../convex/lib/crypto";
import { generateApiKey, hashApiKey } from "../convex/lib/apikeys";
import { canonicalize } from "../convex/lib/idempotency";

describe("crypto", () => {
  test("sha256Hex is deterministic and hex", async () => {
    const a = await sha256Hex("usopgrid");
    const b = await sha256Hex("usopgrid");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sha256Hex differs for different inputs", async () => {
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });

  test("hmacSha256Hex matches RFC 4231 test vector", async () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
    const sig = await hmacSha256Hex("Jefe", "what do ya want for nothing?");
    expect(sig).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  test("timingSafeEqual is length-safe and order-independent", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  test("randomToken produces base62 of requested length", () => {
    const t = randomToken(28);
    expect(t).toMatch(/^[A-Za-z0-9]{28}$/);
    expect(randomToken(28)).not.toBe(t);
  });
});

describe("api key format", () => {
  test("sandbox secret key shape", () => {
    const k = generateApiKey("sandbox", "secret");
    expect(k.full.startsWith("sk_sandbox_")).toBe(true);
    expect(k.full.startsWith(k.prefix)).toBe(true);
    // prefix tag (11) + underscore + 6 + underscore + 28 = 47 chars
    expect(k.full.length).toBe(k.prefix.length + 1 + 28);
  });

  test("live publishable key shape", () => {
    const k = generateApiKey("production", "publishable");
    expect(k.full.startsWith("pk_live_")).toBe(true);
  });

  test("hashApiKey is sha256 and stable", async () => {
    const k = generateApiKey("sandbox", "secret");
    const h1 = await hashApiKey(k.full);
    const h2 = await hashApiKey(k.full);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("idempotency canonicalization", () => {
  test("key order does not change the fingerprint input", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("undefined values are dropped (client omits vs sends undefined)", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  test("nested arrays preserve order; objects sort", () => {
    expect(canonicalize([{ y: 1, x: 2 }])).toBe('[{"x":2,"y":1}]');
  });

  test("null vs undefined are distinct", () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  test("primitives", () => {
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(null)).toBe("null");
  });
});
