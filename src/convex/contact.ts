// Public enterprise-sales enquiries. Unauthenticated, so: strict validation,
// a honeypot field, and per-email + global rate limits.
import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePlatformAdmin } from "./lib/rbac";
import { isKnownCountry } from "../lib/geo";

export const submit = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    company: v.string(),
    country: v.optional(v.string()),
    volume: v.optional(v.string()),
    message: v.optional(v.string()),
    website: v.optional(v.string()), // honeypot: humans leave it empty
  },
  handler: async (ctx, a) => {
    if (a.website) return { ok: true }; // silently drop bots
    const email = a.email.trim().toLowerCase();
    const name = a.name.trim();
    const company = a.company.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw new ConvexError("Enter a valid work email.");
    if (name.length < 2 || name.length > 120 || company.length < 2 || company.length > 160) throw new ConvexError("Enter your name and company.");
    const now = Date.now();
    const recent = await ctx.db.query("contactRequests").withIndex("by_email_created", (q) => q.eq("email", email).gte("createdAt", now - 3_600_000)).collect();
    if (recent.length >= 3) throw new ConvexError("We already have your message. We will reply soon.");
    const burst = await ctx.db.query("contactRequests").withIndex("by_created", (q) => q.gte("createdAt", now - 60_000)).take(30);
    if (burst.length >= 30) throw new ConvexError("Too many requests right now. Email sales@usopgrid.com instead.");
    await ctx.db.insert("contactRequests", {
      name,
      email,
      company,
      country: a.country && isKnownCountry(a.country) ? a.country.toUpperCase() : undefined,
      volume: a.volume?.slice(0, 40),
      message: a.message?.slice(0, 4000),
      status: "new",
      createdAt: now,
    });
    await ctx.db.insert("notifications", {
      kind: "sales_lead",
      severity: "info",
      title: `New enterprise enquiry: ${company}`,
      body: `${name} <${email}>${a.volume ? `, volume ${a.volume}` : ""}`,
      link: "/dashboard/operations",
      readBy: [],
      createdAt: now,
    });
    return { ok: true };
  },
});

export const listLeads = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    return ctx.db.query("contactRequests").withIndex("by_created").order("desc").take(200);
  },
});
