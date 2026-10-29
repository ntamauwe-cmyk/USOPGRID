// Routing administration: rules (prefer / exclude / only), strategy weights,
// dry-run simulation and the decision log. Every change is audited and
// requires routing permission + MFA step-up.

import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requirePermissionFor, requireSensitive } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import { getAdapter, PAYMENT_METHODS } from "./providers/index";
import { route, DEFAULT_STRATEGY, type RoutingRule } from "./orchestration/router";
import { backtest as runBacktest, historyFromAttempts, scorecards as buildScorecards, SCORECARD_METHOD, MIN_SAMPLE } from "./lib/backtest";
import { isKnownCountry } from "../lib/geo";
import { isSupportedCurrency } from "../lib/money";
import { loadRoutingContext, type RoutingContext } from "./connections";

const matchValidator = v.object({
  countries: v.optional(v.array(v.string())),
  currencies: v.optional(v.array(v.string())),
  methods: v.optional(v.array(v.string())),
  minAmountMinor: v.optional(v.number()),
  maxAmountMinor: v.optional(v.number()),
  minRiskScore: v.optional(v.number()),
});
const actionValidator = v.object({
  type: v.union(v.literal("prefer"), v.literal("exclude"), v.literal("only")),
  providers: v.array(v.string()),
});

function validateRule(match: RoutingRule["match"], action: RoutingRule["action"]) {
  for (const c of match.countries ?? []) if (!isKnownCountry(c)) throw new ConvexError(`Unknown country ${c}`);
  for (const c of match.currencies ?? []) if (!isSupportedCurrency(c)) throw new ConvexError(`Unsupported currency ${c}`);
  for (const m of match.methods ?? []) if (!(PAYMENT_METHODS as readonly string[]).includes(m)) throw new ConvexError(`Unknown method ${m}`);
  if (match.minAmountMinor !== undefined && match.maxAmountMinor !== undefined && match.minAmountMinor > match.maxAmountMinor) {
    throw new ConvexError("Minimum amount exceeds maximum");
  }
  if (action.providers.length === 0) throw new ConvexError("Choose at least one provider");
  for (const p of action.providers) if (!getAdapter(p)) throw new ConvexError(`Unknown provider ${p}`);
}

export const listRules = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const rules = await ctx.db.query("routingRules").withIndex("by_org_order", (q) => q.eq("orgId", oc.orgId)).collect();
    return {
      rules,
      strategy: oc.org.routingStrategy ?? DEFAULT_STRATEGY,
      canEdit: oc.permissions.has(PERMISSIONS.ROUTING_MANAGE),
    };
  },
});

export const upsertRule = mutation({
  args: { ruleId: v.optional(v.id("routingRules")), name: v.string(), enabled: v.boolean(), match: matchValidator, action: actionValidator },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.ROUTING_MANAGE);
    const match = {
      ...a.match,
      countries: a.match.countries?.map((c) => c.toUpperCase()),
      currencies: a.match.currencies?.map((c) => c.toUpperCase()),
    };
    validateRule(match, a.action);
    const name = a.name.trim().slice(0, 80);
    if (!name) throw new ConvexError("Rule name is required");
    const now = Date.now();
    if (a.ruleId) {
      const existing = await ctx.db.get(a.ruleId);
      if (!existing || existing.orgId !== oc.orgId) throw new ConvexError("Rule not found");
      await ctx.db.patch(a.ruleId, { name, enabled: a.enabled, match, action: a.action, updatedAt: now, updatedBy: oc.userId });
      await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "routing_rule.updated", resource: "routing_rule", resourceId: a.ruleId, before: existing, after: { name, enabled: a.enabled, match, action: a.action } });
      return a.ruleId;
    }
    const last = await ctx.db.query("routingRules").withIndex("by_org_order", (q) => q.eq("orgId", oc.orgId)).order("desc").first();
    const id = await ctx.db.insert("routingRules", { orgId: oc.orgId, name, enabled: a.enabled, order: (last?.order ?? 0) + 10, match, action: a.action, createdAt: now, updatedAt: now, updatedBy: oc.userId });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "routing_rule.created", resource: "routing_rule", resourceId: id, after: { name, match, action: a.action } });
    return id;
  },
});

export const deleteRule = mutation({
  args: { ruleId: v.id("routingRules") },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.ROUTING_MANAGE);
    const r = await ctx.db.get(a.ruleId);
    if (!r || r.orgId !== oc.orgId) throw new ConvexError("Rule not found");
    await ctx.db.delete(a.ruleId);
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "routing_rule.deleted", resource: "routing_rule", resourceId: a.ruleId, before: r });
  },
});

