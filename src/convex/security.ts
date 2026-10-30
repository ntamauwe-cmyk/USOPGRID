// Account security: TOTP multi-factor authentication (RFC 6238) with step-up
// for sensitive actions, recovery codes, and organization security policy.

import { v, ConvexError } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { generateTotpSecret, randomToken, sha256Hex, verifyTotp } from "./lib/crypto";
import { seal, open, keyringConfigured } from "./lib/keyring";
import type { ActionCtx } from "./_generated/server";
import { requireOrgMember, requirePermissionFor, requireStepUp, STEP_UP_WINDOW_MS } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";

/** 10 code attempts per user per 15 minutes (TOTP and recovery codes alike). */
async function limitAttempts(ctx: ActionCtx, userId: string): Promise<void> {
  const r = (await ctx.runMutation(internal.lib.httpserviceInternal.consumeBucketInternal, { bucket: `mfa_attempt:${userId}`, limit: 10, windowMs: 15 * 60_000 })) as { ok: boolean; retryAfterMs: number };
  if (!r.ok) throw new ConvexError(`Too many attempts. Try again in ${Math.ceil(r.retryAfterMs / 60_000)} minute(s).`);
}

function requireEncryption(): void {
  if (!keyringConfigured()) throw new ConvexError("MFA is unavailable: the encryption key is not configured.");
}

export const status = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const mfa = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", oc.userId)).unique();
    return {
      mfaEnabled: mfa?.status === "enabled",
      stepUpActiveUntil: mfa?.verifiedUntil && mfa.verifiedUntil > Date.now() ? mfa.verifiedUntil : null,
      recoveryCodesRemaining: mfa?.recoveryCodeHashes?.length ?? 0,
      orgPolicy: { requireMfaForSensitive: oc.org.security?.requireMfaForSensitive ?? false },
      canManagePolicy: oc.permissions.has(PERMISSIONS.SECURITY_MANAGE),
      encryptionConfigured: keyringConfigured(),
    };
  },
});

export const mfaRowInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
});

export const userEmailInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => (await ctx.db.get(userId))?.email ?? null,
});

export const savePendingInternal = internalMutation({
  args: { userId: v.id("users"), sealedSecret: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", a.userId)).unique();
    if (row?.status === "enabled") throw new ConvexError("MFA is already enabled");
    if (row) await ctx.db.replace(row._id, { userId: a.userId, sealedSecret: a.sealedSecret, status: "pending", createdAt: Date.now() });
    else await ctx.db.insert("userMfa", { userId: a.userId, sealedSecret: a.sealedSecret, status: "pending", createdAt: Date.now() });
  },
});

