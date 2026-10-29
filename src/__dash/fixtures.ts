// Preview-only fixtures. Each one is checked by the compiler against the real
// backend function's return type, so the screens render realistic shapes.
import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { listDescriptors } from "@/convex/providers/index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R<F extends FunctionReference<any>> = FunctionReturnType<F>;
const id = <T extends string>(_t: T, s: string) => s as never;
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const H = 3_600_000, D = 24 * H;

const orgContext: R<typeof api.orgs.getOrgContext> = {
  org: { _id: id("organizations", "org1"), name: "Kudi Retail Ltd", environment: "production", settings: { currency: "NGN" }, country: "NG", status: "active" },
  roleLabel: "Owner", isPlatformAdmin: true, role: "owner",
  permissions: ["payments:create", "payments:view", "refunds:create", "providers:manage", "routing:manage", "analytics:view", "reports:export", "team:manage", "security:manage", "api_keys:manage", "settlements:view", "reconciliation:manage", "webhooks:manage", "org:manage", "disputes:manage"],
  member: { _id: id("orgMembers", "m1"), role: "owner" },
};
const currentUser: R<typeof api.users.currentUser> = { _id: id("users", "u1"), _creationTime: NOW - 90 * D, name: "Adaeze Okafor", email: "adaeze@kudiretail.ng", emailVerificationTime: NOW - 90 * D, role: "owner" };

const days = Array.from({ length: 14 }, (_, i) => new Date(NOW - (13 - i) * D).toISOString().slice(0, 10));
const series = days.map((day, i) => { const count = 820 + Math.round(180 * Math.sin(i / 2)) + i * 14; const successful = Math.round(count * (0.915 + 0.02 * Math.cos(i))); return { day, volume: count * 1_845_00, count, successful, failed: count - successful }; });
const total = series.reduce((n, d) => n + d.count, 0), succ = series.reduce((n, d) => n + d.successful, 0);

const overview: R<typeof api.queries.getOverviewStats> = {
  environment: "production", truncated: false, primaryCurrency: "NGN",
  volume: series.reduce((n, d) => n + d.volume, 0), fees: 2_914_550_00, refunded: 48_200_00,
  volumeByCurrency: { NGN: 2_090_400_000_00, GHS: 14_220_000, KES: 3_844_000_00, USD: 4_120_550 },
  successful: succ, failed: total - succ - 212, declined: 212, pending: 37, exceptions: 4, total, successRate: Math.round((succ / total) * 1000) / 10, failoverRate: 0.031,
  series,
  currencyCounts: [{ currency: "NGN", count: Math.round(total * 0.71) }, { currency: "KES", count: Math.round(total * 0.14) }, { currency: "GHS", count: Math.round(total * 0.09) }, { currency: "USD", count: Math.round(total * 0.06) }],
  methodCounts: [{ method: "card", count: 7120 }, { method: "bank_transfer", count: 3310 }, { method: "mobile_money", count: 1890 }, { method: "ussd", count: 420 }],
  countryCounts: [{ country: "NG", count: 8790, successRate: 0.931 }, { country: "KE", count: 1730, successRate: 0.948 }, { country: "GH", count: 1110, successRate: 0.902 }, { country: "US", count: 740, successRate: 0.962 }],
  providerCounts: [{ provider: "paystack", count: 5210, successRate: 0.934 }, { provider: "flutterwave", count: 3880, successRate: 0.918 }, { provider: "mpesa", count: 1730, successRate: 0.948 }, { provider: "stripe", count: 740, successRate: 0.962 }],
  failureCategories: [{ category: "insufficient_funds", code: "51", count: 302 }, { category: "issuer_decline", code: "05", count: 211 }, { category: "timeout", code: "outcome_unknown", count: 44 }],
  topMethod: "card",
};

