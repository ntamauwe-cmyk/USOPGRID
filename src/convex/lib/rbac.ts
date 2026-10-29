// USOPGRID RBAC — permission-level access control, enforced server-side.
// Roles map to permission sets; callers check permissions, not roles.
// Sensitive operations additionally require a recent MFA step-up when the
// organization's security policy (or the user's own enrollment) demands it.

import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx, ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { ROLE_PERMISSIONS, type Role } from "../schema";

export interface OrgContext {
  userId: Id<"users">;
  orgId: Id<"organizations">;
  role: Role;
  permissions: Set<string>;
  member: Doc<"orgMembers">;
  org: Doc<"organizations">;
}

type AnyCtx = QueryCtx | MutationCtx;

/** Resolve the caller's organization membership. Returns null when unauthenticated or org-less. */
export async function getOrgForMember(ctx: AnyCtx): Promise<OrgContext | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;

  const membership = await ctx.db
    .query("orgMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (!membership) return null;

  const org = await ctx.db.get(membership.orgId);
  if (!org) return null;

  const permissions = new Set(ROLE_PERMISSIONS[membership.role as Role] ?? []);
  for (const extra of membership.permissions ?? []) permissions.add(extra);

  return {
    userId,
    orgId: org._id,
    role: membership.role as Role,
    permissions,
    member: membership,
    org,
  };
}

export async function requireOrgMember(ctx: AnyCtx): Promise<OrgContext> {
  const oc = await getOrgForMember(ctx);
  if (!oc) throw new ConvexError("UNAUTHENTICATED: no organization membership for this session");
  return oc;
}

/**
 * Action-context variant: actions have no `db`, so membership is resolved via
 * an internal query and rebuilt into the same OrgContext shape.
 */
export async function requireOrgMemberAction(ctx: ActionCtx): Promise<OrgContext> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("UNAUTHENTICATED");
  const resolved = await ctx.runQuery(internal.servicesInternal.membershipByUserInternal, { userId });
  if (!resolved) throw new ConvexError("UNAUTHENTICATED: no organization membership for this session");
  const permissions = new Set(ROLE_PERMISSIONS[resolved.membership.role as Role] ?? []);
  for (const extra of resolved.membership.permissions ?? []) permissions.add(extra);
  return {
    userId,
    orgId: resolved.org._id,
    role: resolved.membership.role as Role,
    permissions,
    member: resolved.membership,
    org: resolved.org,
  };
}

export function requirePermission(oc: OrgContext, permission: string): void {
  if (!oc.permissions.has(permission)) {
    throw new ConvexError(`FORBIDDEN: missing permission '${permission}'`);
  }
}

export async function requirePermissionFor(
  ctx: AnyCtx,
  permission: string,
): Promise<OrgContext> {
  const oc = await requireOrgMember(ctx);
  requirePermission(oc, permission);
  return oc;
}

// ---------------------------------------------------------------------------
// MFA step-up for sensitive actions (provider credentials, routing, keys,
// refunds, role changes). Required when the org policy says so, or when the
// acting user has enrolled MFA (enrolled users always step up).
// ---------------------------------------------------------------------------
export const STEP_UP_WINDOW_MS = 15 * 60_000;

export async function requireStepUp(ctx: AnyCtx, oc: OrgContext): Promise<void> {
  const mfa = await ctx.db
    .query("userMfa")
    .withIndex("by_user", (q) => q.eq("userId", oc.userId))
    .unique();
  const enrolled = mfa?.status === "enabled";
  const policy = oc.org.security?.requireMfaForSensitive === true;
  if (!enrolled && !policy) return;
  if (!enrolled) throw new ConvexError("MFA_REQUIRED: your organization requires multi-factor authentication for this action. Enable it under Security.");
  if (!mfa.verifiedUntil || mfa.verifiedUntil < Date.now()) {
    throw new ConvexError("MFA_STEP_UP: confirm with your authenticator code to continue.");
  }
}

export async function requireSensitive(ctx: AnyCtx, permission: string): Promise<OrgContext> {
  const oc = await requirePermissionFor(ctx, permission);
  await requireStepUp(ctx, oc);
  return oc;
}

// ---------------------------------------------------------------------------
// Platform operators (USOPGRID staff) — operations console access.
// Configured with USOPGRID_PLATFORM_ADMINS="a@x.com,b@y.com".
// ---------------------------------------------------------------------------
export function platformAdminEmails(): Set<string> {
  return new Set(
    (process.env.USOPGRID_PLATFORM_ADMINS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function isPlatformAdmin(ctx: AnyCtx): Promise<{ userId: Id<"users">; email: string } | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  const email = user?.email?.toLowerCase();
  if (!email || !platformAdminEmails().has(email)) return null;
  return { userId, email };
}

export async function requirePlatformAdmin(ctx: AnyCtx): Promise<{ userId: Id<"users">; email: string }> {
  const admin = await isPlatformAdmin(ctx);
  if (!admin) throw new ConvexError("FORBIDDEN: USOPGRID operations console is restricted to platform operators");
  return admin;
}
