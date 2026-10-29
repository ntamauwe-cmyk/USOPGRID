// USOPGRID FX service — rate snapshots, USD-equivalents and expiring quotes.
//
// Rates refresh on a schedule from pluggable sources (premium provider when
// configured, then ECB reference rates, then a broad-coverage open source).
// Quotes lock a customer rate for a short TTL; charging with an expired quote
// is refused. USOPGRID never invents a rate.

import { v, ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  FX_SOURCES,
  buildQuote,
  configuredPremiumSource,
  convertAtMid,
  isSnapshotFresh,
  mergeSnapshots,
  pairRate,
  type RateSnapshot,
} from "./lib/fx";
import { requireOrgMember } from "./lib/rbac";
import { isSupportedCurrency } from "../lib/money";
import { randomToken } from "./lib/crypto";

export const FX_BASE = "USD";
export const DEFAULT_SPREAD_BPS = 50;
export const QUOTE_TTL_MS = 5 * 60_000;

export const refreshRatesInternal = internalAction({
  args: {},
  handler: async (ctx) => {
    const sources = [configuredPremiumSource(process.env.FX_RATE_PROVIDER_URL, process.env.FX_RATE_PROVIDER_KEY), ...FX_SOURCES].filter(
      (s): s is NonNullable<typeof s> => s !== null,
    );
    const got: RateSnapshot[] = [];
    const errors: string[] = [];
    for (const s of sources) {
      try {
        got.push(await s.fetchRates(FX_BASE, fetch));
      } catch (err) {
        errors.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const merged = mergeSnapshots(got);
    if (!merged) {
      console.error("[fx] every rate source failed", errors);
      return { ok: false, errors };
    }
    await ctx.runMutation(internal.fxrates.storeSnapshotInternal, {
      base: merged.base,
      source: merged.source,
      rates: merged.rates,
      sourceTimestamp: merged.timestamp,
    });
    return { ok: true, currencies: Object.keys(merged.rates).length, errors };
  },
});

export const storeSnapshotInternal = internalMutation({
  args: { base: v.string(), source: v.string(), rates: v.any(), sourceTimestamp: v.number() },
  handler: async (ctx, a) => {
    await ctx.db.insert("fxRateSnapshots", { ...a, fetchedAt: Date.now() });
    // Keep the last 60 snapshots for audit; older ones are pruned.
    const old = await ctx.db
      .query("fxRateSnapshots")
      .withIndex("by_base_fetched", (q) => q.eq("base", a.base))
      .order("desc")
      .collect();
    for (const row of old.slice(60)) await ctx.db.delete(row._id);
  },
});

async function latest(ctx: QueryCtx): Promise<RateSnapshot | null> {
  const row = await ctx.db
    .query("fxRateSnapshots")
    .withIndex("by_base_fetched", (q) => q.eq("base", FX_BASE))
    .order("desc")
    .first();
  return row ? { base: row.base, rates: row.rates as Record<string, string>, source: row.source, timestamp: row.sourceTimestamp } : null;
}

export const latestSnapshotInternal = internalQuery({
  args: {},
  handler: async (ctx) => latest(ctx),
});

/** USD-cent equivalent at mid-market for risk scoring and analytics; null if unknown or stale. */
export const usdEquivalentInternal = internalQuery({
  args: { amountMinor: v.number(), currency: v.string() },
  handler: async (ctx, { amountMinor, currency }) => {
    if (currency === "USD") return amountMinor;
    const snap = await latest(ctx);
    if (!snap || !isSnapshotFresh(snap, Date.now())) return null;
    return convertAtMid(snap, amountMinor, currency, "USD") ?? null;
  },
});

export const ratesOverview = query({
  args: { quote: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx);
    const snap = await latest(ctx);
    if (!snap) return null;
    const codes = args.quote?.length ? args.quote : ["EUR", "GBP", "NGN", "KES", "GHS", "ZAR", "INR", "BRL", "MXN", "JPY", "CNY", "AED", "IDR", "PHP"];
    return {
      base: snap.base,
      source: snap.source,
      sourceTimestamp: snap.timestamp,
      fresh: isSnapshotFresh(snap, Date.now()),
      coverage: Object.keys(snap.rates).length,
      rates: codes.map((c) => ({ currency: c, rate: pairRate(snap, snap.base, c) ?? null })),
    };
  },
});

async function makeQuote(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  from: string,
  to: string,
  amountMinor: number,
  spreadBps: number,
) {
  if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) throw new ConvexError(`VALIDATION_ERROR: unsupported currency pair ${from}/${to}`);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new ConvexError("VALIDATION_ERROR: amount must be a positive integer of minor units");
  const snap = await latest(ctx);
  const now = Date.now();
  if (!snap) throw new ConvexError("FX_UNAVAILABLE: no exchange-rate snapshot yet");
  if (!isSnapshotFresh(snap, now)) throw new ConvexError("FX_UNAVAILABLE: exchange rates are stale; refusing to quote");
  const mid = pairRate(snap, from, to);
  if (!mid) throw new ConvexError(`FX_UNAVAILABLE: no rate for ${from}/${to}`);
  const q = buildQuote({ from, to, amountMinor, midRate: mid, spreadBps, source: snap.source, sourceTimestamp: snap.timestamp, now, ttlMs: QUOTE_TTL_MS });
  const quoteId = `fxq_${randomToken(20)}`;
  await ctx.db.insert("fxQuotes", {
    orgId,
    quoteId,
    from: q.from,
    to: q.to,
    midRate: q.midRate,
    rate: q.rate,
    spreadBps: q.spreadBps,
    sourceAmountMinor: q.sourceAmountMinor,
    targetAmountMinor: q.targetAmountMinor,
    spreadCostMinor: q.spreadCostMinor,
    source: q.source,
    sourceTimestamp: q.sourceTimestamp,
    expiresAt: q.expiresAt,
    createdAt: q.createdAt,
  });
  return { quoteId, ...q };
}

