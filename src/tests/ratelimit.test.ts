import { describe, expect, test } from "bun:test";
import { shardCount, shardLimit, DEFAULT_RATE_LIMIT } from "../convex/lib/ratelimit";

describe("sharded rate limits", () => {
  test("small limits stay on one exact counter", () => {
    expect(shardCount(DEFAULT_RATE_LIMIT)).toBe(1);
    expect(shardCount(300)).toBe(1);
    expect(shardLimit(120, 1, 0)).toBe(120);
  });
  test("large limits spread across shards whose shares add up to the limit", () => {
    for (const limit of [301, 1200, 1999, 6000]) {
      const n = shardCount(limit);
      expect(n).toBeGreaterThan(1);
      expect(n).toBeLessThanOrEqual(16);
      let total = 0;
      for (let s = 0; s < n; s++) total += shardLimit(limit, n, s);
      expect(total).toBe(limit);
    }
  });
});
