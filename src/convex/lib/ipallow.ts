// IP allowlists for API keys: IPv4 and IPv6 addresses and CIDR ranges.

export type ParsedRule = { v: 4 | 6; net: bigint; bits: number };

function parseV4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255 || (m[i].length > 1 && m[i].startsWith("0"))) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.split("::").length > 2) return null;
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    s = s.slice(0, lastColon + 1) + (s.endsWith("::") ? "" : "0");
    s = s.replace(/:0$/, "");
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const groupsNeeded = 8 - tail.length;
  if (rest === undefined && h.length !== groupsNeeded) return null;
  if (h.length + r.length > groupsNeeded) return null;
  const fill = rest === undefined ? [] : Array(groupsNeeded - h.length - r.length).fill("0");
  const parts = [...h, ...fill, ...r];
  if (parts.length !== groupsNeeded) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    n = (n << 16n) | BigInt(parseInt(p, 16));
  }
  for (const t of tail) n = (n << 16n) | BigInt(t);
  return n;
}

export function parseIp(s: string): { v: 4 | 6; n: bigint } | null {
  const t = s.trim();
  const v4 = parseV4(t);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(t);
  if (v6 === null) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as the IPv4 address.
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

/** Parse "203.0.113.7", "203.0.113.0/24", "2001:db8::/32". Returns null if invalid. */
export function parseRule(rule: string): ParsedRule | null {
  const [addr, bitsStr, extra] = rule.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? max : /^\d{1,3}$/.test(bitsStr) ? Number(bitsStr) : NaN;
  if (!Number.isInteger(bits) || bits < (ip.v === 4 ? 8 : 16) || bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v: ip.v, net: ip.n & mask, bits };
}

export function ipAllowed(ip: string | null, rules: readonly string[]): boolean {
  if (rules.length === 0) return true;
  if (!ip) return false;
  const a = parseIp(ip);
  if (!a) return false;
  for (const r of rules) {
    const p = parseRule(r);
    if (!p || p.v !== a.v) continue;
    const max = p.v === 4 ? 32 : 128;
    const mask = ((1n << BigInt(p.bits)) - 1n) << BigInt(max - p.bits);
    if ((a.n & mask) === p.net) return true;
  }
  return false;
}

/** Validate and normalise a user-supplied list. Throws with a readable message. */
export function normaliseRules(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const r = raw.trim();
    if (!r) continue;
    if (!parseRule(r)) throw new Error(`"${r}" is not a valid IP address or range (examples: 203.0.113.7, 203.0.113.0/24, 2001:db8::/48; ranges no wider than /8 or /16).`);
    if (!out.includes(r)) out.push(r);
  }
  if (out.length > 50) throw new Error("At most 50 addresses or ranges per key.");
  return out;
}

const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"];
const PRIVATE_V6 = ["::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];

function inRanges(ip: string, ranges: string[]): boolean {
  const a = parseIp(ip);
  if (!a) return false;
  for (const r of ranges) {
    const [addr, bitsS] = r.split("/");
    const n = parseIp(addr);
    if (!n || n.v !== a.v) continue;
    const max = a.v === 4 ? 32 : 128;
    const bits = Number(bitsS);
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
    if ((a.n & mask) === (n.n & mask)) return true;
  }
  return false;
}

/**
 * Server-side request forgery guard for user-supplied callback URLs: HTTPS,
 * public hostnames only, no credentials, no private/loopback/link-local IPs.
 */
export function unsafeCallbackUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "must be a valid absolute URL";
  }
  if (u.protocol !== "https:") return "must use HTTPS";
  if (u.username || u.password) return "must not contain credentials";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host) || !host.includes(".") && !host.includes(":")) return "must use a public host name";
  if (parseIp(host) && (inRanges(host, PRIVATE_V4) || inRanges(host, PRIVATE_V6))) return "must not point to a private or internal address";
  if (u.port && !["443", "8443"].includes(u.port)) return "must use port 443 or 8443";
  return null;
}
