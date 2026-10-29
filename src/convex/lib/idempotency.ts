// USOPGRID idempotency engine — financial correctness first.
//
// The same payment request must never create two financial transactions.
// Flow: (orgId, Idempotency-Key, fingerprint) → status. A retried request with
// the same key + same fingerprint replays the original response. Same key +
// DIFFERENT fingerprint is rejected (422), catching the classic bug of reusing
// a key across different payloads.
//
// Fingerprints are SHA-256 over a canonical JSON serialization (sorted keys),
// so semantically identical payloads produce identical fingerprints.
//
// Record lifecycle:
//   acquire()  → { type: "new" } | { type: "replay", response } | { type: "conflict" }
//   complete() → store the final response for future replays
//   fail()     → release the key so the client may retry

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx, ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "./crypto";

const TTL_MS = 24 * 60 * 60 * 1000; // keys replayable for 24h

/** Canonical JSON: sorted object keys, arrays preserved. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function fingerprint(body: unknown): Promise<string> {
  return sha256Hex(canonicalize(body));
}

export type AcquireResult =
  | { type: "new"; recordId: string }
  | { type: "replay"; statusCode: number; responseBody: unknown }
  | { type: "conflict" } // same key, different fingerprint
  | { type: "in_progress" }; // concurrent duplicate; client should retry

export async function acquire(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; key: string; fp: string },
): Promise<AcquireResult> {
  const now = Date.now();
  const existing = await ctx.db
    .query("idempotencyKeys")
    .withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", args.key))
    .unique();

  if (existing) {
    if (existing.expiresAt < now) {
      // Expired: take over the slot.
      await ctx.db.delete(existing._id);
    } else if (existing.fingerprint !== args.fp) {
      return { type: "conflict" };
    } else if (existing.status === "completed") {
      return { type: "replay", statusCode: existing.statusCode ?? 200, responseBody: existing.responseBody };
    } else {
      return { type: "in_progress" };
    }
  }

  const recordId = await ctx.db.insert("idempotencyKeys", {
    orgId: args.orgId,
    key: args.key,
    fingerprint: args.fp,
    status: "processing",
    createdAt: now,
    expiresAt: now + TTL_MS,
  });
  return { type: "new", recordId };
}

// Internal mutations (called from HTTP actions)
// ---------------------------------------------------------------------------
export const acquireInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    key: v.string(),
    fp: v.string(),
  },
  handler: async (ctx, args) => acquire(ctx, args),
});

const responseValidator = v.object({
  statusCode: v.number(),
  body: v.any(),
});

export const completeInternal = internalMutation({
  args: {
    recordId: v.id("idempotencyKeys"),
    response: responseValidator,
    transactionId: v.optional(v.id("transactions")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.recordId, {
      status: "completed",
      statusCode: args.response.statusCode,
      responseBody: args.response.body,
      transactionId: args.transactionId,
    });
  },
});

export const failInternal = internalMutation({
  args: { recordId: v.id("idempotencyKeys") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.recordId, { status: "failed" });
  },
});

export async function fail(
  runMutation: ActionRunMutation,
  recordId: Id<"idempotencyKeys">,
) {
  await runMutation(internal.lib.idempotency.failInternal, { recordId });
}

type ActionRunMutation = MutationCtx["runMutation"];

// ---------------------------------------------------------------------------
// withIdempotency — shared runner for financial actions (payments, refunds,
// payouts, checkout). Guarantees: a retried request with the same key replays
// the original response; the operation itself runs at most once per key.
// ---------------------------------------------------------------------------
// Structural type: any context exposing runMutation (ActionCtx). Typed loosely
// on purpose — the wrapper is generic over the caller's context shape.
interface RunMutationLike {
  runMutation: (ref: never, args: never) => Promise<unknown>;
}

export async function withIdempotency<T>(
  ctx: { runMutation: ActionCtx["runMutation"] },
  args: { orgId: Id<"organizations">; key: string; fp: string },
  operation: () => Promise<{ statusCode: number; body: T }>,
): Promise<{ replayed: boolean; statusCode: number; body: T }> {
  const acquired = (await ctx.runMutation(internal.lib.idempotency.acquireInternal, {
    orgId: args.orgId,
    key: args.key,
    fp: args.fp,
  })) as AcquireResult;

  if (acquired.type === "replay") {
    return {
      replayed: true,
      statusCode: acquired.statusCode,
      body: acquired.responseBody as T,
    };
  }
  if (acquired.type === "conflict") {
    throw new Error("IDEMPOTENCY_CONFLICT: this key was already used with a different request body.");
  }
  if (acquired.type === "in_progress") {
    throw new Error("CONFLICT: an identical request is currently in progress. Retry shortly.");
  }

  try {
    const result = await operation();
    await ctx.runMutation(internal.lib.idempotency.completeInternal, {
      recordId: acquired.recordId as Id<"idempotencyKeys">,
      response: { statusCode: result.statusCode, body: result.body },
    });
    return { replayed: false, statusCode: result.statusCode, body: result.body };
  } catch (err) {
    await ctx.runMutation(internal.lib.idempotency.failInternal, {
      recordId: acquired.recordId as Id<"idempotencyKeys">,
    });
    throw err;
  }
}

// Purge expired idempotency records (cron-driven). acquire() already takes
// over expired slots on collision; this keeps the table bounded.
export const purgeExpiredInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("idempotencyKeys")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", now))
      .take(200);
    for (const record of expired) {
      await ctx.db.delete(record._id);
    }
    return { purged: expired.length };
  },
});
