// Inbound provider webhooks: POST /api/v1/webhooks/providers/:connectionKey
//
// 1. resolve the connection (and its credentials) from the URL
// 2. verify the provider's signature over the RAW body — unsigned or
//    mis-signed events are rejected and recorded, never applied
// 3. de-duplicate by (provider, event id)
// 4. normalize into USOPGRID states and apply through the state machine,
//    which makes duplicates and out-of-order events harmless
//
// Providers retry on non-2xx, so anything we have durably recorded gets 200.

import { v } from "convex/values";
import { throttle, ApiError } from "./lib/httpservice";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { resolveConnection, parsePlatformConnectionId } from "./connections";
import type { ProviderEvent } from "./providers/types";
import { txStateForCharge } from "./orchestration/engine";

const MAX_BODY_BYTES = 1_000_000;

export const findTransactionInternal = internalQuery({
  args: { providerId: v.string(), providerReference: v.optional(v.string()), reference: v.optional(v.string()) },
  handler: async (ctx, a) => {
    if (a.providerReference) {
      const t = await ctx.db
        .query("transactions")
        .withIndex("by_provider_reference", (q) => q.eq("provider", a.providerId).eq("providerReference", a.providerReference))
        .first();
      if (t) return t;
    }
    if (a.reference) {
      // Providers echo either our transactionId or the merchant reference.
      const byId = await ctx.db
        .query("transactions")
        .withIndex("by_transaction_id", (q) => q.eq("transactionId", a.reference!))
        .unique();
      if (byId) return byId;
    }
    return null;
  },
});

export const recordEventInternal = internalMutation({
  args: {
    providerId: v.string(),
    connectionKey: v.string(),
    eventId: v.string(),
    rawType: v.string(),
    verified: v.boolean(),
    outcome: v.string(),
    transactionId: v.optional(v.id("transactions")),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const dup = await ctx.db
      .query("providerEvents")
      .withIndex("by_provider_event", (q) => q.eq("providerId", a.providerId).eq("eventId", a.eventId))
      .first();
    if (dup && a.verified) return { duplicate: true };
    await ctx.db.insert("providerEvents", { ...a, receivedAt: Date.now() });
    return { duplicate: false };
  },
});

export const seenEventInternal = internalQuery({
  args: { providerId: v.string(), eventId: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("providerEvents")
      .withIndex("by_provider_event", (q) => q.eq("providerId", a.providerId).eq("eventId", a.eventId))
      .first();
    return row !== null && row.verified;
  },
});

function reportedState(e: ProviderEvent): string | null {
  switch (e.status) {
    case undefined:
      return null;
    case "refunded":
    case "partially_refunded":
    case "dispute_opened":
    case "dispute_won":
    case "dispute_lost":
    case "payout_successful":
    case "payout_failed":
    case "payout_reversed":
      return null; // handled by refund/dispute/payout flows
    default:
      return e.status === "unknown" ? null : txStateForCharge(e.status);
  }
}

