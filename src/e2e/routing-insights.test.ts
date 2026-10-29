// Scorecards and backtest against real recorded attempts.
import { describe, expect, test } from "vitest";
import { api as fns } from "../convex/_generated/api";
import { api, setup } from "./setup";

describe("routing insights", () => {
  test("scorecards reflect recorded attempts and flag small samples", async () => {
    const { t, owner } = await setup();
    for (let i = 0; i < 4; i++) await api(t, "POST", "/payments", { amount: 100_000 + i, currency: "NGN", payment_method: "card", country: "NG", customer: { email: `p${i}@example.com` } });
    await api(t, "POST", "/payments", { amount: 200_000, currency: "NGN", payment_method: "card", country: "NG", customer: { email: "d@example.com" }, metadata: { simulate: "insufficient_funds" } });
    const sc = await t.withIdentity({ subject: `${owner}|s1` }).query(fns.routing.scorecards, { days: 7 });
    expect(sc.environment).toBe("sandbox");
    expect(sc.dataSource).toMatch(/simulat/i);
    const total = sc.cards.reduce((n, c) => n + c.decided, 0);
    expect(total).toBe(5);
    expect(sc.cards.every((c) => !c.sufficient)).toBe(true);
    expect(sc.cards.reduce((n, c) => n + c.successes, 0)).toBe(4);
  });

  test("backtest is labelled simulated, replays first attempts and saves nothing", async () => {
    const { t, owner } = await setup();
    for (let i = 0; i < 3; i++) await api(t, "POST", "/payments", { amount: 100_000 + i, currency: "NGN", payment_method: "card", country: "NG", customer: { email: `b${i}@example.com` } });
    const before = await t.run((ctx) => ctx.db.query("routingRules").collect());
    const r = await t.withIdentity({ subject: `${owner}|s1` }).query(fns.routing.backtest, { days: 30, extraRule: { match: {}, action: { type: "exclude", providers: ["sandbox"] } } });
    expect(r.label).toBe("Simulated");
    expect(r.payments).toBe(3);
    expect(r.current.observed + r.current.estimated + r.current.unroutable).toBe(3);
    expect(r.method.length).toBeGreaterThan(2);
    expect(await t.run((ctx) => ctx.db.query("routingRules").collect())).toEqual(before);
  });

  test("a proposed rule naming an unknown provider is refused", async () => {
    const { t, owner } = await setup();
    await expect(t.withIdentity({ subject: `${owner}|s1` }).query(fns.routing.backtest, { extraRule: { match: {}, action: { type: "only", providers: ["nope"] } } })).rejects.toThrow(/Unknown provider/);
  });
});
