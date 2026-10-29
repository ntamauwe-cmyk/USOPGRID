import { describe, expect, test } from "bun:test";
import { loadKeyring, seal, open, needsReseal, sealedKeyId } from "../convex/lib/keyring";
import { sealSecret } from "../convex/lib/crypto";

const b64 = (n: number) => Buffer.from(new Uint8Array(32).fill(n)).toString("base64");

describe("keyring", () => {
  test("legacy single key is k0 and opens v1 ciphertexts", async () => {
    const ring = loadKeyring({ USOPGRID_ENCRYPTION_KEY: b64(1) })!;
    expect(ring.activeId).toBe("k0");
    const legacy = await sealSecret("secret", b64(1), "aad");
    expect(sealedKeyId(legacy)).toBe("k0");
    expect(await open(legacy, "aad", ring)).toBe("secret");
  });
  test("rotation: new key seals, old key still opens, needsReseal flags old values", async () => {
    const old = loadKeyring({ USOPGRID_ENCRYPTION_KEY: b64(1) })!;
    const before = await seal("acct-123", "beneficiary:x", old);
    const ring = loadKeyring({ USOPGRID_ENCRYPTION_KEY: b64(1), USOPGRID_ENCRYPTION_KEYS: `k2:${b64(2)}` })!;
    expect(ring.activeId).toBe("k2");
    expect(needsReseal(before, ring)).toBe(true);
    const after = await seal(await open(before, "beneficiary:x", ring), "beneficiary:x", ring);
    expect(after.startsWith("v2.k2.")).toBe(true);
    expect(needsReseal(after, ring)).toBe(false);
    // Once k0 is removed, only re-sealed values remain readable.
    const newOnly = loadKeyring({ USOPGRID_ENCRYPTION_KEYS: `k2:${b64(2)}` })!;
    expect(await open(after, "beneficiary:x", newOnly)).toBe("acct-123");
    await expect(open(before, "beneficiary:x", newOnly)).rejects.toThrow();
  });
  test("ciphertext is bound to its record (AAD) and to its key id", async () => {
    const ring = loadKeyring({ USOPGRID_ENCRYPTION_KEYS: `k1:${b64(3)},k2:${b64(4)}`, USOPGRID_ENCRYPTION_KEY_ID: "k1" })!;
    const s = await seal("x", "conn:A", ring);
    await expect(open(s, "conn:B", ring)).rejects.toThrow();
    await expect(open(s.replace("v2.k1.", "v2.k2."), "conn:A", ring)).rejects.toThrow();
  });
  test("misconfiguration fails loudly", () => {
    expect(() => loadKeyring({ USOPGRID_ENCRYPTION_KEYS: "nonsense" })).toThrow();
    expect(() => loadKeyring({ USOPGRID_ENCRYPTION_KEYS: `k1:${b64(1)}`, USOPGRID_ENCRYPTION_KEY_ID: "k9" })).toThrow();
    expect(loadKeyring({})).toBeNull();
  });
});
