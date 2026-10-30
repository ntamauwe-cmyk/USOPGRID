// Public status page data end to end.
import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import { setup } from "./setup";

describe("public status", () => {
  test("reports health from self-checks, without tenant data, and flags a lagging webhook queue", async () => {
    const { t, orgId } = await setup();
    let res = await t.fetch("/api/v1/status");
    let body = (await res.json()) as { data: { status: string; updated_at: string | null; components: { id: string; state: string }[]; history: unknown[] } };
    expect(res.status).toBe(200);
    // Before any self-check the platform does not claim to be healthy.
    expect(body.data.updated_at).toBeNull();
    expect(body.data.status).toBe("degraded");

    await t.mutation(internal.status.recordSampleInternal, {});
    res = await t.fetch("/api/v1/status");
    body = await res.json();
    expect(body.data.status).toBe("operational");
    expect(body.data.history).toHaveLength(90);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // A webhook stuck in the queue for 20 minutes degrades webhook delivery.
    await t.run(async (ctx) => {
      const endpointId = await ctx.db.insert("webhookEndpoints", { orgId, url: "https://hooks.example.com/u", events: ["*"], status: "active", secretHash: "x", createdAt: Date.now() } as never);
      await ctx.db.insert("webhookDeliveries", { orgId, endpointId, event: "payment.successful", payload: { secret: "tenant-data" }, status: "pending", attempts: 1, createdAt: Date.now() - 30 * 60_000, nextAttemptAt: Date.now() - 20 * 60_000 });
    });
    await t.mutation(internal.status.recordSampleInternal, {});
    const text = await (await t.fetch("/api/v1/status")).text();
    const after = JSON.parse(text) as typeof body;
    expect(after.data.components.find((c) => c.id === "webhooks")?.state).toBe("degraded");
    expect(after.data.status).toBe("degraded");
    expect(text).not.toContain("tenant-data");
    expect(text).not.toContain(String(orgId));
  });
});
