// USOPGRID webhook dispatcher: signed payloads, exponential backoff,
// delivery history, dead-lettering. Driven by a cron job (crons.ts)
// and also triggerable immediately after payment events.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hmacSha256Hex } from "./lib/crypto";

const MAX_ATTEMPTS = 6;
const BACKOFF_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000];

// ---------------------------------------------------------------------------
// Claim a small batch of due deliveries (status pending/failed, nextAttemptAt due)
// ---------------------------------------------------------------------------
export const dueDeliveriesInternal = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_next", (q) => q.eq("status", "pending").lte("nextAttemptAt", args.now))
      .take(args.limit);
    const failed = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_next", (q) => q.eq("status", "failed").lte("nextAttemptAt", args.now))
      .take(args.limit);
    return [...pending, ...failed].slice(0, args.limit);
  },
});

export const attemptDeliveryInternal = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    const delivery = await ctx.runQuery(internal.webhooks.deliveryInternal, {
      deliveryId: args.deliveryId,
    });
    if (!delivery) return;
    if (delivery.status === "delivered" || delivery.status === "dead") return;

    const endpoint = await ctx.runQuery(internal.webhooks.endpointInternal, {
      endpointId: delivery.endpointId,
    });
    if (!endpoint || endpoint.status !== "active") {
      // Endpoint disabled: park the delivery; operators can re-enable or purge.
      await ctx.runMutation(internal.webhooks.deliveryResultInternal, {
        deliveryId: args.deliveryId,
        ok: false,
        responseStatus: undefined,
        error: "endpoint disabled",
        dead: false,
        retryInMs: 3_600_000,
      });
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const payloadString = JSON.stringify(delivery.payload);
    const signature = await hmacSha256Hex(endpoint.secret, `${timestamp}.${payloadString}`);

    const attempt = delivery.attempts + 1;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "USOPGRID-Webhooks/2.0 (+https://usopgrid.com/developers#webhooks)",
          "X-USOPGRID-Signature": `t=${timestamp},v1=${signature}`,
          "X-USOPGRID-Event": delivery.event,
          ...(delivery.eventId ? { "X-USOPGRID-Event-Id": delivery.eventId } : {}),
          "X-USOPGRID-Delivery-Attempt": String(attempt),
        },
        body: payloadString,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const ok = response.status >= 200 && response.status < 300;
      await ctx.runMutation(internal.webhooks.deliveryResultInternal, {
        deliveryId: args.deliveryId,
        ok,
        responseStatus: response.status,
        error: ok ? undefined : `HTTP ${response.status}`,
        dead: !ok && attempt >= MAX_ATTEMPTS,
        retryInMs: ok ? undefined : BACKOFF_STEPS_MS[Math.min(attempt - 1, BACKOFF_STEPS_MS.length - 1)],
      });
    } catch (err) {
      await ctx.runMutation(internal.webhooks.deliveryResultInternal, {
        deliveryId: args.deliveryId,
        ok: false,
        responseStatus: undefined,
        error: err instanceof Error ? err.message : "network error",
        dead: attempt >= MAX_ATTEMPTS,
        retryInMs: BACKOFF_STEPS_MS[Math.min(attempt - 1, BACKOFF_STEPS_MS.length - 1)],
      });
    }
  },
});

export const deliveryInternal = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => ctx.db.get(args.deliveryId),
});

export const endpointInternal = internalQuery({
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, args) => ctx.db.get(args.endpointId),
});

export const deliveryResultInternal = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    ok: v.boolean(),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    dead: v.boolean(),
    retryInMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliveryId);
    if (!d) return;
    await ctx.db.patch(args.deliveryId, {
      status: args.ok ? "delivered" : args.dead ? "dead" : "failed",
      responseStatus: args.responseStatus,
      lastError: args.error,
      nextAttemptAt: args.ok || args.dead ? undefined : Date.now() + (args.retryInMs ?? 60_000),
    });
  },
});

// Cron entrypoint: dispatch all due deliveries (bounded batch per tick).
export const dispatchDue = internalAction({
  args: {},
  handler: async (ctx): Promise<{ dispatched: number }> => {
    const now = Date.now();
    const due = (await ctx.runQuery(internal.webhooks.dueDeliveriesInternal, {
      now,
      limit: 20,
    })) as { _id: Id<"webhookDeliveries">; attempts: number }[];
    for (const d of due) {
      if (d.attempts >= MAX_ATTEMPTS + 1) {
        await ctx.runMutation(internal.webhooks.deadLetterInternal, { deliveryId: d._id });
        continue;
      }
      await ctx.runMutation(internal.webhooks.bumpAttemptInternal, { deliveryId: d._id });
      await ctx.runAction(internal.webhooks.attemptDeliveryInternal, { deliveryId: d._id });
    }
    return { dispatched: due.length };
  },
});

export const bumpAttemptInternal = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliveryId);
    if (!d) return;
    await ctx.db.patch(args.deliveryId, { attempts: d.attempts + 1 });
  },
});

export const deadLetterInternal = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, { status: "dead", lastError: "max attempts reached" });
  },
});

// Replay a dead or failed delivery back into the queue (dashboard action).
export const replayDelivery = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: undefined,
    });
  },
});
