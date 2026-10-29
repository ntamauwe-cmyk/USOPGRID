// Signed merchant webhooks for events that are not about a single payment
// (subscriptions, invoices, saved payment methods). Same delivery pipeline,
// retries and signature as payment events.
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { randomToken } from "./crypto";

export async function enqueueOrgEvent(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  livemode: boolean,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const eventId = `evt_${randomToken(24)}`;
  const payload = { id: eventId, event, created_at: new Date().toISOString(), livemode, data };
  for (const ep of endpoints) {
    if (ep.status !== "active") continue;
    if (!ep.events.includes(event) && !ep.events.includes("*")) continue;
    await ctx.db.insert("webhookDeliveries", {
      orgId,
      endpointId: ep._id,
      event,
      eventId,
      payload,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
    });
  }
}