const names = ["Chinedu Eze", "Wanjiru Kamau", "Kofi Mensah", "Amaka Obi", "Tunde Bello", "Grace Achieng", "Yaw Boateng", "Ifeoma Nwosu"];
const providersRot = ["paystack", "flutterwave", "mpesa", "stripe"];
const statuses = ["SUCCESSFUL", "SUCCESSFUL", "SUCCESSFUL", "DECLINED", "SUCCESSFUL", "PENDING", "SUCCESSFUL", "REFUNDED"] as const;
const txns: R<typeof api.queries.listTransactions>["page"] = Array.from({ length: 12 }, (_, i) => {
  const cur = ["NGN", "KES", "GHS", "USD"][i % 4];
  const amt = [2_500_000, 345_000, 82_000, 12_999][i % 4] * (1 + (i % 3));
  return {
    _id: id("transactions", `t${i}`), _creationTime: NOW - i * 7 * 60_000, environment: "production", currency: cur, status: statuses[i % 8],
    orgId: id("organizations", "org1"), merchantId: id("merchants", "mer1"), createdAt: NOW - i * 7 * 60_000, updatedAt: NOW - i * 7 * 60_000,
    amountMinor: amt, reference: `ORD-${88120 - i}`, transactionId: `txn_${(0x5f3a91 + i * 7919).toString(36)}k2${i}`, provider: providersRot[i % 4], paymentMethod: ["card", "mobile_money", "bank_transfer", "card"][i % 4],
    customerName: names[i % 8], customerEmail: `${names[i % 8].split(" ")[0].toLowerCase()}@example.com`, country: ["NG", "KE", "GH", "US"][i % 4],
    attemptCount: i === 2 ? 2 : 1, failoverCount: i === 2 ? 1 : 0, feeMinor: Math.round(amt * 0.015), riskScore: 12 + (i * 7) % 40, riskDecision: "ALLOW",
    failureCategory: statuses[i % 8] === "DECLINED" ? "insufficient_funds" : undefined, failureMessage: statuses[i % 8] === "DECLINED" ? "Insufficient funds" : undefined,
  };
});
const listTransactions: R<typeof api.queries.listTransactions> = { page: txns, isDone: false, continueCursor: "c1" };

const catalog: R<typeof api.providers.catalog> = listDescriptors().map((d) => ({ ...d, methods: d.methods.map((m) => ({ id: m, label: m.replace(/_/g, " ") })) })) as never;

const circuit = (state: "open" | "closed" | "half_open" = "closed") => ({ state, consecutiveFailures: state === "closed" ? 0 : 6, nextProbeAt: state === "closed" ? null : NOW + 40_000, reason: state === "closed" ? null : "6 consecutive provider errors" });
const connections: R<typeof api.providers.listConnections> = {
  environment: "production",
  connections: [
    { circuit: circuit(), today: { attempts: 5210, successRate: 0.934, avgLatencyMs: 1180, lastError: null }, connectionKey: "pc_ps1", providerId: "paystack", displayName: "Paystack", label: "Paystack NG (primary)", environment: "production", enabled: true, priority: 20, status: "active", credentialHints: { secretKey: "sk_live_••••9f2c" }, pricing: { pctBps: 150, fixedMinor: 10000, fixedCurrency: "NGN" }, lastVerifiedAt: NOW - 2 * H, lastError: null, source: "organization", webhookUrl: "https://api.usopgrid.com/api/v1/webhooks/providers/pc_ps1" },
    { circuit: circuit("half_open"), today: { attempts: 3880, successRate: 0.918, avgLatencyMs: 1640, lastError: "HTTP 503 from Flutterwave" }, connectionKey: "pc_fw1", providerId: "flutterwave", displayName: "Flutterwave", label: "Flutterwave (backup)", environment: "production", enabled: true, priority: 10, status: "active", credentialHints: { secretKey: "FLWSECK-••••b81a", webhookHash: "••••" }, pricing: { pctBps: 140, fixedMinor: 0, fixedCurrency: "NGN" }, lastVerifiedAt: NOW - 5 * H, lastError: "HTTP 503", source: "organization", webhookUrl: "https://api.usopgrid.com/api/v1/webhooks/providers/pc_fw1" },
    { circuit: circuit(), today: { attempts: 1730, successRate: 0.948, avgLatencyMs: 2410, lastError: null }, connectionKey: "pc_mp1", providerId: "mpesa", displayName: "M-Pesa (Daraja)", label: "M-Pesa KE paybill 5544", environment: "production", enabled: true, priority: 15, status: "active", credentialHints: { consumerKey: "••••Qe1", shortcode: "5544" }, pricing: null, lastVerifiedAt: NOW - D, lastError: null, source: "organization", webhookUrl: "https://api.usopgrid.com/api/v1/webhooks/providers/pc_mp1" },
    { circuit: circuit(), today: { attempts: 740, successRate: 0.962, avgLatencyMs: 820, lastError: null }, connectionKey: "pc_st1", providerId: "stripe", displayName: "Stripe", label: "Stripe US", environment: "production", enabled: true, priority: 5, status: "active", credentialHints: { secretKey: "sk_live_••••x1Ab" }, pricing: { pctBps: 290, fixedMinor: 30, fixedCurrency: "USD" }, lastVerifiedAt: NOW - 3 * D, lastError: null, source: "organization", webhookUrl: "https://api.usopgrid.com/api/v1/webhooks/providers/pc_st1" },
  ],
};

