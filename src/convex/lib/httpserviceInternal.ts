// Internal helpers for the public HTTP service layer. Actions call these via
// runQuery / runMutation because actions have no db access.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

import { DEFAULT_RATE_LIMIT, RATE_WINDOW_MS, USAGE_SHARDS, shardCount, shardLimit } from "./ratelimit";

const RATE_LIMIT = DEFAULT_RATE_LIMIT;

// Per-key rate-limit consume. The limit comes from the authenticated key, so
// this never reads or writes the key record itself; it touches one shard row
// (see lib/ratelimit), so concurrent requests from a busy key rarely collide.
export const consumeRateLimitInternal = internalMutation({
  args: { apiKeyId: v.id("apiKeys"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? RATE_LIMIT;
    const shards = shardCount(limit);
    const shard = shards === 1 ? 0 : Math.floor(Math.random() * shards);
    const cap = shardLimit(limit, shards, shard);
    const now = Date.now();
    const row = await ctx.db
      .query("rateShards")
      .withIndex("by_key_shard", (q) => q.eq("apiKeyId", args.apiKeyId).eq("shard", shard))
      .unique();
    if (!row) {
      await ctx.db.insert("rateShards", { apiKeyId: args.apiKeyId, shard, count: 1, windowEnd: now + RATE_WINDOW_MS });
      return { ok: true, retryAfterMs: 0 };
    }
    if (row.windowEnd <= now) {
      await ctx.db.patch(row._id, { count: 1, windowEnd: now + RATE_WINDOW_MS });
      return { ok: true, retryAfterMs: 0 };
    }
    if (row.count >= cap) return { ok: false, retryAfterMs: Math.max(1, row.windowEnd - now) };
    await ctx.db.patch(row._id, { count: row.count + 1 });
    return { ok: true, retryAfterMs: 0 };
  },
});

export { RATE_LIMIT, RATE_WINDOW_MS };

/**
 * Generic fixed-window limiter for unauthenticated surfaces (checkout, inbound
 * webhooks). One document per bucket; atomic under Convex OCC.
 */
export const consumeBucketInternal = internalMutation({
  args: { bucket: v.string(), limit: v.number(), windowMs: v.number() },
  handler: async (ctx, a) => {
    const now = Date.now();
    const row = await ctx.db.query("rateBuckets").withIndex("by_bucket", (q) => q.eq("bucket", a.bucket)).unique();
    if (!row || row.windowEnd <= now) {
      if (row) await ctx.db.patch(row._id, { count: 1, windowEnd: now + a.windowMs });
      else await ctx.db.insert("rateBuckets", { bucket: a.bucket, count: 1, windowEnd: now + a.windowMs });
      return { ok: true, retryAfterMs: 0 };
    }
    if (row.count >= a.limit) return { ok: false, retryAfterMs: Math.max(1, row.windowEnd - now) };
    await ctx.db.patch(row._id, { count: row.count + 1 });
    return { ok: true, retryAfterMs: 0 };
  },
});

/** Cron: drop expired buckets. */
export const purgeBucketsInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("rateBuckets").withIndex("by_window_end", (q) => q.lt("windowEnd", Date.now() - 60_000)).take(500);
    for (const r of old) await ctx.db.delete(r._id);
    return old.length;
  },
});

/**
 * Per-key daily usage metering (requests, 4xx, 5xx, per route), spread over
 * a few rows per key and day so a busy key's requests do not all write one
 * record; readers add the rows up. Also keeps the key's lastUsedAt, written
 * at most once a minute.
 */
export const meterInternal = internalMutation({
  args: { apiKeyId: v.id("apiKeys"), orgId: v.id("organizations"), route: v.string(), status: v.number() },
  handler: async (ctx, a) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const shard = Math.floor(Math.random() * USAGE_SHARDS);
    const row = await ctx.db
      .query("apiUsage")
      .withIndex("by_key_day_shard", (q) => q.eq("apiKeyId", a.apiKeyId).eq("day", day).eq("shard", shard))
      .unique();
    const e4 = a.status >= 400 && a.status < 500 ? 1 : 0;
    const e5 = a.status >= 500 ? 1 : 0;
    if (!row) {
      await ctx.db.insert("apiUsage", { orgId: a.orgId, apiKeyId: a.apiKeyId, day, shard, requests: 1, errors4xx: e4, errors5xx: e5, byRoute: { [a.route]: 1 }, updatedAt: now });
    } else {
      const byRoute = { ...(row.byRoute as Record<string, number>) };
      byRoute[a.route] = (byRoute[a.route] ?? 0) + 1;
      await ctx.db.patch(row._id, { requests: row.requests + 1, errors4xx: row.errors4xx + e4, errors5xx: row.errors5xx + e5, byRoute, updatedAt: now });
    }
    const key = await ctx.db.get(a.apiKeyId);
    if (key && (key.lastUsedAt === undefined || now - key.lastUsedAt > 60_000)) await ctx.db.patch(a.apiKeyId, { lastUsedAt: now });
  },
});
