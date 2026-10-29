// Internal lookups used by service-layer actions. Kept separate so actions can
// hop between caller-authorized and engine-scoped functions cleanly.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const merchantByIdInternal = internalQuery({
  args: { merchantId: v.id("merchants") },
  handler: (ctx, args) => ctx.db.get(args.merchantId),
});

export const batchByIdInternal = internalQuery({
  args: { batchId: v.id("settlementBatches") },
  handler: (ctx, args) => ctx.db.get(args.batchId),
});

/** Membership + org resolution for action-context RBAC. */
export const membershipByUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (!membership) return null;
    const org = await ctx.db.get(membership.orgId);
    if (!org) return null;
    return { membership, org };
  },
});

export const insertApiKeyInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    mode: v.union(v.literal("secret"), v.literal("publishable")),
    prefix: v.string(),
    hash: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("apiKeys", {
      orgId: args.orgId,
      name: args.name,
      environment: args.environment,
      mode: args.mode,
      prefix: args.prefix,
      hash: args.hash,
      status: "active",
      createdByUserId: args.userId,
      createdAt: Date.now(),
    });
  },
});

/** Audit writer callable from actions via runMutation. */
export const auditInternal = internalMutation({
  args: {
    orgId: v.optional(v.id("organizations")),
    actor: v.string(),
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
      actor: args.actor,
      action: args.action,
      resource: args.resource,
      resourceId: args.resourceId,
      before: args.before,
      after: args.after,
      requestId: args.requestId,
      at: Date.now(),
    });
  },
});

export const apiKeyByIdInternal = internalQuery({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, { keyId }) => ctx.db.get(keyId),
});

export const expireApiKeyInternal = internalMutation({
  args: { keyId: v.id("apiKeys"), expiresAt: v.number(), rotatedToKeyId: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.keyId, { expiresAt: a.expiresAt, rotatedToKeyId: a.rotatedToKeyId });
  },
});