export const receive = httpAction(async (ctx, request) => {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean); // api v1 webhooks providers :key
  const connectionKey = decodeURIComponent(parts[4] ?? "");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });

  if (!connectionKey || connectionKey.length > 128) return new Response("unknown connection", { status: 404 });
  // Flood control before any crypto or lookups; providers retry on 429/503.
  try {
    await throttle(ctx, `webhook:${connectionKey}`, 600, 60_000);
  } catch (err) {
    const retry = err instanceof ApiError ? String(err.retryAfterSec ?? 5) : "5";
    return new Response("slow down", { status: err instanceof ApiError && err.code === "rate_limited" ? 429 : 503, headers: { "Retry-After": retry } });
  }
  const platform = parsePlatformConnectionId(connectionKey);
  const conn = platform ? null : await ctx.runQuery(internal.connections.connectionByKeyInternal, { connectionKey });
  const environment = platform?.environment ?? conn?.environment;
  if (!environment) return new Response("unknown connection", { status: 404 });

  const resolved = await resolveConnection(connectionKey, environment, async () => conn);
  if ("error" in resolved) return new Response("connection unavailable", { status: 503 });
  const { adapter, ctx: actx } = resolved;
  const providerId = adapter.descriptor.id;
  const input = { headers: request.headers, rawBody, url: request.url };

  let verified = false;
  try {
    verified = await adapter.verifyWebhook(actx, input);
  } catch {
    verified = false;
  }
  if (!verified) {
    // Record forged/misconfigured deliveries for operators, but cap how many so
    // an attacker cannot fill the database with junk.
    let record = true;
    try {
      await throttle(ctx, `webhook_unverified:${connectionKey}`, 20, 60_000);
    } catch {
      record = false;
    }
    if (record) await ctx.runMutation(internal.providerWebhooks.recordEventInternal, {
      providerId,
      connectionKey,
      eventId: `unverified_${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
      rawType: "unverified",
      verified: false,
      outcome: "rejected",
      detail: "signature verification failed",
    });
    return new Response("invalid signature", { status: 401 });
  }

  let events: ProviderEvent[] = [];
  try {
    events = adapter.parseWebhook(actx, input);
  } catch (err) {
    return new Response(`unparseable event: ${err instanceof Error ? err.message : "error"}`, { status: 400 });
  }

  for (const e of events) {
    if (await ctx.runQuery(internal.providerWebhooks.seenEventInternal, { providerId, eventId: e.eventId })) continue;
    let outcome = "ignored";
    let txId: Id<"transactions"> | undefined;
    let detail: string | undefined;
    if (e.type === "payout") {
      if (!e.reference || !e.status) {
        outcome = "ignored";
      } else {
        // The payout engine re-confirms with the provider before booking anything.
        outcome = await ctx.runAction(internal.payouts.applyPayoutEventInternal, { railReference: e.reference, reported: e.status, connectionKey });
      }
      await ctx.runMutation(internal.providerWebhooks.recordEventInternal, { providerId, connectionKey, eventId: e.eventId, rawType: e.rawType, verified: true, outcome, detail: `payout ${e.reference ?? "-"}` });
      continue;
    }
    const txn =
      e.type === "other" ? null : await ctx.runQuery(internal.providerWebhooks.findTransactionInternal, { providerId, providerReference: e.providerReference, reference: e.reference });
    if (txn && conn?.orgId && txn.orgId !== conn.orgId) {
      outcome = "rejected";
      detail = "event references a transaction owned by another organization";
    } else if (txn) {
      txId = txn._id;
      if (e.type === "payment") {
        const st = reportedState(e);
        if (st) {
          const r = await ctx.runMutation(internal.payments.applyProviderOutcomeInternal, {
            internalId: txn._id,
            reported: st,
            source: `webhook:${providerId}`,
            providerReference: e.providerReference,
            amountMinor: e.amountMinor,
            currency: e.currency,
            failure: e.failure ? { category: e.failure.category, code: e.failure.code, message: e.failure.message, retryable: e.failure.retryable } : undefined,
            eventId: e.eventId,
          });
          outcome = r.resolution;
        }
      } else if (e.type === "refund") {
        const pending = await ctx.runQuery(internal.providerWebhooks.pendingRefundsInternal, { transactionId: txn._id });
        if (pending.length > 0 && (e.status === "refunded" || e.status === "partially_refunded")) {
          await ctx.runMutation(internal.payments.completeRefundInternal, { refundId: pending[0].refundId, outcome: "successful", actor: `webhook:${providerId}` });
          outcome = "applied";
        } else {
          outcome = "noop";
        }
      } else if (e.type === "dispute") {
        const open = await ctx.runQuery(internal.providerWebhooks.openDisputeForTxnInternal, { transactionId: txn._id });
        if (e.status === "dispute_opened" && !open) {
          await ctx.runMutation(internal.disputes.openDisputeInternal, {
            orgId: txn.orgId,
            transactionId: txn._id,
            reasonCode: e.rawType,
            reasonDetails: `Opened by ${providerId} (event ${e.eventId})`,
          });
          outcome = "applied";
        } else if ((e.status === "dispute_won" || e.status === "dispute_lost") && open) {
          await ctx.runMutation(internal.disputes.resolveDisputeInternal, {
            orgId: txn.orgId,
            disputeId: open,
            outcome: e.status === "dispute_won" ? "won" : "lost",
            actor: `webhook:${providerId}`,
          });
          outcome = "applied";
        } else {
          outcome = "noop";
        }
      }
    } else if (e.type !== "other") {
      outcome = "unmatched";
      detail = `no transaction for providerReference=${e.providerReference ?? "-"} reference=${e.reference ?? "-"}`;
    }
    await ctx.runMutation(internal.providerWebhooks.recordEventInternal, {
      providerId,
      connectionKey,
      eventId: e.eventId,
      rawType: e.rawType,
      verified: true,
      outcome,
      transactionId: txId,
      detail,
    });
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});

export const pendingRefundsInternal = internalQuery({
  args: { transactionId: v.id("transactions") },
  handler: async (ctx, { transactionId }) =>
    (await ctx.db.query("refunds").withIndex("by_transaction", (q) => q.eq("transactionId", transactionId)).collect())
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt),
});

export const openDisputeForTxnInternal = internalQuery({
  args: { transactionId: v.id("transactions") },
  handler: async (ctx, { transactionId }) => {
    const rows = await ctx.db.query("disputes").withIndex("by_transaction", (q) => q.eq("transactionId", transactionId)).collect();
    const open = rows.find((d) => d.status === "OPEN" || d.status === "AWAITING_EVIDENCE" || d.status === "UNDER_REVIEW");
    return open?.disputeId ?? null;
  },
});
