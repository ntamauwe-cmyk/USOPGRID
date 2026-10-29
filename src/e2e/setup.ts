// Shared fixtures for end-to-end tests: an organization with an owner, a
// merchant, a sandbox API key, and helpers for signed-in calls.
/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import schema from "../convex/schema";
import { sha256Hex } from "../convex/lib/crypto";
import type { Id } from "../convex/_generated/dataModel";

export const modules = import.meta.glob("../convex/**/*.ts");

export const TEST_KEY = "sk_sandbox_e2e_0123456789abcdefghijklmnopqrstuv";

export function env() {
  process.env.USOPGRID_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  process.env.CONVEX_SITE_URL = "https://e2e.convex.site";
}

export async function setup(opts: { environment?: "sandbox" | "production" } = {}) {
  env();
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner", email: "owner@acme.test" });
    const finance = await ctx.db.insert("users", { name: "Finance", email: "finance@acme.test" });
    const orgId = await ctx.db.insert("organizations", { name: "Acme Ltd", slug: "acme", environment: opts.environment ?? "sandbox", status: "active", country: "NG" });
    await ctx.db.insert("orgMembers", { orgId, userId: owner, role: "owner", joinedAt: Date.now() });
    await ctx.db.insert("orgMembers", { orgId, userId: finance, role: "finance", joinedAt: Date.now() });
    const merchantId = await ctx.db.insert("merchants", { orgId, name: "Acme", status: "active", defaultCurrency: "NGN", feeBps: 150, feeFixedMinor: 0 });
    const keyHash = await sha256Hex(TEST_KEY);
    const keyId = await ctx.db.insert("apiKeys", { orgId, environment: "sandbox", mode: "secret", name: "e2e", prefix: TEST_KEY.slice(0, 16), hash: keyHash, status: "active", createdAt: Date.now() });
    return { owner, finance, orgId, merchantId, keyId };
  });
  const asUser = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session_${userId}`, issuer: "https://e2e.convex.site" });
  return { t, ...ids, asUser };
}

type T = TestConvex<typeof schema>;

export async function api(t: T, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = TEST_KEY) {
  const res = await t.fetch(`/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { status: string; data?: Record<string, unknown>; error?: { code: string; message: string } } | null;
  // Response bodies are asserted field by field in tests; loose typing keeps them readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json, data: (json?.data ?? {}) as Record<string, any> };
}

/** Enrol and freshly confirm an authenticator for a user (as if they just entered a code). */
export async function stepUp(t: T, userId: Id<"users">) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const doc = { userId, sealedSecret: "test", status: "enabled" as const, verifiedUntil: Date.now() + 10 * 60_000, createdAt: Date.now(), enabledAt: Date.now() };
    if (row) await ctx.db.replace(row._id, doc);
    else await ctx.db.insert("userMfa", doc);
  });
}
