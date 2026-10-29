// Payment integrity end to end: real HTTP API, payment engine, routing,
// sandbox rails, ledger, idempotency, recovery and access controls, against
// an in-memory Convex backend.
import { describe, expect, test, vi, afterEach } from "vitest";
import { internal } from "../convex/_generated/api";
import { sha256Hex } from "../convex/lib/crypto";
import { api, setup, TEST_KEY } from "./setup";

const pay = (overrides: Record<string, unknown> = {}) => ({ amount: 2_500_000, currency: "NGN", payment_method: "card", country: "NG", customer: { email: "ada@example.com" }, ...overrides });

afterEach(() => vi.useRealTimers());

describe("payment processing", () => {
  test("success posts balanced ledger entries", async () => {
    const { t } = await setup();
    const r = await api(t, "POST", "/payments", pay({ reference: "order-1" }));
    expect(r.status).toBe(201);
    expect(r.data.payment.status).toBe("SUCCESSFUL");
    const entries = await t.run((ctx) => ctx.db.query("ledgerEntries").collect());
    const sum = (d: string) => entries.filter((e) => e.direction === d).reduce((n, e) => n + e.amountMinor, 0);
    expect(entries.length).toBeGreaterThan(0);
    expect(sum("debit")).toBe(sum("credit"));
  });

  test("provider outage fails over to the backup rail safely", async () => {
    const { t } = await setup();
    const r = await api(t, "POST", "/payments", pay({ metadata: { simulate: "failover" } }));
    expect(r.data.payment.status).toBe("SUCCESSFUL");
    expect(r.data.payment.attempts).toBe(2);
    expect(r.data.payment.failovers).toBe(1);
  });

  test("a decline is final and is never retried elsewhere", async () => {
    const { t } = await setup();
    const r = await api(t, "POST", "/payments", pay({ metadata: { simulate: "insufficient_funds" } }));
    expect(r.data.payment.status).toBe("DECLINED");
    expect(r.data.payment.attempts).toBe(1);
    expect(r.data.payment.failure.category).toBe("insufficient_funds");
  });

  test("a timeout is never treated as failure or re-sent: it stays unknown until recovery confirms it", async () => {
    const { t } = await setup();
    const r = await api(t, "POST", "/payments", pay({ metadata: { simulate: "timeout" } }));
    expect(r.data.payment.status).toBe("PENDING");
    expect(r.data.payment.outcome_unknown).toBe(true);
    expect(r.data.payment.attempts).toBe(1);
    // Later: the recovery job asks the same provider and finds it succeeded.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await t.action(internal.recovery.runDue, {});
    const got = await api(t, "GET", `/payments/${r.data.payment.id}`);
    expect(got.data.payment.status).toBe("SUCCESSFUL");
    expect(await t.run((ctx) => ctx.db.query("paymentAttempts").collect())).toHaveLength(1);
  });
});

describe("duplicate protection", () => {
  test("an Idempotency-Key replay returns the original payment, not a second charge", async () => {
    const { t } = await setup();
    const h = { "Idempotency-Key": "checkout-7781" };
    const a = await api(t, "POST", "/payments", pay({ reference: "order-7781" }), h);
    const b = await api(t, "POST", "/payments", pay({ reference: "order-7781" }), h);
    expect(b.status).toBe(201);
    expect(b.data.payment.id).toBe(a.data.payment.id);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toHaveLength(1);
  });

  test("reusing a key with a different body is refused", async () => {
    const { t } = await setup();
    const h = { "Idempotency-Key": "checkout-9" };
    await api(t, "POST", "/payments", pay({ reference: "o9" }), h);
    const r = await api(t, "POST", "/payments", pay({ reference: "o9", amount: 1 }), h);
    expect(r.status).toBe(422);
    expect(r.json?.error?.code).toBe("idempotency_conflict");
  });

  test("simultaneous identical requests create exactly one payment", async () => {
    const { t } = await setup();
    const h = { "Idempotency-Key": "burst-1" };
    const results = await Promise.all(Array.from({ length: 5 }, () => api(t, "POST", "/payments", pay({ reference: "burst-1" }), h)));
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(new Set(ok.map((r) => r.data.payment.id)).size).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toHaveLength(1);
  });

  test("a merchant reference cannot be charged twice", async () => {
    const { t } = await setup();
    await api(t, "POST", "/payments", pay({ reference: "inv-1" }));
    const r = await api(t, "POST", "/payments", pay({ reference: "inv-1" }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toHaveLength(1);
  });
});

describe("refunds", () => {
  test("partial refunds work and over-refunding is refused", async () => {
    const { t } = await setup();
    const p = await api(t, "POST", "/payments", pay());
    const id = p.data.payment.id;
    const r1 = await api(t, "POST", `/payments/${id}/refund`, { amount: 1_000_000 });
    expect(r1.status).toBeLessThan(300);
    const r2 = await api(t, "POST", `/payments/${id}/refund`, { amount: 2_000_000 });
    expect(r2.status).toBeGreaterThanOrEqual(400);
    const got = await api(t, "GET", `/payments/${id}`);
    expect(got.data.payment.refunded_amount).toBe(1_000_000);
  });
});

describe("access control", () => {
  test("another organization cannot read this organization's payment", async () => {
    const { t } = await setup();
    const p = await api(t, "POST", "/payments", pay());
    const otherKey = "sk_sandbox_other_org_0000000000000000000000";
    await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "Other", slug: "other", environment: "sandbox", status: "active" });
      await ctx.db.insert("merchants", { orgId, name: "Other", status: "active", defaultCurrency: "NGN", feeBps: 0, feeFixedMinor: 0 });
      await ctx.db.insert("apiKeys", { orgId, environment: "sandbox", mode: "secret", name: "x", prefix: "sk_sandbox_other", hash: await sha256Hex(otherKey), status: "active", createdAt: Date.now() });
    });
    const r = await api(t, "GET", `/payments/${p.data.payment.id}`, undefined, {}, otherKey);
    expect(r.status).toBe(404);
  });

  test("read-only keys can read but cannot create payments", async () => {
    const { t, keyId } = await setup();
    await t.run((ctx) => ctx.db.patch(keyId, { scope: "read_only" }));
    expect((await api(t, "GET", "/payments")).status).toBe(200);
    const r = await api(t, "POST", "/payments", pay());
    expect(r.status).toBe(403);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toHaveLength(0);
  });

  test("IP allowlists use the proxy-appended address and ignore forged entries", async () => {
    const { t, keyId } = await setup();
    await t.run((ctx) => ctx.db.patch(keyId, { allowedIps: ["203.0.113.0/24"] }));
    const forged = await api(t, "POST", "/payments", pay(), { "X-Forwarded-For": "203.0.113.9, 198.51.100.4" });
    expect(forged.status).toBe(403);
    const ok = await api(t, "POST", "/payments", pay(), { "X-Forwarded-For": "198.51.100.4, 203.0.113.9" });
    expect(ok.status).toBe(201);
    const who = await api(t, "GET", "/whoami", undefined, { "X-Forwarded-For": "203.0.113.9" });
    expect(who.data.client_ip).toBe("203.0.113.9");
  });

  test("revoked and unknown keys are refused", async () => {
    const { t, keyId } = await setup();
    expect((await api(t, "GET", "/payments", undefined, {}, "sk_sandbox_nope")).status).toBe(401);
    await t.run((ctx) => ctx.db.patch(keyId, { status: "revoked" }));
    expect((await api(t, "GET", "/payments", undefined, {}, TEST_KEY)).status).toBe(401);
  });
});
