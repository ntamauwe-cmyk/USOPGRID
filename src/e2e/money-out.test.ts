// Money-out controls end to end: two-person approval, bulk payouts, and
// recurring billing renewals with retries.
import { describe, expect, test, vi, afterEach } from "vitest";
import { api as fns, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { api, setup, stepUp } from "./setup";

afterEach(() => vi.useRealTimers());

async function funded() {
  const s = await setup();
  // Fund the merchant balance with a successful payment.
  const p = await api(s.t, "POST", "/payments", { amount: 50_000_000, currency: "NGN", payment_method: "card", country: "NG", customer: { email: "payer@example.com" } });
  expect(p.data.payment.status).toBe("SUCCESSFUL");
  const beneficiaryId = await s.t.run((ctx) =>
    ctx.db.insert("beneficiaries", { orgId: s.orgId, name: "Okonkwo Logistics", bankName: "GTBank", bankCode: "058", accountMasked: "••••4471", accountHash: "h1", currency: "NGN", status: "verified", createdAt: Date.now() }),
  );
  return { ...s, beneficiaryId };
}

describe("two-person approval", () => {
  test("with the policy on, a payout waits; the requester cannot approve it; a second person can", async () => {
    const { t, owner, finance, orgId, beneficiaryId } = await funded();
    await t.run((ctx) => ctx.db.patch(orgId, { approvals: { payouts: "all" } }));
    const owner_ = t.withIdentity({ subject: `${owner}|s1` });
    const finance_ = t.withIdentity({ subject: `${finance}|s2` });

    const req = await owner_.action(fns.payouts.createDashboardPayout, { beneficiaryId, amountMinor: 1_000_000 });
    expect(req.status).toBe("PENDING_APPROVAL");
    expect(await t.run((ctx) => ctx.db.query("payouts").collect())).toHaveLength(0);
    const approvalId = req.approvalId as Id<"approvalRequests">;

    await stepUp(t, owner);
    await expect(owner_.action(fns.approvals.decide, { approvalId, decision: "approve" })).rejects.toThrow(/cannot approve your own/);

    // Approver without a fresh authenticator confirmation is refused.
    await expect(finance_.action(fns.approvals.decide, { approvalId, decision: "approve" })).rejects.toThrow(/MFA_REQUIRED|MFA_STEP_UP/);
    await stepUp(t, finance);
    const done = await finance_.action(fns.approvals.decide, { approvalId, decision: "approve" });
    expect(done.status).toBe("executed");
    const payouts = await t.run((ctx) => ctx.db.query("payouts").collect());
    expect(payouts).toHaveLength(1);
    expect(payouts[0].status).toBe("SUCCESSFUL");

    // A decided request cannot be approved again (no second payout).
    await expect(finance_.action(fns.approvals.decide, { approvalId, decision: "approve" })).rejects.toThrow(/already/);
    expect(await t.run((ctx) => ctx.db.query("payouts").collect())).toHaveLength(1);
  });

  test("API payouts under the policy return 202 and move no money", async () => {
    const { t, orgId, beneficiaryId } = await funded();
    await t.run((ctx) => ctx.db.patch(orgId, { approvals: { payouts: "above", payoutThresholdUsd: 1 } }));
    const r = await api(t, "POST", "/payouts", { beneficiary_id: beneficiaryId, amount: 5_000_000 }, { "Idempotency-Key": "po-1" });
    expect(r.status).toBe(202);
    expect(r.data.approval.status).toBe("pending_approval");
    const again = await api(t, "POST", "/payouts", { beneficiary_id: beneficiaryId, amount: 5_000_000 }, { "Idempotency-Key": "po-1" });
    expect(again.data.approval.id).toBe(r.data.approval.id);
    expect(await t.run((ctx) => ctx.db.query("payouts").collect())).toHaveLength(0);
  });

  test("weakening the policy needs a second approver; tightening applies at once", async () => {
    const { t, owner, orgId } = await setup();
    const owner_ = t.withIdentity({ subject: `${owner}|s1` });
    const tighten = await owner_.mutation(fns.approvals.setPolicy, { policy: { payouts: "all" } });
    expect(tighten.applied).toBe(true);
    const loosen = await owner_.mutation(fns.approvals.setPolicy, { policy: { payouts: "off" } });
    expect(loosen.applied).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(orgId)))?.approvals?.payouts).toBe("all");
  });
});

