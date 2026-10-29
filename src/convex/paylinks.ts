// USOPGRID payment links — shareable checkout. linkId is public;
// checkout resolves it through an unauthenticated query exposing only
// non-sensitive fields. Payments through a link use the standard engine.
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireOrgMember, } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { randomToken } from "./lib/crypto";

// ---------------------------------------------------------------------------
// Dashboard surface
// ---------------------------------------------------------------------------
export const listPaymentLinks = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("paymentLinks")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(100);
  },
});

export const resolveLinkContext = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const merchant = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .first();
    if (!merchant) throw new ConvexError("No merchant configured for this organization");
    return { orgId: oc.orgId, merchantId: merchant._id };
  },
});

export const createPaymentLink = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    amountMinor: v.optional(v.number()),
    currency: v.string(),
    expiresAt: v.optional(v.number()),
    maxUses: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const merchant = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .first();
    if (!merchant) throw new ConvexError("VALIDATION_ERROR: no merchant configured");

    const title = args.title.trim();
    if (!title) throw new ConvexError("VALIDATION_ERROR: title is required");
    if (args.amountMinor !== undefined && (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0)) {
      throw new ConvexError("VALIDATION_ERROR: amount must be a positive integer of minor units");
    }
    if (args.maxUses !== undefined && (!Number.isInteger(args.maxUses) || args.maxUses <= 0)) {
      throw new ConvexError("VALIDATION_ERROR: maxUses must be a positive integer");
    }

    const linkId = `pl_${randomToken(10)}`;
    const id = await ctx.db.insert("paymentLinks", {
      orgId: oc.orgId,
      merchantId: merchant._id,
      linkId,
      title,
      description: args.description?.trim() || undefined,
      amountMinor: args.amountMinor,
      currency: args.currency,
      status: "active",
      expiresAt: args.expiresAt,
      maxUses: args.maxUses,
      useCount: 0,
      successCount: 0,
      createdByUserId: oc.userId,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "payment_link.created",
      resource: "paymentLink",
      resourceId: id,
      after: { linkId, title, amountMinor: args.amountMinor, currency: args.currency },
    });
    return { _id: id, linkId };
  },
});

export const togglePaymentLink = mutation({
  args: { linkId: v.id("paymentLinks") },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const link = await ctx.db.get(args.linkId);
    if (!link || link.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");
    const status = link.status === "active" ? "disabled" : "active";
    await ctx.db.patch(args.linkId, { status });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "payment_link.status_changed",
      resource: "paymentLink",
      resourceId: args.linkId,
      after: { status },
    });
  },
});

// ---------------------------------------------------------------------------
// Public checkout resolution (no auth — exposes only safe fields)
// ---------------------------------------------------------------------------
export const publicLinkInternal = internalQuery({
  args: { linkId: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_link_id", (q) => q.eq("linkId", args.linkId))
      .unique();
    if (!link) return null;
    const merchant = await ctx.db.get(link.merchantId);
    return {
      linkId: link.linkId,
      title: link.title,
      description: link.description ?? null,
      amountMinor: link.amountMinor ?? null,
      currency: link.currency,
      status: link.status,
      expired: link.expiresAt !== undefined && link.expiresAt < Date.now(),
      usesExhausted: link.maxUses !== undefined && link.useCount >= link.maxUses,
      merchantName: merchant?.name ?? "Merchant",
    };
  },
});

export const recordLinkAttemptInternal = internalMutation({
  args: { linkId: v.string(), successful: v.boolean() },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_link_id", (q) => q.eq("linkId", args.linkId))
      .unique();
    if (!link) return;
    await ctx.db.patch(link._id, {
      useCount: link.useCount + 1,
      successCount: link.successCount + (args.successful ? 1 : 0),
    });
  },
});