/** Start enrollment: returns the otpauth:// URI (shown as QR) and the secret once. */
export const beginEnrollment = action({
  args: {},
  handler: async (ctx): Promise<{ otpauthUrl: string; secret: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("UNAUTHENTICATED");
    const email: string | null = await ctx.runQuery(internal.security.userEmailInternal, { userId });
    const secret = generateTotpSecret();
    await ctx.runMutation(internal.security.savePendingInternal, { userId, sealedSecret: (requireEncryption(), await seal(secret, `mfa:${userId}`)) });
    const label = encodeURIComponent(`USOPGRID:${email ?? userId}`);
    return { otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=USOPGRID&algorithm=SHA1&digits=6&period=30`, secret };
  },
});

export const recordVerificationInternal = internalMutation({
  args: { userId: v.id("users"), counter: v.number(), enable: v.boolean(), recoveryCodeHashes: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", a.userId)).unique();
    if (!row) throw new ConvexError("MFA not enrolled");
    // Replay protection: a code (time step) can be used once.
    if (row.lastUsedCounter !== undefined && a.counter <= row.lastUsedCounter) throw new ConvexError("This code was already used. Wait for the next one.");
    await ctx.db.patch(row._id, {
      lastUsedCounter: a.counter,
      verifiedUntil: Date.now() + STEP_UP_WINDOW_MS,
      ...(a.enable ? { status: "enabled" as const, enabledAt: Date.now(), recoveryCodeHashes: a.recoveryCodeHashes } : {}),
    });
    if (a.enable) {
      await ctx.db.insert("auditLogs", { actor: a.userId, action: "security.mfa_enabled", resource: "user", resourceId: a.userId, at: Date.now() });
    }
  },
});

/** Confirm enrollment or step up. Returns recovery codes once, on enrollment. */
export const verifyCode = action({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<{ ok: true; recoveryCodes?: string[]; stepUpUntil: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("UNAUTHENTICATED");
    const row = await ctx.runQuery(internal.security.mfaRowInternal, { userId });
    if (!row) throw new ConvexError("MFA not enrolled");
    await limitAttempts(ctx, userId);
    const secret = (requireEncryption(), await open(row.sealedSecret, `mfa:${userId}`));
    const counter = await verifyTotp(secret, code.replace(/\s+/g, ""), Date.now());
    if (counter === null) throw new ConvexError("Invalid code");
    let recoveryCodes: string[] | undefined;
    let hashes: string[] | undefined;
    if (row.status === "pending") {
      recoveryCodes = Array.from({ length: 8 }, () => `${randomToken(5)}-${randomToken(5)}`.toLowerCase());
      hashes = await Promise.all(recoveryCodes.map((c) => sha256Hex(`usopgrid-recovery:${c}`)));
    }
    await ctx.runMutation(internal.security.recordVerificationInternal, { userId, counter, enable: row.status === "pending", recoveryCodeHashes: hashes });
    return { ok: true, recoveryCodes, stepUpUntil: Date.now() + STEP_UP_WINDOW_MS };
  },
});

export const replaceRecoveryCodesInternal = internalMutation({
  args: { userId: v.id("users"), hashes: v.array(v.string()) },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", a.userId)).unique();
    if (row?.status !== "enabled") throw new ConvexError("Turn on MFA first.");
    await ctx.db.patch(row._id, { recoveryCodeHashes: a.hashes });
    await ctx.db.insert("auditLogs", { actor: a.userId, action: "security.recovery_codes_regenerated", resource: "user", resourceId: a.userId, at: Date.now() });
  },
});

/**
 * Replace all recovery codes with a new set, shown once. Needs a current
 * authenticator code (not a recovery code), so a stolen session or a used-up
 * recovery code cannot mint new ones.
 */
export const regenerateRecoveryCodes = action({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<{ recoveryCodes: string[] }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("UNAUTHENTICATED");
    const row = await ctx.runQuery(internal.security.mfaRowInternal, { userId });
    if (row?.status !== "enabled") throw new ConvexError("Turn on MFA first.");
    await limitAttempts(ctx, userId);
    const secret = (requireEncryption(), await open(row.sealedSecret, `mfa:${userId}`));
    const counter = await verifyTotp(secret, code.replace(/\s+/g, ""), Date.now());
    if (counter === null) throw new ConvexError("Invalid code");
    await ctx.runMutation(internal.security.recordVerificationInternal, { userId, counter, enable: false });
    const recoveryCodes = Array.from({ length: 8 }, () => `${randomToken(5)}-${randomToken(5)}`.toLowerCase());
    const hashes = await Promise.all(recoveryCodes.map((c) => sha256Hex(`usopgrid-recovery:${c}`)));
    await ctx.runMutation(internal.security.replaceRecoveryCodesInternal, { userId, hashes });
    return { recoveryCodes };
  },
});

export const useRecoveryCodeInternal = internalMutation({
  args: { userId: v.id("users"), hash: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", a.userId)).unique();
    if (!row?.recoveryCodeHashes?.includes(a.hash)) throw new ConvexError("Invalid recovery code");
    await ctx.db.patch(row._id, { recoveryCodeHashes: row.recoveryCodeHashes.filter((h) => h !== a.hash), verifiedUntil: Date.now() + STEP_UP_WINDOW_MS });
    await ctx.db.insert("auditLogs", { actor: a.userId, action: "security.recovery_code_used", resource: "user", resourceId: a.userId, at: Date.now() });
  },
});

export const useRecoveryCode = action({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("UNAUTHENTICATED");
    await limitAttempts(ctx, userId);
    await ctx.runMutation(internal.security.useRecoveryCodeInternal, { userId: userId as Id<"users">, hash: await sha256Hex(`usopgrid-recovery:${code.trim().toLowerCase()}`) });
    return { ok: true };
  },
});

/** Disabling MFA itself requires a fresh step-up. */
export const disableMfa = mutation({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    await requireStepUp(ctx, oc);
    if (oc.org.security?.requireMfaForSensitive) throw new ConvexError("Your organization requires MFA; it cannot be disabled.");
    const row = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", oc.userId)).unique();
    if (row) await ctx.db.delete(row._id);
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "security.mfa_disabled", resource: "user", resourceId: oc.userId });
  },
});

export const updateOrgPolicy = mutation({
  args: { requireMfaForSensitive: v.boolean() },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.SECURITY_MANAGE);
    await requireStepUp(ctx, oc);
    if (a.requireMfaForSensitive) {
      const own = await ctx.db.query("userMfa").withIndex("by_user", (q) => q.eq("userId", oc.userId)).unique();
      if (own?.status !== "enabled") throw new ConvexError("Enable MFA on your own account before requiring it for the organization.");
    }
    const security = { ...(oc.org.security ?? {}), requireMfaForSensitive: a.requireMfaForSensitive };
    await ctx.db.patch(oc.orgId, { security });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "security.policy_updated", resource: "organization", resourceId: oc.orgId, before: oc.org.security ?? {}, after: security });
  },
});

/** Security events visible to the org: auth/security audit entries + rejected inbound webhooks. */
export const securityEvents = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.AUDIT_VIEW);
    const logs = await ctx.db.query("auditLogs").withIndex("by_org_at", (q) => q.eq("orgId", oc.orgId)).order("desc").take(300);
    return logs
      .filter((l) => /^(security\.|key\.|api_key\.|provider_connection\.|routing_|member\.|team\.)/.test(l.action))
      .slice(0, 100)
      .map((l) => ({ at: l.at, actor: l.actor, action: l.action, resource: l.resource, resourceId: l.resourceId ?? null }));
  },
});