const listRules: R<typeof api.routing.listRules> = {
  rules: [
    { _id: id("routingRules", "r1"), _creationTime: NOW - 20 * D, match: { countries: ["KE"], methods: ["mobile_money"] }, name: "Kenyan mobile money via M-Pesa", orgId: id("organizations", "org1"), createdAt: NOW - 20 * D, updatedAt: NOW - 2 * D, action: { providers: ["mpesa"], type: "only" }, enabled: true, order: 0 },
    { _id: id("routingRules", "r2"), _creationTime: NOW - 18 * D, match: { currencies: ["NGN"], minAmountMinor: 50_000_000 }, name: "High-value NGN prefers Paystack", orgId: id("organizations", "org1"), createdAt: NOW - 18 * D, updatedAt: NOW - 18 * D, action: { providers: ["paystack"], type: "prefer" }, enabled: true, order: 1 },
    { _id: id("routingRules", "r3"), _creationTime: NOW - 9 * D, match: { minRiskScore: 70 }, name: "Risky traffic never on Stripe", orgId: id("organizations", "org1"), createdAt: NOW - 9 * D, updatedAt: NOW - 9 * D, action: { providers: ["stripe"], type: "exclude" }, enabled: false, order: 2 },
  ],
  strategy: { weights: { success: 0.6, cost: 0.25, latency: 0.15 }, maxAttempts: 2 }, canEdit: true,
};
const recentDecisions: R<typeof api.routing.recentDecisions> = txns.slice(0, 6).map((t, i) => ({ at: t.createdAt, transactionId: t.transactionId, chain: i === 2 ? ["flutterwave", "paystack"] : [t.provider, providersRot[(i + 1) % 4]], decidedProvider: i === 2 ? "paystack" : t.provider, outcome: t.status, explanation: i === 2 ? "flutterwave unavailable (HTTP 503, safe to fail over) → paystack succeeded" : `${t.provider}: success 93.4%, cost 1.5%, p50 1.2 s, score 0.81`, matchedRules: i % 3 === 0 ? 1 : 0, failovers: i === 2 ? 1 : 0 }));