export const moveRule = mutation({
  args: { ruleId: v.id("routingRules"), direction: v.union(v.literal("up"), v.literal("down")) },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.ROUTING_MANAGE);
    const rules = await ctx.db.query("routingRules").withIndex("by_org_order", (q) => q.eq("orgId", oc.orgId)).collect();
    const i = rules.findIndex((r) => r._id === a.ruleId);
    const j = a.direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rules.length) return;
    await ctx.db.patch(rules[i]._id, { order: rules[j].order, updatedAt: Date.now() });
    await ctx.db.patch(rules[j]._id, { order: rules[i].order, updatedAt: Date.now() });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "routing_rule.reordered", resource: "routing_rule", resourceId: a.ruleId, after: { direction: a.direction } });
  },
});

export const updateStrategy = mutation({
  args: { success: v.number(), cost: v.number(), latency: v.number(), maxAttempts: v.number() },
  handler: async (ctx, a) => {
    const oc = await requireSensitive(ctx, PERMISSIONS.ROUTING_MANAGE);
    const total = a.success + a.cost + a.latency;
    if ([a.success, a.cost, a.latency].some((w) => !Number.isFinite(w) || w < 0) || total <= 0) throw new ConvexError("Weights must be non-negative and not all zero");
    if (!Number.isInteger(a.maxAttempts) || a.maxAttempts < 1 || a.maxAttempts > 5) throw new ConvexError("Max providers per payment must be 1–5");
    const strategy = {
      weights: { success: round(a.success / total), cost: round(a.cost / total), latency: round(a.latency / total) },
      maxAttempts: a.maxAttempts,
    };
    await ctx.db.patch(oc.orgId, { routingStrategy: strategy });
    await logAudit(ctx, { orgId: oc.orgId, actor: oc.userId, action: "routing_strategy.updated", resource: "organization", resourceId: oc.orgId, before: oc.org.routingStrategy ?? DEFAULT_STRATEGY, after: strategy });
    return strategy;
  },
});

const round = (n: number) => Math.round(n * 1000) / 1000;

async function contextFor(ctx: QueryCtx, orgId: Id<"organizations">, environment: "sandbox" | "production"): Promise<RoutingContext> {
  return loadRoutingContext(ctx, orgId, environment);
}

/** Dry-run the router with the org's live configuration. Moves no money. */
export const simulate = query({
  args: { amountMinor: v.number(), currency: v.string(), method: v.string(), country: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const rc = await contextFor(ctx, oc.orgId, env);
    const candidates = rc.candidates.flatMap((c) => {
      const ad = getAdapter(c.providerId);
      return ad ? [{ ...c, descriptor: ad.descriptor }] : [];
    });
    const d = route({
      request: { amountMinor: Math.max(1, Math.round(a.amountMinor)), currency: a.currency.toUpperCase(), method: a.method, country: a.country?.toUpperCase() || undefined },
      candidates,
      stats: rc.stats,
      circuits: rc.circuits,
      rules: rc.rules,
      strategy: rc.strategy,
      now: Date.now(),
    });
    return { environment: env, ...d, evaluations: d.evaluations.map((e) => ({ ...e, displayName: getAdapter(e.providerId)?.descriptor.displayName ?? e.providerId })) };
  },
});

/** Recent routing decisions with outcomes (explainability log). */
export const recentDecisions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const rows = await ctx.db
      .query("routingDecisions")
      .withIndex("by_org_at", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(Math.min(a.limit ?? 50, 200));
    const out = [];
    for (const r of rows) {
      const t = await ctx.db.get(r.transactionId);
      out.push({
        at: r.at,
        transactionId: t?.transactionId ?? null,
        chain: r.chain.map((c) => c.providerId),
        decidedProvider: r.decidedProvider ?? null,
        outcome: r.outcome ?? null,
        explanation: r.explanation,
        matchedRules: r.matchedRules.length,
        failovers: t?.failoverCount ?? 0,
      });
    }
    return out;
  },
});

const WINDOWS = [7, 30, 90] as const;
const MAX_ROWS = 5000;

async function attemptsInWindow(ctx: QueryCtx, orgId: Id<"organizations">, environment: "sandbox" | "production", days: number) {
  const since = Date.now() - days * 86_400_000;
  const rows = await ctx.db
    .query("paymentAttempts")
    .withIndex("by_org_started", (q) => q.eq("orgId", orgId).gte("startedAt", since))
    .order("desc")
    .take(MAX_ROWS + 1);
  const truncated = rows.length > MAX_ROWS;
  return { rows: rows.slice(0, MAX_ROWS).filter((r) => r.environment === environment), since, truncated };
}

