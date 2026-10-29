// USOPGRID provider connections — routing context, credential resolution,
// circuit breakers and per-attempt telemetry.
//
// A "connection" is a set of credentials for one provider in one environment.
// Three sources feed the router, in this order of precedence:
//   1. org connections   — credentials the merchant added in the dashboard
//   2. platform env vars — USOPGRID's own accounts (STRIPE_SECRET_KEY, …)
//   3. sandbox rails     — always present in the sandbox environment only
// Production can NEVER see a sandbox rail, and sandbox can never see live
// credentials: environment is part of every lookup.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAdapter, listDescriptors, envCredentialsFor, SANDBOX_PROVIDER_IDS } from "./providers/index";
import type { AdapterContext, Environment, ProviderAdapter, FailureInfo } from "./providers/types";
import { failure } from "./providers/types";
import { CLOSED, beginProbe, isAvailable, recordOutcome, type CircuitState, type CircuitOutcome } from "./orchestration/circuit";
import { DEFAULT_STRATEGY, type Candidate, type ProviderStats, type RoutingRule, type RoutingStrategy } from "./orchestration/router";
import { openSecret } from "./lib/crypto";

const envValidator = v.union(v.literal("sandbox"), v.literal("production"));

export function platformConnectionId(providerId: string, env: Environment): string {
  return `platform:${providerId}:${env}`;
}

export function parsePlatformConnectionId(id: string): { providerId: string; environment: Environment } | null {
  const m = /^platform:([a-z0-9_]+):(sandbox|production)$/.exec(id);
  return m ? { providerId: m[1], environment: m[2] as Environment } : null;
}

/** Env-var credentials for the platform account. Sandbox reads `<VAR>_SANDBOX`. */
export function platformCredentials(providerId: string, env: Environment): Record<string, string> | null {
  const adapter = getAdapter(providerId);
  if (!adapter || SANDBOX_PROVIDER_IDS.has(providerId)) return null;
  const vars: Record<string, string | undefined> = {};
  for (const name of Object.values(adapter.descriptor.envCredentials)) {
    vars[name] = env === "production" ? process.env[name] : process.env[`${name}_SANDBOX`];
  }
  return envCredentialsFor(adapter.descriptor, vars);
}