const listBeneficiaries: R<typeof api.payouts.listBeneficiaries> = [
  { _id: id("beneficiaries", "b1"), _creationTime: NOW - 30 * D, name: "Okonkwo Logistics", currency: "NGN", status: "verified", orgId: id("organizations", "org1"), createdAt: NOW - 30 * D, bankName: "GTBank", bankCode: "058", accountMasked: "••••4471", accountHash: "h1", accountType: "bank_account", country: "NG", sealedAccount: "v2.k1.x.y" },
  { _id: id("beneficiaries", "b2"), _creationTime: NOW - 12 * D, name: "Wanjiku Supplies", currency: "KES", status: "verified", orgId: id("organizations", "org1"), createdAt: NOW - 12 * D, bankName: "Safaricom M-Pesa", bankCode: "MPESA", accountMasked: "••••0912", accountHash: "h2", accountType: "mobile_money", country: "KE", sealedAccount: "v2.k1.x.y" },
];
const listPayouts: R<typeof api.payouts.listPayouts> = { isDone: true, continueCursor: "", page: [
  { _id: id("payouts", "p1"), _creationTime: NOW - H, currency: "NGN", status: "SUCCESSFUL", orgId: id("organizations", "org1"), merchantId: id("merchants", "mer1"), createdAt: NOW - H, updatedAt: NOW - H, amountMinor: 450_000_000, reference: "PO-1182", feeMinor: 90_000, beneficiaryId: id("beneficiaries", "b1"), payoutId: "po_8f2k1a", provider: "paystack", narration: "Invoice 1182 settlement" },
  { _id: id("payouts", "p2"), _creationTime: NOW - 3 * H, currency: "KES", status: "PROCESSING", orgId: id("organizations", "org1"), merchantId: id("merchants", "mer1"), createdAt: NOW - 3 * H, updatedAt: NOW - 2 * H, amountMinor: 8_500_000, reference: "PO-1181", feeMinor: 17_000, beneficiaryId: id("beneficiaries", "b2"), payoutId: "po_77ajq2", provider: "flutterwave", outcomeUnknown: true, narration: "Weekly supplier run" },
  { _id: id("payouts", "p3"), _creationTime: NOW - D, currency: "NGN", status: "FAILED", orgId: id("organizations", "org1"), merchantId: id("merchants", "mer1"), createdAt: NOW - D, updatedAt: NOW - D, amountMinor: 12_000_000, reference: "PO-1179", feeMinor: 24_000, beneficiaryId: id("beneficiaries", "b1"), payoutId: "po_2bq9x0", provider: "paystack", failureMessage: "Paystack rejected the recipient: Account number invalid", narration: "Refund to vendor" },
] };