function windowDays(d: number | undefined) {
  return (WINDOWS as readonly number[]).includes(d ?? 30) ? (d ?? 30) : 30;
}

/**
 * Provider scorecards for a period. Every figure carries its sample size,
 * method and limitations; small samples are flagged, not hidden.
 */
export const scorecards = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const days = windowDays(a.days);
    const rc = await contextFor(ctx, oc.orgId, env);
    const { rows, since, truncated } = await attemptsInWindow(ctx, oc.orgId, env, days);
    const pricing = new Map(rc.candidates.map((c) => [c.connectionId, c.pricing ?? getAdapter(c.providerId)?.descriptor.pricing]));
    const cards = buildScorecards(rows, (id) => pricing.get(id) ?? undefined).map((c) => ({ ...c, displayName: getAdapter(c.providerId)?.descriptor.displayName ?? c.providerId }));
    return {
      environment: env,
      days,
      from: since,
      to: Date.now(),
      method: SCORECARD_METHOD,
      minSample: MIN_SAMPLE,
      truncated,
      dataSource: env === "sandbox" ? "Sandbox attempts against simulated rails. These scores describe the simulator, not real provider performance." : "Production attempts recorded by USOPGRID.",
      cards,
    };
  },
});

/**
 * Replay recent first attempts under a proposed policy and compare it with
 * the live one. Read-only: nothing is saved and no money moves.
 */
export const backtest = query({
  args: {
    days: v.optional(v.number()),
    disabledRuleIds: v.optional(v.array(v.string())),
    extraRule: v.optional(v.object({ match: matchValidator, action: actionValidator })),
    weights: v.optional(v.object({ success: v.number(), cost: v.number(), latency: v.number() })),
  },
  handler: async (ctx, a) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.ANALYTICS_VIEW);
    const env = (oc.org.environment ?? "sandbox") as "sandbox" | "production";
    const days = windowDays(a.days);
    const rc = await contextFor(ctx, oc.orgId, env);
    const candidates = rc.candidates.flatMap((c) => {
      const ad = getAdapter(c.providerId);
      return ad ? [{ ...c, descriptor: ad.descriptor }] : [];
    });
    let proposedRules = rc.rules.filter((r) => !(a.disabledRuleIds ?? []).includes(r.id));
    if (a.extraRule) {
      const match = { ...a.extraRule.match, countries: a.extraRule.match.countries?.map((c) => c.toUpperCase()), currencies: a.extraRule.match.currencies?.map((c) => c.toUpperCase()) };
      validateRule(match, a.extraRule.action);
      proposedRules = [{ id: "proposed", name: "Proposed rule", enabled: true, order: -1, match, action: a.extraRule.action }, ...proposedRules];
    }
    let strategy = rc.strategy;
    if (a.weights) {
      const w = a.weights;
      const total = w.success + w.cost + w.latency;
      if ([w.success, w.cost, w.latency].some((x) => !Number.isFinite(x) || x < 0) || total <= 0) throw new ConvexError("Weights must be non-negative and not all zero");
      strategy = { ...rc.strategy, weights: { success: w.success / total, cost: w.cost / total, latency: w.latency / total } };
    }
    const { rows, since, truncated } = await attemptsInWindow(ctx, oc.orgId, env, days);
    const history = historyFromAttempts(rows.map((r) => ({ ...r, transactionId: r.transactionId as string })));
    const result = runBacktest(history, candidates, rc.stats, { rules: rc.rules, strategy: rc.strategy }, { rules: proposedRules, strategy });
    const names = Object.fromEntries(candidates.map((c) => [c.providerId, c.descriptor.displayName]));
    return {
      label: "Simulated" as const,
      environment: env,
      days,
      from: since,
      to: Date.now(),
      truncated,
      payments: history.length,
      minSample: MIN_SAMPLE,
      providerNames: names,
      ...result,
      method: [
        "Each payment's first attempt in the period is routed again under the live and the proposed policy, assuming every provider was available.",
        "Where a policy picks the provider that actually handled the payment, the real outcome and latency are used (observed).",
        `Otherwise the outcome is estimated from that provider's first-attempt success rate for the same method and currency, smoothed toward 85% so small samples cannot dominate; estimates resting on fewer than ${MIN_SAMPLE} attempts are counted as low confidence.`,
        "Failover, customer behaviour, provider capacity and future price changes are not modelled. Treat this as a guide, not a forecast.",
      ],
      dataSource: env === "sandbox" ? "Sandbox history from simulated rails." : "Production history.",
    };
  },
});
