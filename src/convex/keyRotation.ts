// Re-encrypts every secret at rest with the active keyring key.
// Operator-only, MFA step-up required, audited. Safe to re-run: each record is
// swapped only if it still holds the exact ciphertext that was read
// (compare-and-set), so concurrent edits are never overwritten.
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireOperatorStepUp, requirePlatformAdmin } from "./lib/rbac";
import { loadKeyring, needsReseal, open, seal, sealedKeyId } from "./lib/keyring";

const TABLES = ["providerConnections", "userMfa", "beneficiaries"] as const;
type Table = (typeof TABLES)[number];
const tableV = v.union(v.literal("providerConnections"), v.literal("userMfa"), v.literal("beneficiaries"));

type Row = { id: string; sealed: string; aad: string };

export const pageInternal = internalQuery({
  args: { table: tableV, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a): Promise<{ rows: Row[]; cursor: string; isDone: boolean }> => {
    const page = await ctx.db.query(a.table).paginate({ numItems: 100, cursor: a.cursor });
    const rows: Row[] = [];
    for (const d of page.page as Record<string, unknown>[]) {
      if (a.table === "providerConnections" && typeof d.sealedCredentials === "string") rows.push({ id: String(d._id), sealed: d.sealedCredentials, aad: String(d.connectionKey) });
      if (a.table === "userMfa" && typeof d.sealedSecret === "string") rows.push({ id: String(d._id), sealed: d.sealedSecret, aad: `mfa:${String(d.userId)}` });
      if (a.table === "beneficiaries" && typeof d.sealedAccount === "string") rows.push({ id: String(d._id), sealed: d.sealedAccount, aad: `beneficiary:${String(d.orgId)}:${String(d.accountHash)}` });
    }
    return { rows, cursor: page.continueCursor, isDone: page.isDone };
  },
});

const FIELD: Record<Table, string> = { providerConnections: "sealedCredentials", userMfa: "sealedSecret", beneficiaries: "sealedAccount" };

export const swapInternal = internalMutation({
  args: { table: tableV, id: v.string(), expected: v.string(), sealed: v.string() },
  handler: async (ctx, a) => {
    const id = ctx.db.normalizeId(a.table, a.id);
    if (!id) return false;
    const doc = (await ctx.db.get(id)) as Record<string, unknown> | null;
    if (!doc || doc[FIELD[a.table]] !== a.expected) return false;
    await ctx.db.patch(id, { [FIELD[a.table]]: a.sealed } as never);
    return true;
  },
});

export const assertOperator = query({
  args: { write: v.boolean() },
  handler: async (ctx, a) => (a.write ? requireOperatorStepUp(ctx) : requirePlatformAdmin(ctx)),
});

export const auditInternal = internalMutation({
  args: { actor: v.string(), after: v.any() },
  handler: async (ctx, a) => {
    await ctx.db.insert("auditLogs", { actor: `operator:${a.actor}`, action: "security.secrets_resealed", resource: "keyring", after: a.after, at: Date.now() });
  },
});

type Report = { activeKeyId: string; byKey: Record<string, number>; resealed: number; failed: number; skipped: number };

async function walk(ctx: ActionCtx, write: boolean): Promise<Report> {
  const ring = loadKeyring();
  if (!ring) throw new Error("Encryption is not configured.");
  const report: Report = { activeKeyId: ring.activeId, byKey: {}, resealed: 0, failed: 0, skipped: 0 };
  for (const table of TABLES) {
    let cursor: string | null = null;
    for (;;) {
      const page: { rows: Row[]; cursor: string; isDone: boolean } = await ctx.runQuery(internal.keyRotation.pageInternal, { table, cursor });
      for (const r of page.rows) {
        let kid = "unknown";
        try {
          kid = sealedKeyId(r.sealed);
        } catch {
          /* counted as unknown */
        }
        if (write && kid !== "unknown" && needsReseal(r.sealed, ring)) {
          try {
            const plain = await open(r.sealed, r.aad, ring);
            const next = await seal(plain, r.aad, ring);
            const ok: boolean = await ctx.runMutation(internal.keyRotation.swapInternal, { table, id: r.id, expected: r.sealed, sealed: next });
            if (ok) {
              report.resealed++;
              kid = ring.activeId;
            } else report.skipped++;
          } catch {
            report.failed++;
          }
        }
        report.byKey[kid] = (report.byKey[kid] ?? 0) + 1;
      }
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return report;
}

/** How many secrets are sealed under each key (read-only). */
export const status = action({
  args: {},
  handler: async (ctx): Promise<Report> => {
    await ctx.runQuery(api.keyRotation.assertOperator, { write: false });
    return walk(ctx, false);
  },
});

/** Re-encrypt everything not on the active key. */
export const resealAll = action({
  args: {},
  handler: async (ctx): Promise<Report> => {
    const op: { email: string } = await ctx.runQuery(api.keyRotation.assertOperator, { write: true });
    const report = await walk(ctx, true);
    await ctx.runMutation(internal.keyRotation.auditInternal, { actor: op.email, after: report });
    return report;
  },
});