describe("bulk payouts", () => {
  test("an invalid file creates nothing; a valid one is paid row by row once approved", async () => {
    const { t, owner, finance, orgId } = await funded();
    const owner_ = t.withIdentity({ subject: `${owner}|s1` });
    const bad = "name,bank_name,account_number,currency,amount\nA,GTBank,12,NGN,100\n";
    await expect(owner_.action(fns.bulkPayouts.submit, { csv: bad, name: "bad" })).rejects.toThrow(/need fixing/);
    expect(await t.run((ctx) => ctx.db.query("payoutBatches").collect())).toHaveLength(0);

    await t.run((ctx) => ctx.db.patch(orgId, { approvals: { payouts: "all" } }));
    const csv = "name,bank_name,bank_code,account_number,currency,amount,reference\nA Ltd,GTBank,058,0123456789,NGN,1000.00,R1\nB Ltd,Access,044,0987654321,NGN,2500.50,R2\n";
    const sub = await owner_.action(fns.bulkPayouts.submit, { csv, name: "October suppliers" });
    expect(sub.status).toBe("pending_approval");
    const approval = (await t.run((ctx) => ctx.db.query("approvalRequests").collect()))[0];
    await stepUp(t, finance);
    vi.useFakeTimers();
    const done = await t.withIdentity({ subject: `${finance}|s2` }).action(fns.approvals.decide, { approvalId: approval._id, decision: "approve" });
    expect(done.status).toBe("executed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const items = await t.run((ctx) => ctx.db.query("payoutBatchItems").collect());
    expect(items.map((i) => i.status)).toEqual(["submitted", "submitted"]);
    const payouts = await t.run((ctx) => ctx.db.query("payouts").collect());
    expect(payouts.map((p) => p.amountMinor).sort((a, b) => a - b)).toEqual([100_000, 250_050]);
    expect((await t.run((ctx) => ctx.db.query("payoutBatches").collect()))[0].status).toBe("completed");
  });
});

describe("recurring billing", () => {
  async function subscribed(simulate?: string) {
    const s = await setup();
    const first = await api(s.t, "POST", "/payments", { amount: 500_000, currency: "NGN", payment_method: "card", customer: { email: "sub@example.com" }, save_payment_method: true });
    expect(first.data.payment.status).toBe("SUCCESSFUL");
    const methods = await api(s.t, "GET", "/payment_methods?customer_email=sub@example.com");
    expect(methods.data.payment_methods).toHaveLength(1);
    const plan = await api(s.t, "POST", "/plans", { name: "Pro", amount: 500_000, currency: "NGN", interval: "month" });
    expect(plan.status).toBe(201);
    const sub = await api(s.t, "POST", "/subscriptions", { plan_id: plan.data.plan.id, payment_method_id: methods.data.payment_methods[0].id, metadata: simulate ? { simulate } : undefined });
    expect(sub.status).toBe(201);
    return { ...s, subId: sub.data.subscription.id as string };
  }

  test("a due renewal is charged once at the issuing provider and the period advances", async () => {
    const { t, subId } = await subscribed();
    await t.action(internal.billing.runDue, {});
    await t.action(internal.billing.runDue, {}); // a second run must not charge again
    const s = await api(t, "GET", `/subscriptions/${subId}`);
    expect(s.data.subscription.status).toBe("active");
    expect(s.data.subscription.invoices).toHaveLength(1);
    expect(s.data.subscription.invoices[0].status).toBe("paid");
    const renewals = await t.run((ctx) => ctx.db.query("transactions").collect());
    expect(renewals.filter((x) => x.reference.startsWith("inv_"))).toHaveLength(1);
    expect(Date.parse(s.data.subscription.next_charge_at)).toBeGreaterThan(Date.now() + 27 * 86_400_000);
  });

  test("recoverable failures retry on schedule, then the subscription stops", async () => {
    const { t, subId } = await subscribed("insufficient_funds");
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.now();
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(now);
      await t.action(internal.billing.runDue, {});
      now += 8 * 86_400_000;
    }
    const s = await api(t, "GET", `/subscriptions/${subId}`);
    expect(s.data.subscription.status).toBe("unpaid");
    expect(s.data.subscription.failed_attempts).toBe(5);
    expect(s.data.subscription.invoices[0].status).toBe("failed");
  });

  test("hard declines stop immediately without retrying", async () => {
    const { t, subId } = await subscribed("fraud_rejection");
    await t.action(internal.billing.runDue, {});
    const s = await api(t, "GET", `/subscriptions/${subId}`);
    expect(s.data.subscription.status).toBe("unpaid");
    expect(s.data.subscription.failed_attempts).toBe(1);
  });
});
