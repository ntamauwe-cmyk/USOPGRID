// Per-key API rate limits without a single hot record.
//
// One counter row per key would be written by every request, so concurrent
// requests from one busy key collide and queue behind each other. Above a
// small limit the window is split across shards: each request lands on one
// shard at random and checks only that shard's share of the limit. The total
// stays within the limit; a client can be turned away slightly before the
// exact limit when its requests land unevenly. Small limits use one shard
// and stay exact.

export const RATE_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT = 120;
const PER_SHARD = 150;
const MAX_SHARDS = 16;

export function shardCount(limitPerMinute: number): number {
  if (limitPerMinute <= 2 * PER_SHARD) return 1;
  return Math.min(MAX_SHARDS, Math.ceil(limitPerMinute / PER_SHARD));
}

/** This shard's share; shares add up exactly to the limit. */
export function shardLimit(limitPerMinute: number, shards: number, shard: number): number {
  const base = Math.floor(limitPerMinute / shards);
  return base + (shard < limitPerMinute % shards ? 1 : 0);
}

export const USAGE_SHARDS = 8;
