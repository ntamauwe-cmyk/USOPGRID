// USOPGRID org bootstrap + tenant context.
//
// The dashboard session is scoped to exactly one organization. On first
// sign-in an org + merchant are provisioned automatically, so a merchant can
// take their first payment within seconds. All dashboard queries resolve
// tenant context through requireOrgMember — data isolation is enforced
// server-side, never by the UI.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireOrgMember, getOrgForMember, isPlatformAdmin, requireSensitive, requirePermissionFor } from "./lib/rbac";
import { ROLE_PERMISSIONS, ROLE_LABELS, PERMISSIONS, roleValidator } from "./schema";
import { isKnownCountry, getCountry } from "../lib/geo";
import { generateApiKey, hashApiKey } from "./lib/apikeys";
import { logAudit } from "./lib/audit";
import { CURRENCIES, isSupportedCurrency } from "../lib/money";

// ---------------------------------------------------------------------------
// Bootstrap: get-or-create the caller's organization + default merchant
// ---------------------------------------------------------------------------
export const bootstrapOrg = mutation({
  args: {
    orgName: v.optional(v.string()),
    currency: v.optional(v.string()),
    country: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("UNAUTHENTICATED");

    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("UNAUTHENTICATED");

    const existing = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) {
      return { orgId: existing.orgId, role: existing.role, created: false };
    }

    // Pending invitation for this email → join that organization.
    const email = user.email?.toLowerCase();
    if (email) {
      const invite = await ctx.db
        .query("orgInvitations")
        .withIndex("by_email_status", (q) => q.eq("email", email).eq("status", "pending"))
        .first();
      if (invite && invite.expiresAt > Date.now()) {
        await ctx.db.insert("orgMembers", { orgId: invite.orgId, userId, role: invite.role, joinedAt: Date.now() });
        await ctx.db.patch(invite._id, { status: "accepted", acceptedAt: Date.now() });
        await logAudit(ctx, { orgId: invite.orgId, actor: userId, action: "member.joined", resource: "orgMember", resourceId: userId, after: { email, role: invite.role } });
        return { orgId: invite.orgId, role: invite.role, created: false };
      }
    }

    const orgName = args.orgName?.trim() || user.name || "My Organization";
    const country = args.country && isKnownCountry(args.country) ? args.country.toUpperCase() : undefined;
    // Default settlement currency: explicit choice → country's currency → USD.
    const fromCountry = country ? getCountry(country)?.currency : undefined;
    const currency =
      args.currency && isSupportedCurrency(args.currency)
        ? args.currency
        : fromCountry && isSupportedCurrency(fromCountry)
          ? fromCountry
          : "USD";

    const orgId = await ctx.db.insert("organizations", {
      name: orgName,
      slug: `org_${userId.slice(-8)}_${Date.now().toString(36)}`,
      environment: "sandbox",
      settings: { currency },
      country,
      status: "active",
      createdByUserId: userId,
    });

    await ctx.db.insert("orgMembers", {
      orgId,
      userId,
      role: "owner",
      joinedAt: Date.now(),
    });

    const merchantId = await ctx.db.insert("merchants", {
      orgId,
      name: orgName,
      status: "active",
      defaultCurrency: currency,
      feeBps: 150, // 1.5% default — configurable per merchant later
      feeFixedMinor: 0,
      createdByUserId: userId,
    });

    await logAudit(ctx, {
      orgId,
      actor: userId,
      action: "org.created",
      resource: "organization",
      resourceId: orgId,
      after: { name: orgName, merchantId },
    });

    return { orgId, role: "owner" as const, created: true };
  },
});

// ---------------------------------------------------------------------------
// Context for the dashboard shell
// ---------------------------------------------------------------------------
export const getOrgContext = query({
  args: {},
  handler: async (ctx) => {
    const oc = await getOrgForMember(ctx);
    if (!oc) return null;
    return {
      org: {
        _id: oc.org._id,
        name: oc.org.name,
        environment: oc.org.environment ?? "sandbox",
        settings: oc.org.settings,
        country: oc.org.country ?? null,
        status: oc.org.status ?? "active",
      },
      roleLabel: ROLE_LABELS[oc.role] ?? oc.role,
      isPlatformAdmin: Boolean(await isPlatformAdmin(ctx)),
      role: oc.role,
      permissions: Array.from(oc.permissions),
      member: { _id: oc.member._id, role: oc.member.role },
    };
  },
});