export interface RoutingContext {
  candidates: Omit<Candidate, "descriptor">[];
  stats: Record<string, ProviderStats>;
  circuits: Record<string, CircuitState>;
  rules: RoutingRule[];
  strategy: RoutingStrategy;
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Everything the router needs for one org + environment, in one read. */
export const routingContextInternal = internalQuery({
  args: { orgId: v.id("organizations"), environment: envValidator },
  handler: async (ctx, { orgId, environment }): Promise<RoutingContext> => loadRoutingContext(ctx, orgId, environment),
});

export async function loadRoutingContext(ctx: QueryCtx, orgId: Id<"organizations">, environment: Environment): Promise<RoutingContext> {
    const org = await ctx.db.get(orgId);
    const orgConns = await ctx.db
      .query("providerConnections")
      .withIndex("by_org_env", (q) => q.eq("orgId", orgId).eq("environment", environment))
      .collect();
    const platformConns = await ctx.db
      .query("providerConnections")
      .withIndex("by_org_env", (q) => q.eq("orgId", undefined).eq("environment", environment))
      .collect();

    const candidates: RoutingContext["candidates"] = [];
    const seenPlatform = new Set<string>();
    for (const c of [...orgConns, ...platformConns]) {
      if (!getAdapter(c.providerId)) continue;
      if (c.status === "disabled") continue;
      candidates.push({
        providerId: c.providerId,
        connectionId: c.connectionKey,
        priority: c.priority,
        enabled: c.enabled,
        pricing: c.pricing,
      });
      if (!c.orgId) seenPlatform.add(c.providerId);
    }
    for (const d of listDescriptors()) {
      if (SANDBOX_PROVIDER_IDS.has(d.id)) {
        if (environment === "sandbox") {
          candidates.push({
            providerId: d.id,
            connectionId: platformConnectionId(d.id, environment),
            priority: d.id === "sandbox" ? 10 : 0,
            enabled: true,
          });
        }
        continue;
      }
      if (seenPlatform.has(d.id)) continue;
      if (platformCredentials(d.id, environment)) {
        candidates.push({ providerId: d.id, connectionId: platformConnectionId(d.id, environment), priority: 0, enabled: true });
      }
    }

    // Historical performance: last 14 UTC days per provider.
    const stats: Record<string, ProviderStats> = {};
    const since = utcDay(Date.now() - 14 * 86_400_000);
    for (const providerId of new Set(candidates.map((c) => c.providerId))) {
      const rows = await ctx.db
        .query("providerHealth")
        .withIndex("by_provider_env_day", (q) => q.eq("provider", providerId).eq("environment", environment).gte("day", since))
        .collect();
      const attempts = rows.reduce((a, r) => a + r.charges, 0);
      const successes = rows.reduce((a, r) => a + r.successful, 0);
      const latency = rows.reduce((a, r) => a + r.latencySumMs, 0);
      if (attempts > 0) stats[providerId] = { attempts, successes, avgLatencyMs: Math.round(latency / attempts) };
    }

    const circuits: Record<string, CircuitState> = {};
    for (const c of candidates) {
      const row = await ctx.db
        .query("circuitStates")
        .withIndex("by_connection", (q) => q.eq("connectionId", c.connectionId))
        .unique();
      if (row) circuits[c.connectionId] = toCircuit(row);
    }

    const ruleRows = await ctx.db
      .query("routingRules")
      .withIndex("by_org_order", (q) => q.eq("orgId", orgId))
      .collect();
    const rules: RoutingRule[] = ruleRows.map((r) => ({
      id: r._id,
      name: r.name,
      enabled: r.enabled,
      order: r.order,
      match: r.match,
      action: r.action,
    }));

    return { candidates, stats, circuits, rules, strategy: org?.routingStrategy ?? DEFAULT_STRATEGY };
}

function toCircuit(row: Doc<"circuitStates">): CircuitState {
  return {
    state: row.state,
    consecutiveFailures: row.consecutiveFailures,
    openedAt: row.openedAt,
    nextProbeAt: row.nextProbeAt,
    cooldownMs: row.cooldownMs,
    lastFailureReason: row.lastFailureReason,
  };
}

async function loadCircuit(ctx: MutationCtx, connectionId: string) {
  const row = await ctx.db
    .query("circuitStates")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .unique();
  return { row, state: row ? toCircuit(row) : CLOSED };
}

async function saveCircuit(
  ctx: MutationCtx,
  existing: Doc<"circuitStates"> | null,
  connectionId: string,
  providerId: string,
  s: CircuitState,
) {
  const doc = {
    connectionId,
    providerId,
    state: s.state,
    consecutiveFailures: s.consecutiveFailures,
    openedAt: s.openedAt,
    nextProbeAt: s.nextProbeAt,
    cooldownMs: s.cooldownMs,
    lastFailureReason: s.lastFailureReason,
    updatedAt: Date.now(),
  };
  if (existing) await ctx.db.replace(existing._id, doc);
  else await ctx.db.insert("circuitStates", doc);
}

/** Circuit gate. Atomic: only one concurrent request gets the half-open probe. */
export const gateInternal = internalMutation({
  args: { connectionId: v.string(), providerId: v.string() },
  handler: async (ctx, args) => {
    const { row, state } = await loadCircuit(ctx, args.connectionId);
    const now = Date.now();
    if (state.state === "half_open") {
      return { allowed: false, probe: false, reason: `${args.providerId} is being probed after an outage` };
    }
    const avail = isAvailable(state, now);
    if (!avail.available) {
      return {
        allowed: false,
        probe: false,
        reason: `${args.providerId} circuit open until ${new Date(state.nextProbeAt ?? now).toISOString()}`,
      };
    }
    if (avail.probe) await saveCircuit(ctx, row, args.connectionId, args.providerId, beginProbe(state));
    return { allowed: true, probe: avail.probe };
  },
});

/** Persist one provider attempt: attempt row + circuit transition + health counters. */
export const recordAttemptInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
    environment: envValidator,
    attempt: v.number(),
    providerId: v.string(),
    connectionId: v.string(),
    idempotencyKey: v.string(),
    status: v.string(),
    providerReference: v.optional(v.string()),
    providerStatus: v.optional(v.string()),
    failure: v.optional(v.object({ category: v.string(), code: v.string(), message: v.string() })),
    latencyMs: v.number(),
    probe: v.boolean(),
    circuit: v.union(v.literal("success"), v.literal("provider_failure"), v.literal("neutral")),
    currency: v.string(),
    amountMinor: v.number(),
    country: v.optional(v.string()),
    paymentMethod: v.string(),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    await ctx.db.insert("paymentAttempts", {
      orgId: a.orgId,
      transactionId: a.transactionId,
      attempt: a.attempt,
      providerId: a.providerId,
      connectionId: a.connectionId,
      environment: a.environment,
      idempotencyKey: a.idempotencyKey,
      status: a.status,
      providerReference: a.providerReference,
      providerStatus: a.providerStatus,
      failureCategory: a.failure?.category,
      failureCode: a.failure?.code,
      failureMessage: a.failure?.message,
      latencyMs: a.latencyMs,
      probe: a.probe,
      currency: a.currency,
      amountMinor: a.amountMinor,
      country: a.country,
      paymentMethod: a.paymentMethod,
      startedAt: now - a.latencyMs,
    });

