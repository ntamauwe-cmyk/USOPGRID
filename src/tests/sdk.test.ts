import { describe, expect, test } from "bun:test";
import { Usopgrid, verifyWebhook, UsopgridError } from "../../sdk/typescript/usopgrid";
import { hmacSha256Hex } from "../convex/lib/crypto";

describe("TypeScript SDK", () => {
  test("retries a 503 with the SAME idempotency key, then succeeds", async () => {
    const keys: string[] = [];
    let n = 0;
    const f = (async (_u: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"]);
      n++;
      return n === 1
        ? new Response(JSON.stringify({ error: { code: "provider_unavailable", message: "x", retryable: true } }), { status: 503, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ data: { payment: { id: "txn_1", status: "SUCCESSFUL" } } }), { status: 201 });
    }) as unknown as typeof fetch;
    const ug = new Usopgrid({ apiKey: "sk_sandbox_x", baseUrl: "https://x/api/v1", fetch: f });
    const p = await ug.payments.create({ amount: 100, currency: "USD", payment_method: "card", reference: "o1" });
    expect(p.id).toBe("txn_1");
    expect(keys).toEqual(["pay_o1", "pay_o1"]);
  });
  test("non-retryable errors surface typed", async () => {
    const f = (async () => new Response(JSON.stringify({ error: { code: "validation_error", message: "bad", retryable: false }, requestId: "req_1" }), { status: 422 })) as unknown as typeof fetch;
    const ug = new Usopgrid({ apiKey: "sk_sandbox_x", baseUrl: "https://x", fetch: f });
    let err: unknown;
    try { await ug.payments.retrieve("t"); } catch (e) { err = e; }
    expect(err instanceof UsopgridError && err.code === "validation_error" && err.requestId === "req_1").toBe(true);
  });
  test("webhook verification matches the server signer", async () => {
    const body = '{"event":"payment.successful"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacSha256Hex("whsec_1", `${t}.${body}`);
    expect(await verifyWebhook(body, `t=${t},v1=${sig}`, "whsec_1")).toBe(true);
    expect(await verifyWebhook(body + " ", `t=${t},v1=${sig}`, "whsec_1")).toBe(false);
    expect(await verifyWebhook(body, `t=${t - 900},v1=${sig}`, "whsec_1")).toBe(false);
  });
});