const byKey = (rows: [string, number, number][]) => rows.map(([key, count, rate]) => ({ key, count, successful: Math.round(count * rate), failed: count - Math.round(count * rate), successRate: rate, volumeByCurrency: {} }));
const analytics: R<typeof api.analytics.dashboard> = {
  environment: "production", generatedAt: NOW, dataFreshness: { latestTransactionAt: NOW - 60_000, truncated: false },
  overview: {
    window: { from: NOW - 14 * D, to: NOW },
    totals: { payments: total, successful: succ, declined: 212, failed: total - succ - 212, pending: 37, outcomeUnknown: 3, exceptions: 4, successRate: succ / total, approvalRate: 0.951, failoverRate: 0.031, refundRate: 0.004 },
    volumeByCurrency: overview.volumeByCurrency, feesByCurrency: { NGN: 2_914_550_00, KES: 5_766_000, GHS: 213_300, USD: 119_496 }, providerCostByCurrency: { NGN: 2_104_000_00, KES: 4_120_000, GHS: 160_000, USD: 98_000 }, refundedByCurrency: { NGN: 48_200_00 },
    daily: series.map((d) => ({ day: d.day, payments: d.count, successful: d.successful, failed: d.failed, successRate: d.successful / d.count })),
    byCountry: byKey([["NG", 8790, 0.931], ["KE", 1730, 0.948], ["GH", 1110, 0.902], ["US", 740, 0.962]]),
    byCurrency: byKey([["NGN", 8790, 0.931], ["KES", 1730, 0.948], ["GHS", 1110, 0.902], ["USD", 740, 0.962]]),
    byMethod: byKey([["card", 7120, 0.921], ["bank_transfer", 3310, 0.955], ["mobile_money", 1890, 0.948], ["ussd", 420, 0.881]]),
    byProvider: byKey([["paystack", 5210, 0.934], ["flutterwave", 3880, 0.918], ["mpesa", 1730, 0.948], ["stripe", 740, 0.962]]),
    failureReasons: overview.failureCategories,
  },
  providers: [
    { displayName: "Stripe", providerId: "stripe", attempts: 740, successful: 712, declined: 22, failed: 6, unknown: 0, successRate: 0.962, approvalRate: 0.97, providerErrorRate: 0.008, latencyAvgMs: 820, latencyP50Ms: 700, latencyP95Ms: 1900, rank: 1 },
    { displayName: "M-Pesa (Daraja)", providerId: "mpesa", attempts: 1730, successful: 1640, declined: 70, failed: 20, unknown: 1, successRate: 0.948, approvalRate: 0.959, providerErrorRate: 0.012, latencyAvgMs: 2410, latencyP50Ms: 2100, latencyP95Ms: 6800, rank: 2 },
    { displayName: "Paystack", providerId: "paystack", attempts: 5210, successful: 4866, declined: 290, failed: 54, unknown: 2, successRate: 0.934, approvalRate: 0.944, providerErrorRate: 0.01, latencyAvgMs: 1180, latencyP50Ms: 990, latencyP95Ms: 3100, rank: 3 },
    { displayName: "Flutterwave", providerId: "flutterwave", attempts: 3880, successful: 3562, declined: 210, failed: 108, unknown: 0, successRate: 0.918, approvalRate: 0.944, providerErrorRate: 0.028, latencyAvgMs: 1640, latencyP50Ms: 1300, latencyP95Ms: 4900, rank: 4 },
  ],
  costPerSuccess: [{ provider: "paystack", currency: "NGN", successes: 4866, providerFeesMinor: 1_420_000_00, perSuccessMinor: 29_182 }, { provider: "flutterwave", currency: "NGN", successes: 3562, providerFeesMinor: 684_000_00, perSuccessMinor: 19_203 }, { provider: "stripe", currency: "USD", successes: 712, providerFeesMinor: 98_000, perSuccessMinor: 138 }],
  routing: { routed: total, firstChoiceSuccess: succ - 290, recoveredByFailover: 290, failoverRate: 0.031 },
  forecast: Array.from({ length: 7 }, (_, i) => ({ day: new Date(NOW + (i + 1) * D).toISOString().slice(0, 10), payments: 1080 + i * 12 })),
  api: { daily: days.map((day, i) => ({ day, requests: 15_000 + i * 300, errors4xx: 120 + (i % 3) * 20, errors5xx: i === 9 ? 14 : 2 })), topRoutes: [{ route: "POST /payments", count: 128_400 }, { route: "GET /payments/:id", count: 61_220 }, { route: "POST /payouts", count: 2_410 }] },
  webhooks: { total: 24_880, delivered: 24_812, failing: 61, dead: 7 }, reconciliation: { openExceptions: 4 }, disputes: { opened: 6, lost: 1, won: 3 },
};

const listRuns: R<typeof api.reconciliation.listRuns> = [
  { _id: id("reconRuns", "rr1"), _creationTime: NOW - 6 * H, status: "completed", orgId: id("organizations", "org1"), createdAt: NOW - 6 * H, provider: "paystack", source: "paystack_settlement_2026-10-28.csv", matched: 5198, rows: 5204, exceptions: 3, totals: {}, createdBy: "Adaeze Okafor", periodStart: NOW - 2 * D, periodEnd: NOW - D },
  { _id: id("reconRuns", "rr2"), _creationTime: NOW - 30 * H, status: "completed", orgId: id("organizations", "org1"), createdAt: NOW - 30 * H, provider: "flutterwave", source: "flw_settlement_2026-10-27.csv", matched: 3861, rows: 3862, exceptions: 1, totals: {}, createdBy: "Bola Ade", periodStart: NOW - 3 * D, periodEnd: NOW - 2 * D },
];
const listExceptions: R<typeof api.reconciliation.listExceptions> = [
  { _id: id("reconExceptions", "e1"), _creationTime: NOW - 6 * H, type: "amount_mismatch", status: "open", orgId: id("organizations", "org1"), createdAt: NOW - 6 * H, severity: "high", detail: "Provider reports ₦25,000.00; USOPGRID recorded ₦250,000.00 for ORD-88112.", currency: "NGN", provider: "paystack", providerReference: "T7781922", ledgerAmountMinor: 25_000_000, bankAmountMinor: 2_500_000 },
  { _id: id("reconExceptions", "e2"), _creationTime: NOW - 6 * H, type: "missing_in_usopgrid", status: "open", orgId: id("organizations", "org1"), createdAt: NOW - 6 * H, severity: "medium", detail: "Settlement row T7781990 has no matching payment.", currency: "NGN", provider: "paystack", providerReference: "T7781990", bankAmountMinor: 1_200_000 },
  { _id: id("reconExceptions", "e3"), _creationTime: NOW - 30 * H, type: "late_provider_success", status: "acknowledged", orgId: id("organizations", "org1"), createdAt: NOW - 30 * H, severity: "high", detail: "Flutterwave confirmed success 4 h after the payment expired.", currency: "NGN", provider: "flutterwave", resolution: "Refunded via Flutterwave dashboard, ref RF-2201." },
];