export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .collect();
    return Promise.all(
      members.map(async (m) => {
        const u = await ctx.db.get(m.userId);
        return {
          _id: m._id,
          userId: m.userId,
          name: u?.name ?? u?.email ?? "Member",
          email: u?.email ?? null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// Team management (RBAC)
// ---------------------------------------------------------------------------
export const updateMemberRole = mutation({
  args: { memberId: v.id("orgMembers"), role: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.ORG_MANAGE);
    const validRoles = Object.keys(ROLE_PERMISSIONS);
    if (!validRoles.includes(args.role)) {
      throw new ConvexError(`VALIDATION_ERROR: unknown role '${args.role}'`);
    }
    const member = await ctx.db.get(args.memberId);
    if (!member || member.orgId !== oc.orgId) {
      throw new ConvexError("NOT_FOUND: member does not belong to this organization");
    }
    if (args.role === "owner" && oc.role !== "owner") throw new ConvexError("FORBIDDEN: only an owner can grant the owner role");
    if (member.role === "owner" && args.role !== "owner") {
      const owners = await ctx.db
        .query("orgMembers")
        .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
        .collect();
      if (owners.filter((m) => m.role === "owner").length <= 1) {
        throw new ConvexError("CONFLICT: an organization must keep at least one owner");
      }
    }
    const before = member.role;
    await ctx.db.patch(args.memberId, { role: args.role as never });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "member.role_changed",
      resource: "orgMember",
      resourceId: args.memberId,
      before: { role: before },
      after: { role: args.role },
    });
  },
});

// ---------------------------------------------------------------------------
// Merchant configuration
// ---------------------------------------------------------------------------
export const listMerchants = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .collect();
  },
});

export const updateMerchantFees = mutation({
  args: {
    merchantId: v.id("merchants"),
    feeBps: v.number(),
    feeFixedMinor: v.number(),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has("org:manage")) {
      throw new ConvexError("FORBIDDEN: missing permission 'org:manage'");
    }
    const merchant = await ctx.db.get(args.merchantId);
    if (!merchant || merchant.orgId !== oc.orgId) {
      throw new ConvexError("NOT_FOUND");
    }
    if (args.feeBps < 0 || args.feeBps > 10_000 || !Number.isInteger(args.feeBps)) {
      throw new ConvexError("VALIDATION_ERROR: feeBps must be an integer between 0 and 10000");
    }
    await ctx.db.patch(args.merchantId, {
      feeBps: args.feeBps,
      feeFixedMinor: Math.max(0, Math.round(args.feeFixedMinor)),
    });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "merchant.fees_updated",
      resource: "merchant",
      resourceId: args.merchantId,
      before: { feeBps: merchant.feeBps, feeFixedMinor: merchant.feeFixedMinor },
      after: { feeBps: args.feeBps, feeFixedMinor: args.feeFixedMinor },
    });
  },
});

export const updateOrgEnvironment = mutation({
  args: { environment: v.union(v.literal("sandbox"), v.literal("production")) },
  handler: async (ctx, args) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.ORG_MANAGE);
    if (args.environment === "production" && (oc.org.status ?? "active") !== "active") {
      throw new ConvexError(`FORBIDDEN: organization is ${oc.org.status}; live processing is disabled`);
    }
    if (args.environment === "production") {
      const user = await ctx.db.get(oc.userId);
      if (!user?.email || user.isAnonymous) {
        throw new ConvexError("FORBIDDEN: sign in with a verified email address before going live");
      }
    }
    await ctx.db.patch(oc.orgId, { environment: args.environment });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "org.environment_changed",
      resource: "organization",
      resourceId: oc.orgId,
      after: { environment: args.environment },
    });
  },
});

export const supportedCurrencies = query({
  args: {},
  handler: async () => Object.values(CURRENCIES),
});

// ---------------------------------------------------------------------------
// Invitations, removal, organization profile
// ---------------------------------------------------------------------------
export const roles = query({
  args: {},
  handler: async () =>
    Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label, permissions: ROLE_PERMISSIONS[id as keyof typeof ROLE_PERMISSIONS] })),
});

export const listInvitations = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.TEAM_INVITE);
    const rows = await ctx.db.query("orgInvitations").withIndex("by_org", (q) => q.eq("orgId", oc.orgId)).collect();
    return rows.filter((r) => r.status === "pending").map((r) => ({ _id: r._id, email: r.email, role: r.role, expiresAt: r.expiresAt, createdAt: r.createdAt }));
  },
});

