// USOPGRID recovery queue.
//
// Payments whose provider outcome is unknown (timeout, 5xx, transport error)
// or still pending are resolved by asking the SAME provider for the status of
// the SAME instruction on a backoff schedule — never by re-sending it or by
// trying another provider. Customer-action flows expire after their TTL.
// Anything unresolved by the deadline is escalated to finance as a
// reconciliation exception.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAdapter } from "./providers/index";
import { nextRecoveryAt } from "./orchestration/retry";
import { txStateForCharge } from "./orchestration/engine";
import { resolveConnection, notify } from "./connections";
import type { Doc } from "./_generated/dataModel";
import type { TxState } from "./orchestration/states";

const BATCH = 25;

export const dueJobsInternal = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) =>
    ctx.db
      .query("recoveryJobs")
      .withIndex("by_status_next", (q) => q.eq("status", "open").lte("nextCheckAt", now))
      .take(BATCH),
});

export const rescheduleInternal = internalMutation({
  args: { jobId: v.id("recoveryJobs"), lastResult: v.string() },
  handler: async (ctx, { jobId, lastResult }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "open") return;
    const now = Date.now();
    const checksDone = job.checksDone + 1;
    const next = nextRecoveryAt(checksDone, now);
    await ctx.db.patch(jobId, {
      checksDone,
      lastResult,
      nextCheckAt: next !== null ? Math.min(next, job.deadlineAt) : job.deadlineAt,
      updatedAt: now,
    });
  },
});

export const escalateInternal = internalMutation({
  args: { jobId: v.id("recoveryJobs"), reason: v.string() },
  handler: async (ctx, { jobId, reason }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "open") return;
    const txn = await ctx.db.get(job.transactionId);
    await ctx.db.patch(jobId, { status: "escalated", lastResult: reason, updatedAt: Date.now() });
    if (!txn) return;
    await ctx.db.insert("reconExceptions", {
      orgId: txn.orgId,
      type: "unknown_outcome_expired",
      severity: "high",
      detail: `${job.kind} for ${txn.transactionId} unresolved after ${job.checksDone} checks with ${job.providerId}: ${reason}`,
      currency: txn.currency,
      ledgerAmountMinor: txn.amountMinor,
      transactionId: txn.transactionId,
      provider: job.providerId,
      providerReference: txn.providerReference,
      status: "open",
      createdAt: Date.now(),
    });
    if (txn.status === "PENDING" || txn.status === "PROCESSING" || txn.status === "REFUND_PENDING") {
      await ctx.db.patch(txn._id, { status: "RECONCILIATION_EXCEPTION", updatedAt: Date.now() });
      await ctx.db.insert("transactionEvents", {
        transactionId: txn._id,
        type: "reconciliation_exception",
        fromStatus: txn.status,
        toStatus: "RECONCILIATION_EXCEPTION",
        data: { reason },
        actor: "recovery",
        at: Date.now(),
      });
    }
    await notify(ctx, {
      orgId: txn.orgId,
      kind: "recon_exception",
      severity: "critical",
      title: `Unresolved provider outcome: ${txn.transactionId}`,
      body: `USOPGRID could not confirm the outcome with ${job.providerId} before the deadline. Finance must verify with the provider.`,
      link: "/dashboard/reconciliation",
    });
  },
});

export const runDue = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number; resolved: number }> => {
    const now = Date.now();
    const jobs: Doc<"recoveryJobs">[] = await ctx.runQuery(internal.recovery.dueJobsInternal, { now });
    let resolved = 0;
    for (const job of jobs) {
      try {
        const txn: Doc<"transactions"> | null = await ctx.runQuery(internal.payments.transactionByIdInternal, { internalId: job.transactionId });
        if (!txn) {
          await ctx.runMutation(internal.recovery.escalateInternal, { jobId: job._id, reason: "transaction missing" });
          continue;
        }

        if (job.kind === "action_expiry") {
          if (txn.status === "PENDING") {
            // Last look before expiring: the customer may have completed it.
            const r = await check(job.connectionId, txn);
            if (r && r !== "PENDING") {
              await ctx.runMutation(internal.payments.applyProviderOutcomeInternal, { internalId: txn._id, reported: r, source: "recovery" });
            } else {
              await ctx.runMutation(internal.payments.applyProviderOutcomeInternal, {
                internalId: txn._id,
                reported: "EXPIRED",
                source: "recovery",
                failure: { category: "customer_cancellation", code: "action_expired", message: "The customer did not complete the payment in time.", retryable: true },
              });
            }
          }
          resolved++;
          continue;
        }

        if (job.kind === "refund_status") {
          if (now >= job.deadlineAt) await ctx.runMutation(internal.recovery.escalateInternal, { jobId: job._id, reason: "refund outcome not confirmed (awaiting provider webhook)" });
          else await ctx.runMutation(internal.recovery.rescheduleInternal, { jobId: job._id, lastResult: "awaiting refund webhook" });
          continue;
        }

        // charge_status
        const state = await check(job.connectionId, txn);
        if (state && state !== "PENDING") {
          await ctx.runMutation(internal.payments.applyProviderOutcomeInternal, { internalId: txn._id, reported: state, source: "recovery" });
          resolved++;
        } else if (now >= job.deadlineAt) {
          await ctx.runMutation(internal.recovery.escalateInternal, { jobId: job._id, reason: state ? "still pending at provider" : "provider status unavailable" });
        } else {
          await ctx.runMutation(internal.recovery.rescheduleInternal, { jobId: job._id, lastResult: state ?? "status unavailable" });
        }
      } catch (err) {
        await ctx.runMutation(internal.recovery.rescheduleInternal, { jobId: job._id, lastResult: `error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return { processed: jobs.length, resolved };

    async function check(connectionId: string, txn: Doc<"transactions">): Promise<TxState | null> {
      if (!getAdapter(txn.provider)?.descriptor.operations.status) return null;
      const res = await resolveConnection(connectionId, txn.environment, (key) => ctx.runQuery(internal.connections.connectionByKeyInternal, { connectionKey: key }));
      if ("error" in res) return null;
      const r = await res.adapter.getStatus(res.ctx, {
        transactionId: txn.transactionId,
        reference: txn.reference,
        providerReference: txn.providerReference,
        currency: txn.currency,
      });
      if (r.status === "unknown") return null;
      return txStateForCharge(r.status);
    }
  },
});

/** Operator tool: force an immediate status check (operations console). */
export const expediteInternal = internalMutation({
  args: { jobId: v.id("recoveryJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (job?.status === "open") await ctx.db.patch(jobId, { nextCheckAt: Date.now(), updatedAt: Date.now() });
  },
});
