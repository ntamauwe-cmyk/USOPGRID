// USOPGRID customers module — auto-upserted from payment activity.
// AUDIT FIX: lifetime volume is tracked per currency; mixing NGN and USD minor
// units into one scalar was a financial misstatement.
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireOrgMember } from "./lib/rbac";
import { logAudit } from "./lib/audit";
import { PERMISSIONS } from "./schema";

type VolumeMap = Record<string, number>;

function volumesOf(raw: unknown): VolumeMap {
  return raw && typeof raw === "object" ? { ...(raw as VolumeMap) } : {};
}

// ---------------------------------------------------------------------------
// Risk-engine velocity counters. Internal — called by the
// payment engine before processing. Reads are bounded by index windows.
// ---------------------------------------------------------------------------
export const riskSignalsInternal = internalQuery({
  args: {
    orgId: v.id("organizations"),
    customerEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const email = args.customerEmail?.toLowerCase();

    let customerTxns10m = 0;
    let customerFailed30m = 0;
    if (email) {
      const recent = await ctx.db
        .query("transactions")
        .withIndex("by_org_email_created", (q) =>
          q.eq("orgId", args.orgId).eq("customerEmail", email).gte("createdAt", now - 30 * 60_000),
        )
        .collect();
      customerTxns10m = recent.filter((t) => t.createdAt >= now - 10 * 60_000).length;
      customerFailed30m = recent.filter((t) => t.status === "FAILED").length;
    }

    const orgRecent = await ctx.db
      .query("transactions")
      .withIndex("by_org_created", (q) =>
        q.eq("orgId", args.orgId).gte("createdAt", now - 60_000),
      )
      .take(200);
    const orgTxns1m = orgRecent.length;

    return { customerTxns10m, customerFailed30m, orgTxns1m };
  },
});

// ---------------------------------------------------------------------------
// Dashboard surface
// ---------------------------------------------------------------------------
export const listCustomers = query({
  args: {
    paginationOpts: v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("customers")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getCustomer = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_org_email", (q) => q.eq("orgId", oc.orgId).eq("email", args.email.toLowerCase()))
      .unique();
    if (!customer) return null;

    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org_email_created", (q) =>
        q.eq("orgId", oc.orgId).eq("customerEmail", args.email.toLowerCase()),
      )
      .order("desc")
      .take(20);

    return {
      customer: {
        _id: customer._id,
        email: customer.email,
        name: customer.name ?? null,
        status: customer.status,
        transactionCount: customer.transactionCount,
        successfulCount: customer.successfulCount,
        lifetimeVolumeByCurrency: volumesOf(customer.lifetimeVolumeByCurrency),
        createdAt: customer.createdAt,
      },
      transactions: txns.map((t) => ({
        _id: t._id,
        transactionId: t.transactionId,
        reference: t.reference,
        amountMinor: t.amountMinor,
        currency: t.currency,
        status: t.status,
        paymentMethod: t.paymentMethod,
        createdAt: t.createdAt,
      })),
    };
  },
});

export const updateCustomerStatus = mutation({
  args: { customerId: v.id("customers"), status: v.union(v.literal("active"), v.literal("blocked")) },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.PAYMENTS_CREATE)) {
      throw new ConvexError("FORBIDDEN: missing permission 'payments:create'");
    }
    const c = await ctx.db.get(args.customerId);
    if (!c || c.orgId !== oc.orgId) throw new ConvexError("NOT_FOUND");
    await ctx.db.patch(args.customerId, { status: args.status, updatedAt: Date.now() });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "customer.status_changed",
      resource: "customer",
      resourceId: args.customerId,
      after: { status: args.status },
    });
  },
});

// ---------------------------------------------------------------------------
// Engine internals — called by the payment engine on every transaction
// ---------------------------------------------------------------------------
export const upsertCustomerInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    email: v.string(),
    name: v.optional(v.string()),
    successful: v.boolean(),
    volumeMinor: v.number(),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!email.includes("@")) return;

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_org_email", (q) => q.eq("orgId", args.orgId).eq("email", email))
      .unique();

    // Per-currency volume map: mixing currencies into one number would be a
    // financial misstatement (audit fix). New currencies add a key.
    const volumes: VolumeMap = volumesOf(existing?.lifetimeVolumeByCurrency);
    if (args.successful) {
      volumes[args.currency] = (volumes[args.currency] ?? 0) + args.volumeMinor;
    }

    if (!existing) {
      await ctx.db.insert("customers", {
        orgId: args.orgId,
        email,
        name: args.name,
        status: "active",
        transactionCount: 1,
        successfulCount: args.successful ? 1 : 0,
        lifetimeVolumeByCurrency: volumes,
        lastTransactionAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return;
    }

    await ctx.db.patch(existing._id, {
      name: args.name ?? existing.name,
      transactionCount: existing.transactionCount + 1,
      successfulCount: existing.successfulCount + (args.successful ? 1 : 0),
      lifetimeVolumeByCurrency: volumes,
      lastTransactionAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// Refund path: reduce the customer's lifetime volume for the refunded currency
// only, bounded at zero so a reconciliation bug can never create negative volume.
export const refundCustomerVolumeInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    email: v.optional(v.string()),
    refundedMinor: v.number(),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.email || !args.email.includes("@")) return;
    const email = args.email.trim().toLowerCase();
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_org_email", (q) => q.eq("orgId", args.orgId).eq("email", email))
      .unique();
    if (!existing) return;

    const volumes: VolumeMap = volumesOf(existing.lifetimeVolumeByCurrency);
    const current = volumes[args.currency] ?? 0;
    volumes[args.currency] = Math.max(0, current - args.refundedMinor);

    await ctx.db.patch(existing._id, {
      lifetimeVolumeByCurrency: volumes,
      updatedAt: Date.now(),
    });
  },
});
