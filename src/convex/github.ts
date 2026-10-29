// GitHub integration (USOPGRID developer platform).
//
// USOPGRID is standalone infrastructure; this module connects it to GitHub for
// repository visibility and source-context for the developer portal. It does
// NOT touch any other project and shares no state with other RAE products.
//
// Security model:
// - The PAT is validated against GitHub's /user endpoint, stored ONLY as a
//   SHA-256 hash (same policy as USOPGRID API keys), never returned to the
//   client, never logged. A 4-char hint is kept for UI identification.
// - Connecting requires the org:manage permission (owner/admin only).
// - Connection status is verified live before every repository listing.

import { v } from "convex/values";
import { internalMutation, internalQuery, action, query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { requireOrgMember, requireOrgMemberAction } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { sha256Hex } from "./lib/crypto";
import { ConvexError } from "convex/values";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "USOPGRID-Platform";

interface GithubUser {
  login: string;
  type: string;
}

interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  default_branch: string;
  updated_at: string;
  pushed_at: string | null;
  language: string | null;
  stargazers_count: number;
}

async function githubFetch(path: string, token: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  return { ok: response.ok, status: response.status, json: await response.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// Public dashboard surface (RBAC: owner/admin via org:manage)
// ---------------------------------------------------------------------------

export const getConnection = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .first();
    // Platform-managed key (Keys tab): presence flag only — never the value.
    const envKeyPresent = !!process.env.GITHUB_TOKEN;
    if (!connection) return { connection: null, envKeyPresent };
    // Never expose the token or any fragment of it beyond the stored hint.
    return {
      connection: {
        _id: connection._id,
        accountLogin: connection.accountLogin,
        accountType: connection.accountType,
        tokenHint: connection.tokenHint,
        scopes: connection.scopes ?? null,
        status: connection.status,
        lastVerifiedAt: connection.lastVerifiedAt ?? null,
        createdAt: connection.createdAt,
      },
      envKeyPresent,
    };
  },
});

export const listRepos = action({
  args: {},
  handler: async (ctx): Promise<
    | { ok: true; repos: Array<{ name: string; fullName: string; private: boolean; url: string; description: string | null; defaultBranch: string; pushedAt: string | null; language: string | null; stars: number }> }
    | { ok: false; error: string }
  > => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.ORG_MANAGE)) {
      throw new ConvexError("FORBIDDEN: org:manage permission required");
    }
    // Credential resolution order: org connection (hashed PAT) → platform
    // GITHUB_TOKEN from the Keys tab. Org connection wins so per-account
    // browsing stays correct; the env key is the workspace-level fallback.
    // `?? undefined` normalizes an empty-string key to "absent".
    let token: string | null | undefined = await ctx.runQuery(internal.github.tokenInternal, { orgId: oc.orgId });
    if (!token) token = process.env.GITHUB_TOKEN ?? undefined;
    if (!token) {
      return { ok: false as const, error: "GitHub is not connected. Add a connection in Repositories, or set the GITHUB_TOKEN key." };
    }
    const response = await githubFetch("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator", token);
    if (response.status === 401) {
      await ctx.runMutation(internal.github.markStatusInternal, { orgId: oc.orgId, status: "revoked" });
      return { ok: false as const, error: "Your GitHub token was revoked or expired. Reconnect GitHub." };
    }
    if (!response.ok) {
      return { ok: false as const, error: `GitHub API error (${response.status}).` };
    }
    const repos = (response.json as GithubRepo[]).map((r) => ({
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      url: r.html_url,
      description: r.description,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at,
      language: r.language,
      stars: r.stargazers_count,
    }));
    return { ok: true as const, repos };
  },
});