function orgSpreadBps(): number {
  const n = Number(process.env.USOPGRID_FX_SPREAD_BPS ?? DEFAULT_SPREAD_BPS);
  return Number.isInteger(n) && n >= 0 && n < 2000 ? n : DEFAULT_SPREAD_BPS;
}

export const createQuoteInternal = internalMutation({
  args: { orgId: v.id("organizations"), from: v.string(), to: v.string(), amountMinor: v.number() },
  handler: async (ctx, a) => makeQuote(ctx, a.orgId, a.from.toUpperCase(), a.to.toUpperCase(), a.amountMinor, orgSpreadBps()),
});

export const createQuote = mutation({
  args: { from: v.string(), to: v.string(), amountMinor: v.number() },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    return makeQuote(ctx, oc.orgId, a.from.toUpperCase(), a.to.toUpperCase(), a.amountMinor, orgSpreadBps());
  },
});

/** Lock a quote to a transaction. Fails if expired, used, or for another org. */
export const consumeQuoteInternal = internalMutation({
  args: { orgId: v.id("organizations"), quoteId: v.string(), transactionId: v.string() },
  handler: async (ctx, a) => {
    const q = await ctx.db
      .query("fxQuotes")
      .withIndex("by_quote_id", (x) => x.eq("quoteId", a.quoteId))
      .unique();
    if (!q || q.orgId !== a.orgId) throw new ConvexError("VALIDATION_ERROR: unknown FX quote");
    if (q.usedByTransactionId) throw new ConvexError("CONFLICT: FX quote already used");
    if (Date.now() >= q.expiresAt) throw new ConvexError("VALIDATION_ERROR: FX quote expired; request a new one");
    await ctx.db.patch(q._id, { usedByTransactionId: a.transactionId });
    return q;
  },
});