    const { row, state } = await loadCircuit(ctx, a.connectionId);
    const next = recordOutcome(state, a.circuit as CircuitOutcome, now, undefined, a.failure?.message);
    if (next !== state || row) await saveCircuit(ctx, row, a.connectionId, a.providerId, next);
    if (next.state === "open" && state.state !== "open") {
      await notify(ctx, {
        orgId: undefined,
        kind: "provider_incident",
        severity: "critical",
        title: `${a.providerId} circuit opened`,
        body: `${next.consecutiveFailures} consecutive provider-side failures (${a.failure?.message ?? "unknown"}). Traffic is failing over; next probe ${new Date(next.nextProbeAt ?? now).toISOString()}.`,
        link: "/dashboard/operations",
        dedupeKey: `circuit:${a.connectionId}:${next.openedAt}`,
      });
    }

    // Daily health aggregate (feeds routing statistics and dashboards).
    const day = utcDay(now);
    const h = await ctx.db
      .query("providerHealth")
      .withIndex("by_provider_env_day", (q) => q.eq("provider", a.providerId).eq("environment", a.environment).eq("day", day))
      .unique();
    const inc = {
      successful: a.status === "successful" ? 1 : 0,
      failed: a.status === "failed" ? 1 : 0,
      pending: a.status === "pending" || a.status === "requires_action" ? 1 : 0,
      declined: a.status === "declined" ? 1 : 0,
      unknown: a.status === "unknown" ? 1 : 0,
    };
    const isErr = a.circuit === "provider_failure";
    if (!h) {
      await ctx.db.insert("providerHealth", {
        provider: a.providerId,
        environment: a.environment,
        day,
        charges: 1,
        successful: inc.successful,
        failed: inc.failed,
        pending: inc.pending,
        declined: inc.declined,
        unknown: inc.unknown,
        latencySumMs: Math.max(0, Math.round(a.latencyMs)),
        lastErrorAt: isErr ? now : undefined,
        lastErrorMessage: isErr ? a.failure?.message : undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(h._id, {
        charges: h.charges + 1,
        successful: h.successful + inc.successful,
        failed: h.failed + inc.failed,
        pending: h.pending + inc.pending,
        declined: (h.declined ?? 0) + inc.declined,
        unknown: (h.unknown ?? 0) + inc.unknown,
        latencySumMs: h.latencySumMs + Math.max(0, Math.round(a.latencyMs)),
        lastErrorAt: isErr ? now : h.lastErrorAt,
        lastErrorMessage: isErr ? a.failure?.message : h.lastErrorMessage,
        updatedAt: now,
      });
    }
  },
});

