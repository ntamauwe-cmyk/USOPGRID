// Encryption keyring for secrets at rest (provider credentials, MFA secrets,
// payout account numbers).
//
// Configuration (Convex environment variables):
//   USOPGRID_ENCRYPTION_KEYS    "k1:<base64 32 bytes>,k2:<base64 32 bytes>"  (optional)
//   USOPGRID_ENCRYPTION_KEY_ID  id of the key used for NEW encryptions        (optional)
//   USOPGRID_ENCRYPTION_KEY     legacy single key, available as id "k0"
//
// Ciphertext formats:
//   v1.<iv>.<ct>          legacy, sealed with USOPGRID_ENCRYPTION_KEY ("k0")
//   v2.<kid>.<iv>.<ct>    sealed with keyring key <kid>
//
// Rotation: add the new key to USOPGRID_ENCRYPTION_KEYS, point
// USOPGRID_ENCRYPTION_KEY_ID at it, run Operations → Re-encrypt secrets, then
// remove the old key once the console reports nothing left on it.
import { sealSecret, openSecret } from "./crypto";

export interface Keyring {
  activeId: string;
  keys: Map<string, string>;
}

const ID_RE = /^[a-z0-9_-]{1,16}$/;

export function loadKeyring(env: Record<string, string | undefined> = process.env): Keyring | null {
  const keys = new Map<string, string>();
  if (env.USOPGRID_ENCRYPTION_KEY) keys.set("k0", env.USOPGRID_ENCRYPTION_KEY.trim());
  let lastListed: string | null = null;
  for (const part of (env.USOPGRID_ENCRYPTION_KEYS ?? "").split(",")) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    const id = t.slice(0, i).trim();
    const key = t.slice(i + 1).trim();
    if (i <= 0 || !ID_RE.test(id) || !key) throw new Error("USOPGRID_ENCRYPTION_KEYS must look like 'k1:<base64>,k2:<base64>'");
    if (id === "k0" && keys.has("k0") && keys.get("k0") !== key) throw new Error("Key id k0 is reserved for USOPGRID_ENCRYPTION_KEY");
    keys.set(id, key);
    lastListed = id;
  }
  if (keys.size === 0) return null;
  const activeId = env.USOPGRID_ENCRYPTION_KEY_ID?.trim() || lastListed || "k0";
  if (!keys.has(activeId)) throw new Error(`USOPGRID_ENCRYPTION_KEY_ID '${activeId}' is not in the keyring`);
  return { activeId, keys };
}

export function keyringConfigured(): boolean {
  try {
    return loadKeyring() !== null;
  } catch {
    return false;
  }
}

function requireRing(ring?: Keyring | null): Keyring {
  const r = ring ?? loadKeyring();
  if (!r) throw new Error("Encryption is not configured (set USOPGRID_ENCRYPTION_KEY or USOPGRID_ENCRYPTION_KEYS).");
  return r;
}

/** Key id a sealed value was encrypted with. */
export function sealedKeyId(sealed: string): string {
  if (sealed.startsWith("v1.")) return "k0";
  const [ver, kid] = sealed.split(".");
  if (ver !== "v2" || !kid) throw new Error("unsupported sealed secret format");
  return kid;
}

export async function seal(plaintext: string, aad: string, ring?: Keyring | null): Promise<string> {
  const r = requireRing(ring);
  const v1 = await sealSecret(plaintext, r.keys.get(r.activeId)!, aad);
  return `v2.${r.activeId}.${v1.slice(3)}`;
}

export async function open(sealed: string, aad: string, ring?: Keyring | null): Promise<string> {
  const r = requireRing(ring);
  const kid = sealedKeyId(sealed);
  const key = r.keys.get(kid);
  if (!key) throw new Error(`Encryption key '${kid}' is no longer configured`);
  const body = kid === "k0" && sealed.startsWith("v1.") ? sealed : `v1.${sealed.split(".").slice(2).join(".")}`;
  return openSecret(body, key, aad);
}

/** True when the value is not sealed with the active key (needs re-encryption). */
export function needsReseal(sealed: string, ring?: Keyring | null): boolean {
  return sealedKeyId(sealed) !== requireRing(ring).activeId;
}
