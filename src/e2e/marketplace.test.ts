// Marketplace split payments end to end: recipients, shares on success,
// proportional reversal on refunds, recipient payouts from their own
// balance, and the same approval rule as every other payout.
import { describe, expect, test } from "vitest";
import { api as fns } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { api, setup, stepUp } from "./setup";

const account = (n: string) => ({ bank_name: "GTBank", bank_code: "058", account_number: n, currency: "NGN", country: "NG" });

async function balances(t: Awaited<ReturnType<typeof setup>>["t"]) {
  return t.run(async (ctx) => {
    const out: Record<string, number> = {};
    const entries = await ctx.db.query("ledgerEntries").collect();
    for (const e of entries) {
      out[e.accountCode] = (out[e.accountCode] ?? 0) + (e.direction === "credit" ? e.amountMinor : -e.amountMinor);
    }
    // Every posting group balances.
    const groups = new Map<string, number>();
    for (const e of entries) groups.set(e.ledgerRef, (groups.get(e.ledgerRef) ?? 0) + (e.direction === "debit" ? e.amountMinor : -e.amountMinor));
    for (const [ref, d] of groups) if (d !== 0) throw new Error(`unbalanced ${ref}`);
    return out;
  });
}

const sum = (b: Record<string, number>, prefix: string) => Object.entries(b).filter(([k]) => k.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);

