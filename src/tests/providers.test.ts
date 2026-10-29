// Provider adapters against mocked HTTP: request shape, outcome mapping,
// ambiguity handling and webhook signature verification.
import { describe, expect, test } from "bun:test";
import { getAdapter } from "../convex/providers/index";
import type { AdapterContext } from "../convex/providers/types";
import { hmacSha256Hex, hmacHex } from "../convex/lib/crypto";

type Call = { url: string; init: RequestInit };

function mockCtx(credentials: Record<string, string>, responder: (c: Call) => Response | Promise<Response> | "timeout" | "network"): { ctx: AdapterContext; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    const r = await responder(c);
    if (r === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (r === "network") throw new TypeError("fetch failed");
    return r;
  }) as typeof fetch;
  return { ctx: { environment: "sandbox", credentials, fetch: f, now: () => Date.now(), timeoutMs: 1000, callbackBaseUrl: "https://api.example.test", connectionId: "pc_test" }, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const req = { transactionId: "txn_abc", idempotencyKey: "txn_abc:conn", amountMinor: 1050, currency: "USD", reference: "ref_1", paymentMethod: "card", customer: { email: "a@b.co" } };

describe("stripe adapter", () => {
  const stripe = getAdapter("stripe")!;
  test("sends idempotency key and form-encoded minor units; maps success", async () => {
    const { ctx, calls } = mockCtx({ secretKey: "sk_test_x" }, () => json(200, { id: "pi_1", status: "succeeded", amount: 1050, amount_received: 1050, currency: "usd" }));
    const r = await stripe.charge(ctx, { ...req, paymentToken: "pm_card_visa" });
    expect(r.status).toBe("successful");
    expect(r.providerReference).toBe("pi_1");
    expect(r.reportedAmountMinor).toBe(1050);
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe("txn_abc:conn");
    expect(String(calls[0].init.body)).toContain("amount=1050");
    expect(String(calls[0].init.body)).toContain("currency=usd");
  });
  test("402 card error is a decline with a normalized category", async () => {
    const { ctx } = mockCtx({ secretKey: "sk" }, () => json(402, { error: { code: "card_declined", decline_code: "insufficient_funds", message: "Insufficient funds", payment_intent: { id: "pi_2" } } }));
    const r = await stripe.charge(ctx, { ...req, paymentToken: "pm" });
    expect(r.status).toBe("declined");
    expect(r.failure?.category).toBe("insufficient_funds");
  });
  test("5xx and timeouts are UNKNOWN, never failed (no failover)", async () => {
    for (const resp of [() => json(503, { error: {} }), () => "timeout" as const, () => "network" as const]) {
      const { ctx } = mockCtx({ secretKey: "sk" }, resp);
      const r = await stripe.charge(ctx, req);
      expect(r.status).toBe("unknown");
      expect(r.failure?.safeToFailover).toBe(false);
    }
  });
  test("401 is a safe-to-failover configuration error", async () => {
    const { ctx } = mockCtx({ secretKey: "bad" }, () => json(401, { error: { message: "Invalid API Key" } }));
    const r = await stripe.charge(ctx, req);
    expect(r.status).toBe("failed");
    expect(r.failure?.category).toBe("configuration_error");
    expect(r.failure?.safeToFailover).toBe(true);
  });
  test("webhook signature: valid accepted, tampered and stale rejected", async () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1", status: "succeeded", amount: 1050, currency: "usd", metadata: { usopgrid_transaction_id: "txn_abc" } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacSha256Hex(secret, `${t}.${body}`);
    const ctx = { environment: "sandbox" as const, credentials: { webhookSecret: secret }, fetch, now: () => Date.now() };
    const mk = (b: string, ts: number, s: string) => ({ headers: new Headers({ "stripe-signature": `t=${ts},v1=${s}` }), rawBody: b, url: "https://x" });
    expect(await stripe.verifyWebhook(ctx, mk(body, t, sig))).toBe(true);
    expect(await stripe.verifyWebhook(ctx, mk(body.replace("1050", "9999"), t, sig))).toBe(false);
    expect(await stripe.verifyWebhook(ctx, mk(body, t - 3600, await hmacSha256Hex(secret, `${t - 3600}.${body}`)))).toBe(false);
    const [e] = stripe.parseWebhook(ctx, mk(body, t, sig));
    expect(e).toEqual(expect.objectContaining({ eventId: "evt_1", type: "payment", status: "successful", reference: "txn_abc", amountMinor: 1050, currency: "USD" }) as never);
  });
});

