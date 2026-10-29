// Internal helpers for the public HTTP service layer. Actions call these via
// runQuery / runMutation because actions have no db access.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

// Atomic per-key rate-limit consume: check + increment + lastUsedAt in ONE
// mutation so Convex's OCC retry loop serializes access to the counter doc.
// (A read-then-write split across separate query/mutation functions causes
// conflict storms and spurious 500s under concurrent bursts.)
export const consumeRateLimitInternal = internalMutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.apiKeyId);
    if (!key) return { ok: false, retryAfterMs: RATE_WINDOW_MS };
    const now = Date.now();
    const inWindow = !!key.rateWindowEnd && now < key.rateWindowEnd;
    if (inWindow && (key.rateWindowCount ?? 0) >= RATE_LIMIT) {
      return { ok: false, retryAfterMs: Math.max(1, (key.rateWindowEnd ?? now) - now) };
    }
    if (inWindow) {
      await ctx.db.patch(args.apiKeyId, {
        rateWindowCount: (key.rateWindowCount ?? 0) + 1,
        lastUsedAt: now,
      });
    } else {
      await ctx.db.patch(args.apiKeyId, {
        rateWindowCount: 1,
        rateWindowEnd: now + RATE_WINDOW_MS,
        lastUsedAt: now,
      });
    }
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

/** Per-key daily usage metering (requests, 4xx, 5xx, per route). */
export const meterInternal = internalMutation({
  args: { apiKeyId: v.id("apiKeys"), orgId: v.id("organizations"), route: v.string(), status: v.number() },
  handler: async (ctx, a) => {
    const day = new Date().toISOString().slice(0, 10);
    const row = await ctx.db
      .query("apiUsage")
      .withIndex("by_key_day", (q) => q.eq("apiKeyId", a.apiKeyId).eq("day", day))
      .unique();
    const e4 = a.status >= 400 && a.status < 500 ? 1 : 0;
    const e5 = a.status >= 500 ? 1 : 0;
    if (!row) {
      await ctx.db.insert("apiUsage", {
        orgId: a.orgId,
        apiKeyId: a.apiKeyId,
        day,
        requests: 1,
        errors4xx: e4,
        errors5xx: e5,
        byRoute: { [a.route]: 1 },
        updatedAt: Date.now(),
      });
      return;
    }
    const byRoute = { ...(row.byRoute as Record<string, number>) };
    byRoute[a.route] = (byRoute[a.route] ?? 0) + 1;
    await ctx.db.patch(row._id, {
      requests: row.requests + 1,
      errors4xx: row.errors4xx + e4,
      errors5xx: row.errors5xx + e5,
      byRoute,
      updatedAt: Date.now(),
    });
  },
});
