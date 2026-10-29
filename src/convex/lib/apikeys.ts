// USOPGRID API key infrastructure.
// - Full key generated once, shown once, stored only as SHA-256 hash.
// - Prefix stored for lookup/display ("sk_sandbox_a1b2…").
// - Environment separation enforced at key level: sandbox keys never touch
//   production providers and vice versa.

import { sha256Hex, randomToken } from "./crypto";

export type KeyEnvironment = "sandbox" | "production";

export interface GeneratedKey {
  full: string; // shown exactly once
  prefix: string; // stored for lookup/display
}

export function generateApiKey(env: KeyEnvironment, mode: "secret" | "publishable"): GeneratedKey {
  const prefixTag = mode === "secret" ? "sk" : "pk";
  const envTag = env === "sandbox" ? "sandbox" : "live";
  const prefix = `${prefixTag}_${envTag}_${randomToken(6)}`;
  const full = `${prefix}_${randomToken(28)}`;
  return { full, prefix };
}

export async function hashApiKey(full: string): Promise<string> {
  return sha256Hex(full);
}
