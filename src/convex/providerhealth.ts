// USOPGRID provider health — per provider/environment/day charge
// aggregates. Feeds the dashboard and, later, the routing engine's health
// signals. Record path is fire-and-forget from the payment engine.
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireOrgMember } from "./lib/rbac";

function utcDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export const recordChargeInternal = internalMutation({
  args: {
    provider: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    outcome: v.union(v.literal("successful"), v.literal("failed"), v.literal("pending")),
    latencyMs: v.number(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const day = utcDay(Date.now());
    const existing = await ctx.db
      .query("providerHealth")
      .withIndex("by_provider_env_day", (q) =>
        q.eq("provider", args.provider).eq("environment", args.environment).eq("day", day),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("providerHealth", {
        provider: args.provider,
        environment: args.environment,
        day,
        charges: 1,
        successful: args.outcome === "successful" ? 1 : 0,
        failed: args.outcome === "failed" ? 1 : 0,
        pending: args.outcome === "pending" ? 1 : 0,
        latencySumMs: Math.max(Math.round(args.latencyMs), 0),
        lastErrorAt: args.outcome === "failed" ? Date.now() : undefined,
        lastErrorMessage: args.errorMessage,
        updatedAt: Date.now(),
      });
      return;
    }
    await ctx.db.patch(existing._id, {
      charges: existing.charges + 1,
      successful: existing.successful + (args.outcome === "successful" ? 1 : 0),
      failed: existing.failed + (args.outcome === "failed" ? 1 : 0),
      pending: existing.pending + (args.outcome === "pending" ? 1 : 0),
      latencySumMs: existing.latencySumMs + Math.max(Math.round(args.latencyMs), 0),
      lastErrorAt: args.outcome === "failed" ? Date.now() : existing.lastErrorAt,
      lastErrorMessage: args.errorMessage ?? existing.lastErrorMessage,
      updatedAt: Date.now(),
    });
  },
});

// Dashboard view — recent days for the signed-in org's environment.
export const listProviderHealth = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx);
    const days = args.days ?? 7;
    const since = Date.now() - days * 86_400_000;
    const rows = await ctx.db.query("providerHealth").collect();
    return rows
      .filter((r) => r.updatedAt >= since)
      .sort((a, b) => (a.day < b.day ? -1 : 1));
  },
});