export async function notify(
  ctx: MutationCtx,
  n: {
    orgId: Id<"organizations"> | undefined;
    kind: string;
    severity: "info" | "warning" | "critical";
    title: string;
    body: string;
    link?: string;
    dedupeKey?: string;
  },
) {
  if (n.dedupeKey) {
    const dup = await ctx.db
      .query("notifications")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", n.dedupeKey))
      .first();
    if (dup) return;
  }
  await ctx.db.insert("notifications", { ...n, readBy: [], createdAt: Date.now() });
}

export const connectionByKeyInternal = internalQuery({
  args: { connectionKey: v.string() },
  handler: async (ctx, { connectionKey }) => {
    return await ctx.db
      .query("providerConnections")
      .withIndex("by_connection_key", (q) => q.eq("connectionKey", connectionKey))
      .unique();
  },
});

// ---------------------------------------------------------------------------
// Action-side credential resolution (needs process.env + Web Crypto).
// ---------------------------------------------------------------------------
export type ResolvedConnection =
  | { adapter: ProviderAdapter; ctx: AdapterContext; orgId?: Id<"organizations"> }
  | { error: FailureInfo };

export async function resolveConnection(
  connectionId: string,
  environment: Environment,
  loadConnection: (key: string) => Promise<Doc<"providerConnections"> | null>,
): Promise<ResolvedConnection> {
  const base = {
    environment,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    now: () => Date.now(),
    callbackBaseUrl: process.env.CONVEX_SITE_URL,
    connectionId,
  };
  const platform = parsePlatformConnectionId(connectionId);
  if (platform) {
    if (platform.environment !== environment) {
      return { error: failure("configuration_error", "environment_mismatch", "Connection environment does not match the request.", { safeToFailover: true }) };
    }
    const adapter = getAdapter(platform.providerId);
    if (!adapter) return { error: failure("configuration_error", "unknown_provider", `Unknown provider ${platform.providerId}`, { safeToFailover: true }) };
    if (SANDBOX_PROVIDER_IDS.has(platform.providerId)) {
      if (environment !== "sandbox") {
        return { error: failure("configuration_error", "sandbox_in_production", "Sandbox rails are not available in production.", { safeToFailover: true }) };
      }
      return { adapter, ctx: { ...base, credentials: { webhookSecret: process.env.USOPGRID_SANDBOX_WEBHOOK_SECRET ?? "whsec_sandbox" } } };
    }
    const creds = platformCredentials(platform.providerId, environment);
    if (!creds) {
      return { error: failure("configuration_error", "no_credentials", `${adapter.descriptor.displayName} platform credentials are not configured.`, { safeToFailover: true }) };
    }
    return { adapter, ctx: { ...base, credentials: creds } };
  }

  const conn = await loadConnection(connectionId);
  if (!conn) return { error: failure("configuration_error", "unknown_connection", `Connection ${connectionId} not found.`, { safeToFailover: true }) };
  if (conn.environment !== environment) {
    return { error: failure("configuration_error", "environment_mismatch", "Connection environment does not match the request.", { safeToFailover: true }) };
  }
  const adapter = getAdapter(conn.providerId);
  if (!adapter) return { error: failure("configuration_error", "unknown_provider", `Unknown provider ${conn.providerId}`, { safeToFailover: true }) };
  if (!conn.sealedCredentials) {
    return { error: failure("configuration_error", "no_credentials", `${adapter.descriptor.displayName} connection has no credentials.`, { safeToFailover: true }) };
  }
  const key = process.env.USOPGRID_ENCRYPTION_KEY;
  if (!key) {
    return { error: failure("configuration_error", "encryption_key_missing", "USOPGRID_ENCRYPTION_KEY is not configured.", { safeToFailover: true }) };
  }
  try {
    const credentials = JSON.parse(await openSecret(conn.sealedCredentials, key, conn.connectionKey)) as Record<string, string>;
    return { adapter, ctx: { ...base, credentials }, orgId: conn.orgId };
  } catch {
    return { error: failure("configuration_error", "credentials_unreadable", "Stored credentials could not be decrypted (key rotated?).", { safeToFailover: true }) };
  }
}
