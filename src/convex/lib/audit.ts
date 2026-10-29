// USOPGRID audit system. Everything important is auditable:
// actor, action, resource, before/after, request id, timestamp.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";

export async function logAudit(
  ctx: MutationCtx,
  entry: {
    orgId?: string;
    actor: string;
    action: string;
    resource: string;
    resourceId?: string;
    before?: unknown;
    after?: unknown;
    requestId?: string;
  },
) {
  await ctx.db.insert("auditLogs", {
    orgId: entry.orgId as never,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    before: entry.before as never,
    after: entry.after as never,
    requestId: entry.requestId,
    at: Date.now(),
  });
}

// Action-context audit: actions have no db, so they call this internal
// mutation. Actors may be a userId or a system string ("api", "risk_engine").
export const logInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: v.union(v.id("users"), v.string()),
    action: v.string(),
    resource: v.string(),
    resourceId: v.optional(v.string()),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", {
      orgId: args.orgId,
      actor: args.actor as never,
      action: args.action,
      resource: args.resource,
      resourceId: args.resourceId,
      before: args.before as never,
      after: args.after as never,
      requestId: args.requestId,
      at: Date.now(),
    });
  },
});