const securityStatus: R<typeof api.security.status> = { mfaEnabled: true, stepUpActiveUntil: null, recoveryCodesRemaining: 7, orgPolicy: { requireMfaForSensitive: true }, canManagePolicy: true, encryptionConfigured: true };
const securityEvents: R<typeof api.security.securityEvents> = [
  { at: NOW - 20 * 60_000, actor: "Adaeze Okafor", action: "security.step_up", resource: "user", resourceId: null },
  { at: NOW - 3 * H, actor: "Bola Ade", action: "api_key.rotated", resource: "api_key", resourceId: "k_live_2" },
  { at: NOW - D, actor: "Adaeze Okafor", action: "provider_connection.created", resource: "provider_connection", resourceId: "pc_mp1" },
];

const systemHealth: R<typeof api.ops.systemHealth> = {
  generatedAt: NOW,
  checks: [
    { id: "encryption", label: "Credential encryption key", ok: true, detail: "AES-256-GCM keyring loaded (active k2)" },
    { id: "sanctions", label: "Sanctions screening", ok: true, detail: "OpenSanctions configured" },
    { id: "fx", label: "FX reference rates", ok: true, detail: "Updated 22 minutes ago" },
    { id: "recovery", label: "Recovery queue", ok: false, detail: "1 job past its check time" },
  ],
  env: { encryptionKey: true, siteUrl: "https://api.usopgrid.com", sanctionsScreening: true, premiumFx: false, platformAdmins: 2 },
  providers: analytics.providers.map((p) => ({ id: p.providerId, name: p.displayName, category: p.providerId === "mpesa" ? "mobile_money" : p.providerId === "stripe" ? "global_acquirer" : "regional_psp", attemptsToday: p.attempts, successRate: p.successRate, errorRate: p.providerErrorRate, avgLatencyMs: p.latencyAvgMs, lastError: p.providerId === "flutterwave" ? "HTTP 503" : null, circuits: [{ connectionId: `pc_${p.providerId}`, state: p.providerId === "flutterwave" ? "half_open" : "closed", failures: p.providerId === "flutterwave" ? 6 : 0, nextProbeAt: null, reason: null }] })),
  queues: { recoveryOpen: 3, recoveryOverdue: 1, webhooksPending: 4, webhooksRetrying: 12, webhooksDead: 7, rejectedProviderEvents24h: 2 },
  fx: { source: "open.er-api.com", sourceTimestamp: NOW - 22 * 60_000, fetchedAt: NOW - 20 * 60_000, currencies: 155 },
};

const notifications: R<typeof api.notifications.list> = [
  { _id: id("notifications", "n1"), kind: "circuit_opened", severity: "critical", title: "Flutterwave circuit opened", body: "6 consecutive errors. Traffic is failing over to Paystack.", link: "/dashboard/providers", createdAt: NOW - 40 * 60_000, read: false },
  { _id: id("notifications", "n2"), kind: "recon_exception", severity: "warning", title: "2 new reconciliation exceptions", body: "Paystack settlement 28 Oct.", link: "/dashboard/reconciliation", createdAt: NOW - 6 * H, read: false },
  { _id: id("notifications", "n3"), kind: "anomaly", severity: "info", title: "Success rate recovered", body: "GH card approvals back to 90%.", link: "/dashboard/analytics", createdAt: NOW - D, read: true },
];