describe("paystack adapter", () => {
  const paystack = getAdapter("paystack")!;
  test("x-paystack-signature is HMAC-SHA512 of the raw body", async () => {
    const body = JSON.stringify({ event: "charge.success", data: { id: 1, reference: "txn_abc", amount: 1050, currency: "NGN", status: "success" } });
    const ctx = { environment: "sandbox" as const, credentials: { secretKey: "sk_test_ps" }, fetch, now: () => Date.now() };
    const good = await hmacHex("SHA-512", "sk_test_ps", body);
    expect(await paystack.verifyWebhook(ctx, { headers: new Headers({ "x-paystack-signature": good }), rawBody: body, url: "https://x" })).toBe(true);
    expect(await paystack.verifyWebhook(ctx, { headers: new Headers({ "x-paystack-signature": good.replace(/^./, "0") }), rawBody: body, url: "https://x" })).toBe(false);
  });
});

describe("checkout.com adapter", () => {
  test("cko-signature is HMAC-SHA256 with the webhook key", async () => {
    const cko = getAdapter("checkoutcom")!;
    const body = JSON.stringify({ id: "evt_c", type: "payment_captured", data: { id: "pay_1", amount: 1050, currency: "USD" } });
    const ctx = { environment: "sandbox" as const, credentials: { webhookSignatureKey: "k" }, fetch, now: () => Date.now() };
    expect(await cko.verifyWebhook(ctx, { headers: new Headers({ "cko-signature": await hmacSha256Hex("k", body) }), rawBody: body, url: "https://x" })).toBe(true);
    expect(await cko.verifyWebhook(ctx, { headers: new Headers({ "cko-signature": "00" }), rawBody: body, url: "https://x" })).toBe(false);
  });
});

describe("shared-secret adapters reject missing or wrong tokens", () => {
  test("flutterwave verif-hash and xendit callback token", async () => {
    const flw = getAdapter("flutterwave")!;
    const xnd = getAdapter("xendit")!;
    const c = (creds: Record<string, string>) => ({ environment: "sandbox" as const, credentials: creds, fetch, now: () => Date.now() });
    expect(await flw.verifyWebhook(c({ webhookHash: "h1" }), { headers: new Headers({ "verif-hash": "h1" }), rawBody: "{}", url: "https://x" })).toBe(true);
    expect(await flw.verifyWebhook(c({ webhookHash: "h1" }), { headers: new Headers({ "verif-hash": "h2" }), rawBody: "{}", url: "https://x" })).toBe(false);
    expect(await flw.verifyWebhook(c({}), { headers: new Headers({ "verif-hash": "" }), rawBody: "{}", url: "https://x" })).toBe(false);
    expect(await xnd.verifyWebhook(c({ callbackToken: "t" }), { headers: new Headers({ "x-callback-token": "t" }), rawBody: "{}", url: "https://x" })).toBe(true);
    expect(await xnd.verifyWebhook(c({ callbackToken: "t" }), { headers: new Headers(), rawBody: "{}", url: "https://x" })).toBe(false);
  });
});

describe("every live adapter classifies a 503 as unknown", () => {
  const ids = ["stripe", "adyen", "checkoutcom", "dlocal", "paystack", "flutterwave", "razorpay", "mercadopago", "xendit", "mpesa"];
  for (const id of ids) {
    test(id, async () => {
      const a = getAdapter(id)!;
      const creds: Record<string, string> = {};
      for (const c of a.descriptor.credentials) creds[c.key] = c.key === "hmacKey" ? "00ff" : `${c.key}_value`;
      // Token-exchange providers (M-Pesa) get a token first; then the charge 503s.
      const { ctx } = mockCtx(creds, (c) => (/oauth|token|generate/i.test(c.url) ? json(200, { access_token: "tok", expires_in: "3599" }) : json(503, { message: "upstream" })));
      const method = a.descriptor.methods[0];
      const country = a.descriptor.countries === "global" ? "US" : a.descriptor.countries[0];
      const currency = a.descriptor.currencies === "all" ? "USD" : a.descriptor.currencies[0];
      const r = await a.charge(ctx, { ...req, amountMinor: 100_000, currency, country, paymentMethod: method, customer: { email: "a@b.co", phone: "+254700000000", name: "Ada" } });
      expect(r.status).toBe("unknown");
    });
  }
});
