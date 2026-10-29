// USOPGRID cryptography — Web Crypto only (works in the Convex V8 runtime,
// browsers, Bun and Node). No hand-rolled primitives: HMAC, SHA-2, AES-GCM and
// random generation all come from crypto.subtle / getRandomValues.
//
// - API keys are stored ONLY as SHA-256 hashes; full keys are shown once.
// - Provider credentials and MFA secrets are sealed with AES-256-GCM under
//   USOPGRID_ENCRYPTION_KEY (32 bytes, base64) and never returned to clients.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type HashAlgo = "SHA-1" | "SHA-256" | "SHA-512";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

async function hmacRaw(algo: HashAlgo, key: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: algo }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, payload as BufferSource));
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  return bytesToHex(await hmacRaw("SHA-256", encoder.encode(secret), encoder.encode(payload)));
}

export async function hmacHex(algo: HashAlgo, secret: string, payload: string): Promise<string> {
  return bytesToHex(await hmacRaw(algo, encoder.encode(secret), encoder.encode(payload)));
}

/** HMAC with a key given as raw bytes (e.g. Adyen's hex-encoded HMAC key), base64 output. */
export async function hmacBase64WithKeyBytes(algo: HashAlgo, key: Uint8Array, payload: string): Promise<string> {
  return bytesToBase64(await hmacRaw(algo, key, encoder.encode(payload)));
}

export async function hmacBase64(algo: HashAlgo, secret: string, payload: string): Promise<string> {
  return bytesToBase64(await hmacRaw(algo, encoder.encode(secret), encoder.encode(payload)));
}

/** Constant-time string comparison to avoid timing oracles on secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Cryptographically secure random string (base62, rejection-sampled — no modulo bias). */
export function randomToken(length = 32): string {
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248) out += ALPHABET[b % 62]; // 248 = 4 * 62
      if (out.length === length) break;
    }
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// AES-256-GCM envelope for secrets at rest. Format: "v1.<iv b64>.<ct b64>".
// The AAD binds a ciphertext to its owner (e.g. connection id) so a sealed
// value cannot be copied onto another record and decrypted there.
// ---------------------------------------------------------------------------
async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error("USOPGRID_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealSecret(plaintext: string, keyB64: string, aad: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function openSecret(sealed: string, keyB64: string, aad: string): Promise<string> {
  const [ver, ivB64, ctB64] = sealed.split(".");
  if (ver !== "v1" || !ivB64 || !ctB64) throw new Error("unsupported sealed secret format");
  const key = await importAesKey(keyB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) as BufferSource, additionalData: encoder.encode(aad) },
    key,
    base64ToBytes(ctB64) as BufferSource,
  );
  return decoder.decode(pt);
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — 6 digits, 30 s step, HMAC-SHA1 (authenticator-app default)
// ---------------------------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function totpAt(secretB32: string, unixSeconds: number, step = 30, digits = 6): Promise<string> {
  const counter = Math.floor(unixSeconds / step);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = await hmacRaw("SHA-1", base32Decode(secretB32), msg);
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** Verify with ±1 step tolerance for clock drift. Returns the matched counter (for replay protection) or null. */
export async function verifyTotp(secretB32: string, code: string, nowMs: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const t = Math.floor(nowMs / 1000);
  for (const drift of [0, -1, 1]) {
    const at = t + drift * 30;
    if (timingSafeEqual(await totpAt(secretB32, at), code)) return Math.floor(at / 30);
  }
  return null;
}