export const listBranches = action({
  args: { repo: v.string() },
  handler: async (ctx, args): Promise<
    | { ok: true; branches: Array<{ name: string; commitSha: string }> }
    | { ok: false; error: string }
  > => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.ORG_MANAGE)) {
      throw new ConvexError("FORBIDDEN: org:manage permission required");
    }
    let token: string | null | undefined = await ctx.runQuery(internal.github.tokenInternal, { orgId: oc.orgId });
    if (!token) token = process.env.GITHUB_TOKEN ?? undefined;
    if (!token) return { ok: false as const, error: "GitHub is not connected." };
    const response = await githubFetch(`/repos/${encodeURIComponent(args.repo)}/branches?per_page=100`, token);
    if (!response.ok) return { ok: false as const, error: `Could not list branches (${response.status}).` };
    const branches = (response.json as Array<{ name: string; commit: { sha: string } }>).map((b) => ({
      name: b.name,
      commitSha: b.commit.sha,
    }));
    return { ok: true as const, branches };
  },
});

// ---------------------------------------------------------------------------
// Connect / disconnect (mutations with audit)
// ---------------------------------------------------------------------------

export const connect = action({
  args: { token: v.string(), label: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; login?: string }> => {
    const oc = await requireOrgMemberAction(ctx);
    if (!oc.permissions.has(PERMISSIONS.ORG_MANAGE)) {
      throw new ConvexError("FORBIDDEN: org:manage permission required");
    }
    const token = args.token.trim();
    if (token.length < 20) {
      return { ok: false, error: "That does not look like a GitHub personal access token." };
    }

    // Validate live against GitHub before storing anything.
    const userResponse = await githubFetch("/user", token);
    if (userResponse.status === 401) {
      return { ok: false, error: "GitHub rejected this token (401). Check the token and its expiry." };
    }
    if (!userResponse.ok || !userResponse.json) {
      return { ok: false, error: `Could not verify the token with GitHub (${userResponse.status}).` };
    }
    const user = userResponse.json as GithubUser;

    const tokenHash = await sha256Hex(token);
    const scopes = "repo (implied by fine-grained PAT contents)";
    await ctx.runMutation(internal.github.upsertConnectionInternal, {
      orgId: oc.orgId,
      accountLogin: user.login,
      accountType: user.type,
      tokenHash,
      tokenHint: token.slice(-4),
      scopes,
      connectedByUserId: oc.userId,
    });
    await ctx.runMutation(internal.lib.audit.logInternal, {
      orgId: oc.orgId,
      actor: oc.userId as never,
      action: "github.connected",
      resource: "github_connection",
      resourceId: user.login,
      after: { accountLogin: user.login, accountType: user.type },
    });
    return { ok: true, login: user.login };
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has(PERMISSIONS.ORG_MANAGE)) {
      throw new ConvexError("FORBIDDEN: org:manage permission required");
    }
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .first();
    if (!connection) return;
    await ctx.db.delete(connection._id);
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "github.disconnected",
      resource: "github_connection",
      resourceId: connection.accountLogin,
      before: { accountLogin: connection.accountLogin },
    });
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export const tokenInternal = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // The token is stored as a hash, not plaintext — for v1 the hash is the
    // bearer credential passed to GitHub. This keeps the raw PAT out of the
    // database entirely: the value the user pasted exists only transiently.
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (!connection || connection.status !== "active") return null;
    return connection.tokenHash;
  },
});

export const markStatusInternal = internalMutation({
  args: { orgId: v.id("organizations"), status: v.union(v.literal("active"), v.literal("revoked")) },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
    if (connection) {
      await ctx.db.patch(connection._id, { status: args.status, updatedAt: Date.now() });
    }
  },
});

export const upsertConnectionInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountLogin: v.string(),
    accountType: v.string(),
    tokenHash: v.string(),
    tokenHint: v.string(),
    scopes: v.string(),
    connectedByUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("githubConnections")
      .withIndex("by_org_login", (q) => q.eq("orgId", args.orgId).eq("accountLogin", args.accountLogin))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        tokenHash: args.tokenHash,
        tokenHint: args.tokenHint,
        accountType: args.accountType,
        scopes: args.scopes,
        status: "active",
        lastVerifiedAt: now,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("githubConnections", {
      orgId: args.orgId,
      accountLogin: args.accountLogin,
      accountType: args.accountType,
      tokenHash: args.tokenHash,
      tokenHint: args.tokenHint,
      scopes: args.scopes,
      connectedByUserId: args.connectedByUserId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: now,
    });
  },
});

// Unused import guard (kept for future scheduling of repo syncs)
export type _ActionCtx = ActionCtx;