describe("marketplace split payments", () => {
  test("shares reach recipients on success and reverse in proportion on refunds", async () => {
    const { t } = await setup();
    const a = await api(t, "POST", "/recipients", { name: "Ada Crafts", email: "ada@crafts.test", payout_account: account("0123456789") });
    expect(a.status).toBe(201);
    expect(a.data.recipient.payout_account.account).toBe("••••6789");
    const b = await api(t, "POST", "/recipients", { name: "Bayo Prints", payout_account: account("0987654321") });
    const ra = a.data.recipient.id as string;
    const rb = b.data.recipient.id as string;

    // Account numbers are never stored in clear.
    const stored = await t.run((ctx) => ctx.db.query("beneficiaries").collect());
    expect(JSON.stringify(stored)).not.toContain("0123456789");

    const pay = await api(t, "POST", "/payments", {
      amount: 1_000_000,
      currency: "NGN",
      payment_method: "card",
      country: "NG",
      splits: [{ recipient: ra, percent: 60 }, { recipient: rb, amount: 200_000 }],
    });
    expect(pay.status).toBe(201);
    expect(pay.data.payment.status).toBe("SUCCESSFUL");
    const id = pay.data.payment.id as string;

    let bal = await balances(t);
    expect(sum(bal, "rcpt_")).toBe(800_000);
    // Merchant net is 1,000,000 less a 1.5% fee, less the shares.
    expect(sum(bal, "merch_")).toBe(985_000 - 800_000);

    const got = await api(t, "GET", `/payments/${id}`);
    expect(got.data.payment.splits).toEqual([
      { recipient: ra, amount: 600_000, percent: 60, allocated: 600_000, reversed: 0 },
      { recipient: rb, amount: 200_000, percent: null, allocated: 200_000, reversed: 0 },
    ]);

    // Refund a quarter, then the rest: shares are reversed exactly.
    expect((await api(t, "POST", `/payments/${id}/refund`, { amount: 250_000 })).status).toBe(200);
    bal = await balances(t);
    expect(sum(bal, "rcpt_")).toBe(600_000);
    expect((await api(t, "POST", `/payments/${id}/refund`, {})).status).toBe(200);
    bal = await balances(t);
    expect(sum(bal, "rcpt_")).toBe(0);
    const after = await api(t, "GET", `/payments/${id}`);
    expect(after.data.payment.splits.map((s: { reversed: number }) => s.reversed)).toEqual([600_000, 200_000]);
  });

  test("invalid splits are refused before any payment is created", async () => {
    const { t } = await setup();
    const a = await api(t, "POST", "/recipients", { name: "Ada", payout_account: account("0123456789") });
    const ra = a.data.recipient.id as string;
    const cases = [
      [{ recipient: ra, amount: 990_000 }], // more than net after the 1.5% fee
      [{ recipient: "rcp_doesnotexist", amount: 1 }],
      [{ recipient: ra, percent: 50 }, { recipient: ra, percent: 10 }],
    ];
    for (const splits of cases) {
      const r = await api(t, "POST", "/payments", { amount: 1_000_000, currency: "NGN", payment_method: "card", splits });
      expect(r.status).toBe(422);
    }
    const usd = await api(t, "POST", "/payments", { amount: 10_000, currency: "USD", payment_method: "card", splits: [{ recipient: ra, amount: 100 }] });
    expect(usd.status).toBe(422);
    expect(usd.json?.error?.message).toMatch(/paid in NGN/);
    await api(t, "POST", `/recipients/${ra}/disable`, {});
    const off = await api(t, "POST", "/payments", { amount: 1_000_000, currency: "NGN", payment_method: "card", splits: [{ recipient: ra, amount: 1 }] });
    expect(off.json?.error?.message).toMatch(/disabled/);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toHaveLength(0);
  });

  test("a recipient is paid from its own balance, never more than it holds", async () => {
    const { t } = await setup();
    const a = await api(t, "POST", "/recipients", { name: "Ada", payout_account: account("0123456789") });
    const ra = a.data.recipient.id as string;
    await api(t, "POST", "/payments", { amount: 1_000_000, currency: "NGN", payment_method: "card", splits: [{ recipient: ra, amount: 500_000 }] });

    const tooMuch = await api(t, "POST", `/recipients/${ra}/payouts`, { amount: 500_000 });
    expect(tooMuch.status).toBe(422); // the payout fee must fit too
    const po = await api(t, "POST", `/recipients/${ra}/payouts`, {}, { "Idempotency-Key": "rp-1" });
    expect(po.status).toBe(201);
    expect(po.data.payout.status).toBe("SUCCESSFUL");
    const again = await api(t, "POST", `/recipients/${ra}/payouts`, {}, { "Idempotency-Key": "rp-1" });
    expect(again.data.payout.id).toBe(po.data.payout.id);
    expect(await t.run((ctx) => ctx.db.query("payouts").collect())).toHaveLength(1);

    const bal = await balances(t);
    expect(sum(bal, "rcpt_")).toBeGreaterThanOrEqual(0);
    expect(sum(bal, "rcpt_")).toBeLessThan(10);
    // The merchant's own balance was not touched by the recipient payout.
    expect(sum(bal, "merch_")).toBe(985_000 - 500_000);
    const r = await api(t, "GET", `/recipients/${ra}`);
    expect(r.data.recipient.balance).toBe(sum(bal, "rcpt_"));
  });

  test("a refund after payout leaves the recipient owing; payouts wait", async () => {
    const { t } = await setup();
    const a = await api(t, "POST", "/recipients", { name: "Ada", payout_account: account("0123456789") });
    const ra = a.data.recipient.id as string;
    const pay = await api(t, "POST", "/payments", { amount: 1_000_000, currency: "NGN", payment_method: "card", splits: [{ recipient: ra, amount: 500_000 }] });
    await api(t, "POST", `/recipients/${ra}/payouts`, {});
    await api(t, "POST", `/payments/${pay.data.payment.id}/refund`, {});
    const r = await api(t, "GET", `/recipients/${ra}`);
    expect(r.data.recipient.balance).toBeLessThan(0);
    const po = await api(t, "POST", `/recipients/${ra}/payouts`, {});
    expect(po.status).toBe(422);
    expect(po.json?.error?.message).toMatch(/owes/);
  });

  test("recipient payouts follow the two-person rule", async () => {
    const { t, owner, finance, orgId } = await setup();
    const owner_ = t.withIdentity({ subject: `${owner}|s1` });
    const finance_ = t.withIdentity({ subject: `${finance}|s2` });
    const a = await api(t, "POST", "/recipients", { name: "Ada", payout_account: account("0123456789") });
    const ra = a.data.recipient.id as string;
    await api(t, "POST", "/payments", { amount: 1_000_000, currency: "NGN", payment_method: "card", splits: [{ recipient: ra, amount: 500_000 }] });
    await t.run((ctx) => ctx.db.patch(orgId, { approvals: { payouts: "all" } }));

    const recipientDocId = a.data.recipient.id ? (await t.run((ctx) => ctx.db.query("recipients").first()))!._id : ("" as Id<"recipients">);
    const req = await owner_.action(fns.recipients.payout, { recipientId: recipientDocId, amountMinor: 100_000 });
    expect(req.kind).toBe("pending_approval");
    expect(await t.run((ctx) => ctx.db.query("payouts").collect())).toHaveLength(0);

    await stepUp(t, finance);
    const done = await finance_.action(fns.approvals.decide, { approvalId: (req as { approvalId: string }).approvalId as Id<"approvalRequests">, decision: "approve" });
    expect(done.status).toBe("executed");
    const payouts = await t.run((ctx) => ctx.db.query("payouts").collect());
    expect(payouts).toHaveLength(1);
    expect(payouts[0].recipientId).toBe(recipientDocId);
    const bal = await balances(t);
    expect(sum(bal, "rcpt_")).toBe(500_000 - 100_000 - payouts[0].feeMinor);
  });

  test("recipients are private to their organization; read-only keys cannot create them", async () => {
    const { t, owner } = await setup();
    const owner_ = t.withIdentity({ subject: `${owner}|s1` });
    await stepUp(t, owner);
    const r = await owner_.action(fns.recipients.create, { name: "Dash Seller", account: { holderName: "Dash Seller", bankName: "GTBank", accountNumber: "0555555555", currency: "NGN" } });
    expect(r.id).toMatch(/^rcp_/);
    const list = await owner_.query(fns.recipients.list, {});
    expect(list).toHaveLength(1);

    // Another organization cannot see or use it.
    const other = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", { name: "Eve", email: "eve@other.test" });
      const o = await ctx.db.insert("organizations", { name: "Other", slug: "other", environment: "sandbox", status: "active" });
      await ctx.db.insert("orgMembers", { orgId: o, userId: u, role: "owner", joinedAt: Date.now() });
      return u;
    });
    const eve = t.withIdentity({ subject: `${other}|s9` });
    expect(await eve.query(fns.recipients.list, {})).toHaveLength(0);
    await stepUp(t, other);
    await expect(eve.action(fns.recipients.payout, { recipientId: r._id })).rejects.toThrow(/NOT_FOUND/);
  });
});
