// In-app notifications for an organization (provider incidents affecting it,
// reconciliation exceptions, compliance stops, security events).

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOrgMember } from "./lib/rbac";

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .take(Math.min(a.limit ?? 50, 200));
    return rows.map((n) => ({ _id: n._id, kind: n.kind, severity: n.severity, title: n.title, body: n.body, link: n.link ?? null, createdAt: n.createdAt, read: (n.readBy ?? []).includes(oc.userId) }));
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const rows = await ctx.db.query("notifications").withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId)).order("desc").take(100);
    return rows.filter((n) => !(n.readBy ?? []).includes(oc.userId)).length;
  },
});

export const markRead = mutation({
  args: { ids: v.optional(v.array(v.id("notifications"))) },
  handler: async (ctx, a) => {
    const oc = await requireOrgMember(ctx);
    const rows = a.ids
      ? (await Promise.all(a.ids.map((id) => ctx.db.get(id)))).filter((n) => n !== null)
      : await ctx.db.query("notifications").withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId)).order("desc").take(200);
    for (const n of rows) {
      if (n.orgId !== oc.orgId) continue;
      const readBy = n.readBy ?? [];
      if (!readBy.includes(oc.userId)) await ctx.db.patch(n._id, { readBy: [...readBy, oc.userId] });
    }
  },
});