const members: R<typeof api.orgs.listMembers> = [
  { _id: id("orgMembers", "m1"), userId: id("users", "u1"), name: "Adaeze Okafor", email: "adaeze@kudiretail.ng", role: "owner", joinedAt: NOW - 90 * D },
  { _id: id("orgMembers", "m2"), userId: id("users", "u2"), name: "Bola Ade", email: "bola@kudiretail.ng", role: "developer", joinedAt: NOW - 60 * D },
  { _id: id("orgMembers", "m3"), userId: id("users", "u3"), name: "Fatima Musa", email: "fatima@kudiretail.ng", role: "finance", joinedAt: NOW - 40 * D },
  { _id: id("orgMembers", "m4"), userId: id("users", "u4"), name: "Kwame Asante", email: "kwame@kudiretail.ng", role: "risk_compliance", joinedAt: NOW - 10 * D },
];
const invitations: R<typeof api.orgs.listInvitations> = [{ _id: id("orgInvitations", "i1"), email: "ops@kudiretail.ng", role: "operations", expiresAt: NOW + 6 * D, createdAt: NOW - D }];
const apiKeys: R<typeof api.services.listApiKeys> = [
  { _id: id("apiKeys", "k1"), name: "Checkout server", environment: "production", mode: "secret", prefix: "sk_live_7Hq2", status: "active", expiresAt: null, lastUsedAt: NOW - 30_000, createdAt: NOW - 40 * D },
  { _id: id("apiKeys", "k2"), name: "Checkout server (old)", environment: "production", mode: "secret", prefix: "sk_live_Q81z", status: "active", expiresAt: NOW + 20 * H, lastUsedAt: NOW - 2 * H, createdAt: NOW - 120 * D },
  { _id: id("apiKeys", "k3"), name: "Staging", environment: "sandbox", mode: "secret", prefix: "sk_sandbox_c1Px", status: "active", expiresAt: null, lastUsedAt: NOW - D, createdAt: NOW - 70 * D },
];
const settlementSummary: R<typeof api.services.getSettlementSummary> = { balances: [{ merchantId: id("merchants", "mer1"), merchantName: "Kudi Retail", currency: "NGN", balanceMinor: 18_442_910_00 }, { merchantId: id("merchants", "mer1"), merchantName: "Kudi Retail", currency: "KES", balanceMinor: 2_104_500_00 }] };

const orgProfile: R<typeof api.orgs.orgProfile> = { name: "Kudi Retail Ltd", country: "NG", environment: "production", status: "active", maxTransactionUsd: 25_000, currency: "NGN", canEdit: true };
const merchants: R<typeof api.orgs.listMerchants> = [{ _id: id("merchants", "mer1"), _creationTime: NOW - 90 * D, orgId: id("organizations", "org1"), name: "Kudi Retail", status: "active", defaultCurrency: "NGN", feeBps: 150, feeFixedMinor: 10_000, feeCurrency: "NGN", reserveBps: 0 }];

export const FIXTURES: Record<string, unknown> = {
  "orgs:orgProfile": orgProfile,
  "orgs:listMerchants": merchants,
  "orgs:getOrgContext": orgContext,
  "users:currentUser": currentUser,
  "queries:getOverviewStats": overview,
  "queries:listTransactions": listTransactions,
  "providers:catalog": catalog,
  "providers:listConnections": connections,
  "routing:listRules": listRules,
  "routing:recentDecisions": recentDecisions,
  "payouts:listPayouts": listPayouts,
  "payouts:listBeneficiaries": listBeneficiaries,
  "analytics:dashboard": analytics,
  "reconciliation:listRuns": listRuns,
  "reconciliation:listExceptions": listExceptions,
  "security:status": securityStatus,
  "security:securityEvents": securityEvents,
  "ops:whoami": { isPlatformAdmin: true, email: "adaeze@kudiretail.ng" },
  "ops:systemHealth": systemHealth,
  "notifications:unreadCount": 2,
  "notifications:list": notifications,
  "orgs:listMembers": members,
  "orgs:listInvitations": invitations,
  "orgs:roles": [],
  "services:listApiKeys": apiKeys,
  "services:getSettlementSummary": settlementSummary,
};