export const inviteMember = mutation({
  args: { email: v.string(), role: roleValidator },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.TEAM_INVITE);
    const email = a.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ConvexError("Enter a valid email address");
    if (a.role === "owner" && oc.role !== "owner") throw new ConvexError("Only an owner can invite another owner");
    const user = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).first();
    if (user) {
      const m = await ctx.db.query("orgMembers").withIndex("by_user", (q) => q.eq("userId", user._id)).first();
      if (m) throw new ConvexError(m.orgId === oc.orgId ? "Already a member" : "This user already belongs to another organization");
    }
    const pending = await ctx.db.query("orgInvitations").withIndex("by_email_status", (q) => q.eq("email", email).eq("status", "pending")).first();
    if (pending) await ctx.db.patch(pending._id, { status: "revoked" });
    const id = await ctx.db.insert("orgInvitations", { orgId: oc.orgId, email, role: a.role, status: "pending", invitedBy: oc.userId, expiresAt: Date.now() + 7 * 86_400_000, createdAt: Date.now() });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "team.invited", resource: "invitation", resourceId: id, after: { email, role: a.role } });
    return id;
  },
});

export const revokeInvitation = mutation({
  args: { invitationId: v.id("orgInvitations") },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.TEAM_INVITE);
    const inv = await ctx.db.get(a.invitationId);
    if (!inv || inv.orgId !== oc.orgId) throw new ConvexError("Invitation not found");
    await ctx.db.patch(a.invitationId, { status: "revoked" });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "team.invitation_revoked", resource: "invitation", resourceId: a.invitationId, before: { email: inv.email } });
  },
});

export const removeMember = mutation({
  args: { memberId: v.id("orgMembers") },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.ORG_MANAGE);
    const m = await ctx.db.get(a.memberId);
    if (!m || m.orgId !== oc.orgId) throw new ConvexError("Member not found");
    if (m.userId === oc.userId) throw new ConvexError("You cannot remove yourself");
    if (m.role === "owner") {
      if (oc.role !== "owner") throw new ConvexError("Only an owner can remove an owner");
      const owners = (await ctx.db.query("orgMembers").withIndex("by_org", (q) => q.eq("orgId", oc.orgId)).collect()).filter((x) => x.role === "owner");
      if (owners.length <= 1) throw new ConvexError("An organization must keep at least one owner");
    }
    await ctx.db.delete(a.memberId);
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "member.removed", resource: "orgMember", resourceId: a.memberId, before: { userId: m.userId, role: m.role } });
  },
});

export const updateOrgProfile = mutation({
  args: { name: v.optional(v.string()), country: v.optional(v.string()), maxTransactionUsd: v.optional(v.union(v.number(), v.null())) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ORG_MANAGE);
    const patch: Record<string, unknown> = {};
    if (a.name !== undefined) {
      const n = a.name.trim();
      if (n.length < 2 || n.length > 120) throw new ConvexError("Name must be 2–120 characters");
      patch.name = n;
    }
    if (a.country !== undefined) {
      if (!isKnownCountry(a.country)) throw new ConvexError("Unknown country");
      patch.country = a.country.toUpperCase();
    }
    if (a.maxTransactionUsd !== undefined) {
      if (a.maxTransactionUsd !== null && (!Number.isFinite(a.maxTransactionUsd) || a.maxTransactionUsd <= 0)) throw new ConvexError("Limit must be positive");
      patch.maxTransactionMinor = a.maxTransactionUsd === null ? undefined : Math.round(a.maxTransactionUsd * 100);
    }
    await ctx.db.patch(oc.orgId, patch);
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "org.profile_updated", resource: "organization", resourceId: oc.orgId, before: { name: oc.org.name, country: oc.org.country, maxTransactionMinor: oc.org.maxTransactionMinor }, after: patch });
  },
});

export const orgProfile = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return { name: oc.org.name, country: oc.org.country ?? null, environment: oc.org.environment ?? "sandbox", status: oc.org.status ?? "active", maxTransactionUsd: oc.org.maxTransactionMinor !== undefined ? oc.org.maxTransactionMinor / 100 : null, currency: oc.org.settings?.currency ?? "USD", canEdit: oc.permissions.has(PERMISSIONS.ORG_MANAGE) };
  },
});
