import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// ---------------------------------------------------------------------------
// RBAC — permission-level access control
// ---------------------------------------------------------------------------
export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  FINANCE: "finance",
  DEVELOPER: "developer",
  OPERATIONS: "operations",
  RISK: "risk_compliance",
  VIEWER: "viewer",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.OWNER),
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.FINANCE),
  v.literal(ROLES.DEVELOPER),
  v.literal(ROLES.OPERATIONS),
  v.literal(ROLES.RISK),
  v.literal(ROLES.VIEWER),
);
export type Role = Infer<typeof roleValidator>;

// Permission catalog. Roles map to permission sets; checks are permission-based
// so new roles can be introduced without rewriting checks.
export const PERMISSIONS = {
  ORG_MANAGE: "org:manage",
  TEAM_INVITE: "team:invite",
  KEYS_MANAGE: "keys:manage",
  PAYMENTS_CREATE: "payments:create",
  REFUNDS_CREATE: "refunds:create",
  SETTLEMENT_VIEW: "settlement:view",
  LEDGER_VIEW: "ledger:view",
  RECON_MANAGE: "reconciliation:manage",
  AUDIT_VIEW: "audit:view",
  WEBHOOKS_MANAGE: "webhooks:manage",
  PROVIDERS_MANAGE: "providers:manage",
  ROUTING_MANAGE: "routing:manage",
  ANALYTICS_VIEW: "analytics:view",
  RISK_MANAGE: "risk:manage",
  SECURITY_MANAGE: "security:manage",
} as const;

const P = PERMISSIONS;
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner: Object.values(PERMISSIONS),
  admin: Object.values(PERMISSIONS).filter((p) => p !== P.SECURITY_MANAGE),
  developer: [P.KEYS_MANAGE, P.WEBHOOKS_MANAGE, P.PAYMENTS_CREATE, P.PROVIDERS_MANAGE, P.ROUTING_MANAGE, P.ANALYTICS_VIEW],
  finance: [P.SETTLEMENT_VIEW, P.LEDGER_VIEW, P.RECON_MANAGE, P.REFUNDS_CREATE, P.AUDIT_VIEW, P.ANALYTICS_VIEW],
  operations: [P.SETTLEMENT_VIEW, P.LEDGER_VIEW, P.ROUTING_MANAGE, P.ANALYTICS_VIEW, P.REFUNDS_CREATE],
  risk_compliance: [P.RISK_MANAGE, P.AUDIT_VIEW, P.ANALYTICS_VIEW, P.LEDGER_VIEW],
  viewer: [P.ANALYTICS_VIEW],
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Organization Owner",
  admin: "Administrator",
  developer: "Developer",
  finance: "Finance & Reconciliation",
  operations: "Operations",
  risk_compliance: "Risk & Compliance",
  viewer: "Read-only Analyst",
};

/** Every USOPGRID transaction state (see orchestration/states.ts for the transition table). */
export const txStatusValidator = v.union(
  v.literal("CREATED"),
  v.literal("VALIDATED"),
  v.literal("ACCEPTED"),
  v.literal("PROCESSING"),
  v.literal("PENDING"),
  v.literal("SUCCESSFUL"),
  v.literal("FAILED"),
  v.literal("DECLINED"),
  v.literal("CANCELLED"),
  v.literal("EXPIRED"),
  v.literal("REFUND_PENDING"),
  v.literal("PARTIALLY_REFUNDED"),
  v.literal("REFUNDED"),
  v.literal("REVERSED"),
  v.literal("DISPUTED"),
  v.literal("RECONCILIATION_EXCEPTION"),
);

const envValidator = v.union(v.literal("sandbox"), v.literal("production"));

// ---------------------------------------------------------------------------
// Tenancy: organizations → members → merchants
// ---------------------------------------------------------------------------
export const organizations = defineTable({
  name: v.string(),
  slug: v.string(), // unique, used in API keys + urls
  environment: v.optional(v.string()), // "sandbox" | "production"
  settings: v.optional(v.object({ currency: v.optional(v.string()) })),
  /** ISO 3166-1 country of incorporation — drives compliance screening. */
  country: v.optional(v.string()),
  status: v.optional(v.union(v.literal("active"), v.literal("restricted"), v.literal("suspended"))),
  /** Routing strategy weights (success/cost/latency) and max providers per payment. */
  routingStrategy: v.optional(
    v.object({
      weights: v.object({ success: v.number(), cost: v.number(), latency: v.number() }),
      maxAttempts: v.number(),
    }),
  ),
  /** Org-level security policy. */
  security: v.optional(
    v.object({
      requireMfaForSensitive: v.optional(v.boolean()),
      ipAllowlist: v.optional(v.array(v.string())),
    }),
  ),
  /** Per-transaction ceiling in USD-equivalent minor units, enforced before routing. */
  maxTransactionMinor: v.optional(v.number()),
  createdByUserId: v.optional(v.id("users")),
})
  .index("by_slug", ["slug"])
  .index("by_creator", ["createdByUserId"]);

export const orgMembers = defineTable({
  orgId: v.id("organizations"),
  userId: v.id("users"),
  role: roleValidator,
  permissions: v.optional(v.array(v.string())), // extra grants beyond role
  joinedAt: v.number(),
})
  .index("by_org", ["orgId"])
  .index("by_user", ["userId"])
  .index("by_org_user", ["orgId", "userId"]);

// A merchant = settlement + fee + balance boundary inside an org. One org can
// hold many merchants (platform / sub-merchant model).
export const merchants = defineTable({
  orgId: v.id("organizations"),
  name: v.string(),
  status: v.union(
    v.literal("active"),
    v.literal("onboarding"),
    v.literal("suspended"),
  ),
  // default currency for display/settlement (ISO 4217 —)
  defaultCurrency: v.string(),
  // fee plan, basis points + fixed minor units
  feeBps: v.number(), // e.g. 150 = 1.5%
  feeFixedMinor: v.number(),
  feeCurrency: v.optional(v.string()),
  // reserve held back from settlements, basis points
  reserveBps: v.optional(v.number()),
  createdByUserId: v.optional(v.id("users")),
})
  .index("by_org", ["orgId"])
  .index("by_org_name", ["orgId", "name"]);

// ---------------------------------------------------------------------------
// API keys — hashed at rest, prefix for lookup, publishable/secret split,
// rotation + revocation
// ---------------------------------------------------------------------------
export const apiKeys = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.optional(v.id("merchants")),
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  mode: v.union(v.literal("secret"), v.literal("publishable")),
  name: v.string(),
  prefix: v.string(), // "sk_sandbox_abc123" — first 12 chars, shown in UI
  hash: v.string(), // sha256(full key) — the full key is never stored
  status: v.union(v.literal("active"), v.literal("revoked")),
  /** Set when the key was rotated: it keeps working until this time. */
  expiresAt: v.optional(v.number()),
  rotatedToKeyId: v.optional(v.string()),
  lastUsedAt: v.optional(v.number()),
  // Per-key rate limiting window
  rateWindowCount: v.optional(v.number()),
  rateWindowEnd: v.optional(v.number()),
  createdAt: v.number(),
  createdByUserId: v.optional(v.id("users")),
})
  .index("by_hash", ["hash"])
  .index("by_org", ["orgId"]);

// ---------------------------------------------------------------------------
// Transactions + payment lifecycle
// States: CREATED → PENDING → PROCESSING → SUCCESSFUL | FAILED | CANCELLED
//         → REFUNDED / PARTIALLY_REFUNDED / REVERSED / DISPUTED
// Money is stored as integer minor units. Never floats.
// ---------------------------------------------------------------------------
export const transactions = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  status: txStatusValidator,
  amountMinor: v.number(),
  currency: v.string(),
  reference: v.string(), // merchant-supplied reference (unique per org)
  transactionId: v.string(), // USOPGRID id e.g. txn_...
  idempotencyKey: v.optional(v.string()),
  provider: v.string(), // "sandbox" | "paystack" | "flutterwave" (adapter id)
  providerReference: v.optional(v.string()),
  paymentMethod: v.string(), // card | bank_transfer | mobile_money | upi | pix | ...
  /** Payer country (ISO 3166-1 alpha-2) — routing + compliance input. */
  country: v.optional(v.string()),
  /** Connection that processed the decisive attempt. */
  connectionId: v.optional(v.string()),
  attemptCount: v.optional(v.number()),
  failoverCount: v.optional(v.number()),
  /** Set while the provider outcome is unknown (timeout/5xx) and recovery is polling. */
  outcomeUnknown: v.optional(v.boolean()),
  nextAction: v.optional(v.any()),
  providerFeeMinor: v.optional(v.number()),
  complianceDecision: v.optional(v.string()),
  /** FX: present when the customer was charged in another currency than settlement. */
  fx: v.optional(
    v.object({
      quoteId: v.string(),
      settlementCurrency: v.string(),
      settlementAmountMinor: v.number(),
      rate: v.string(),
      spreadBps: v.number(),
    }),
  ),
  customerPhone: v.optional(v.string()),
  customerEmail: v.optional(v.string()),
  customerName: v.optional(v.string()),
  metadata: v.optional(v.any()),
  // Failure intelligence
  failureCategory: v.optional(v.string()),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  failureRetryable: v.optional(v.boolean()),
  // Fees, computed by the fee engine in minor units
  feeMinor: v.optional(v.number()),
  feeCurrency: v.optional(v.string()),
  netMinor: v.optional(v.number()),
  // Cumulative refunded amount in minor units
  refundedMinor: v.optional(v.number()),
  // Risk
  riskScore: v.optional(v.number()), // 0..100
  riskDecision: v.optional(
    v.union(v.literal("ALLOW"), v.literal("REVIEW"), v.literal("HOLD"), v.literal("BLOCK")),
  ),
  // Settlement linkage
  settledAt: v.optional(v.number()),
  settlementBatchId: v.optional(v.id("settlementBatches")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_org_status_created", ["orgId", "status", "createdAt"])
  .index("by_merchant_created", ["merchantId", "createdAt"])
  .index("by_reference", ["orgId", "reference"])
  .index("by_transaction_id", ["transactionId"])
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_email_created", ["orgId", "customerEmail", "createdAt"])
  .index("by_provider_reference", ["provider", "providerReference"])
  .index("by_status_updated", ["status", "updatedAt"])
  .index("by_org_env_created", ["orgId", "environment", "createdAt"]);

// Every state transition, append-only (: one timeline)
export const transactionEvents = defineTable({
  transactionId: v.id("transactions"),
  type: v.string(), // created, processing, successful, failed, refund.*, settlement.*
  fromStatus: v.optional(v.string()),
  toStatus: v.optional(v.string()),
  data: v.optional(v.any()),
  actor: v.string(), // "api", "system", "webhook", user id
  at: v.number(),
}).index("by_transaction", ["transactionId", "at"]);

// ---------------------------------------------------------------------------
// Double-entry ledger — immutable source of truth
// Debit sum must equal credit sum per currency. Entries are never edited or
// deleted; corrections happen through reversals/adjustments.
// ---------------------------------------------------------------------------
export const ledgerAccounts = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.optional(v.id("merchants")),
  currency: v.string(),
  kind: v.string(),
  // kind: merchant_balance | provider_clearing | platform_fees |
  //       settlement_payable | reserve | suspense
  code: v.string(), // e.g. "merch_<id>_NGN"
  name: v.string(),
  createdAt: v.number(),
}).index("by_code", ["code"]).index("by_org_kind", ["orgId", "kind"]);

export const ledgerEntries = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.optional(v.id("transactions")),
  settlementBatchId: v.optional(v.id("settlementBatches")),
  // Each posting shares a ledgerRef: one immutable balanced group of entries
  ledgerRef: v.string(),
  accountId: v.id("ledgerAccounts"),
  accountCode: v.string(),
  direction: v.union(v.literal("debit"), v.literal("credit")),
  amountMinor: v.number(),
  currency: v.string(),
  description: v.string(),
  at: v.number(),
})
  .index("by_ledger_ref", ["ledgerRef"])
  .index("by_account_at", ["accountId", "at"])
  .index("by_transaction", ["transactionId"])
  .index("by_org_at", ["orgId", "at"]);

// ---------------------------------------------------------------------------
// Idempotency — financial correctness first
// ---------------------------------------------------------------------------
export const idempotencyKeys = defineTable({
  orgId: v.id("organizations"),
  key: v.string(),
  fingerprint: v.string(), // hash of normalized request body
  status: v.union(v.literal("processing"), v.literal("completed"), v.literal("failed")),
  responseBody: v.optional(v.any()), // replayed on retries
  statusCode: v.optional(v.number()),
  transactionId: v.optional(v.id("transactions")),
  createdAt: v.number(),
  expiresAt: v.number(),
})
  .index("by_org_key", ["orgId", "key"])
  .index("by_expiry", ["expiresAt"]);

// ---------------------------------------------------------------------------
// Settlement — PAYMENT SUCCESS ≠ SETTLEMENT CONFIRMED
// ---------------------------------------------------------------------------
export const settlementBatches = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  currency: v.string(),
  status: v.union(
    v.literal("EXPECTED"),
    v.literal("PROCESSING"),
    v.literal("SETTLED"),
    v.literal("PARTIALLY_SETTLED"),
    v.literal("FAILED"),
    v.literal("HELD"),
  ),
  grossMinor: v.number(),
  feeMinor: v.number(),
  reserveMinor: v.number(),
  netMinor: v.number(),
  transactionCount: v.number(),
  reference: v.string(), // stl_...
  settledAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_merchant_created", ["merchantId", "createdAt"]);

// Settlement as seen by the bank — feeds the reconciliation engine
export const bankRecords = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  batchReference: v.string(), // matches settlementBatches.reference
  bankReference: v.string(),
  amountMinor: v.number(),
  currency: v.string(),
  direction: v.union(v.literal("credit"), v.literal("debit")),
  valueDate: v.number(),
  source: v.string(), // which bank statement/statement adapter produced it
  status: v.union(v.literal("unmatched"), v.literal("matched"), v.literal("exception")),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_batch_reference", ["batchReference"]);

// Reconciliation exceptions
export const reconExceptions = defineTable({
  orgId: v.id("organizations"),
  batchReference: v.optional(v.string()),
  type: v.union(
    v.literal("missing_settlement"),
    v.literal("amount_mismatch"),
    v.literal("ledger_vs_bank_mismatch"),
    v.literal("unexplained_bank_entry"),
    v.literal("duplicate"),
    v.literal("missing_in_provider_report"),
    v.literal("missing_in_usopgrid"),
    v.literal("currency_mismatch"),
    v.literal("fee_discrepancy"),
    v.literal("status_mismatch"),
    v.literal("late_provider_success"),
    v.literal("unknown_outcome_expired"),
  ),
  severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
  detail: v.string(),
  ledgerAmountMinor: v.optional(v.number()),
  bankAmountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  status: v.union(v.literal("open"), v.literal("resolved"), v.literal("acknowledged")),
  transactionId: v.optional(v.string()),
  providerReference: v.optional(v.string()),
  provider: v.optional(v.string()),
  runId: v.optional(v.id("reconRuns")),
  resolution: v.optional(v.string()),
  resolvedBy: v.optional(v.string()),
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
})
  .index("by_org_status_created", ["orgId", "status", "createdAt"])
  .index("by_run", ["runId"]);

// ---------------------------------------------------------------------------
// Webhooks — signed, retried, observable
// ---------------------------------------------------------------------------
export const webhookEndpoints = defineTable({
  orgId: v.id("organizations"),
  url: v.string(),
  events: v.array(v.string()),
  secret: v.string(), // signing secret, whsec_...
  status: v.union(v.literal("active"), v.literal("disabled")),
  createdAt: v.number(),
})
  .index("by_org", ["orgId"]);

export const webhookDeliveries = defineTable({
  orgId: v.id("organizations"),
  endpointId: v.id("webhookEndpoints"),
  transactionId: v.optional(v.id("transactions")),
  event: v.string(),
  payload: v.any(),
  status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed"), v.literal("dead")),
  attempts: v.number(),
  responseStatus: v.optional(v.number()),
  lastError: v.optional(v.string()),
  nextAttemptAt: v.optional(v.number()),
  /** Stable id sent as X-USOPGRID-Event-Id so receivers can de-duplicate. */
  eventId: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_status_next", ["status", "nextAttemptAt"])
  .index("by_transaction", ["transactionId"]);

// ---------------------------------------------------------------------------
// Audit — actor, action, resource, before/after
// ---------------------------------------------------------------------------
export const auditLogs = defineTable({
  orgId: v.optional(v.id("organizations")),
  actor: v.string(), // user id, api key prefix, or "system"
  action: v.string(), // e.g. "transaction.created", "key.created"
  resource: v.string(),
  resourceId: v.optional(v.string()),
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  requestId: v.optional(v.string()),
  at: v.number(),
})
  .index("by_org_at", ["orgId", "at"])
  .index("by_actor_at", ["actor", "at"]);

// ---------------------------------------------------------------------------
// Customers — lightweight CRM keyed by org + email. Payment
// engine upserts customers automatically on every transaction with an email.
// ---------------------------------------------------------------------------
export const customers = defineTable({
  orgId: v.id("organizations"),
  email: v.string(),
  name: v.optional(v.string()),
  name_search: v.optional(v.string()),
  phone: v.optional(v.string()),
  metadata: v.optional(v.any()),
  status: v.union(v.literal("active"), v.literal("blocked")),
  transactionCount: v.number(),
  successfulCount: v.number(),
  // Per-currency lifetime volume map — never mix currencies into one number
  // (audit fix). Shape: { [ISO currency code]: minor units }.
  lifetimeVolumeByCurrency: v.optional(v.any()),
  lastTransactionAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_org_email", ["orgId", "email"])
  .index("by_org_created", ["orgId", "createdAt"]);

// ---------------------------------------------------------------------------
// Payment links — shareable checkout. linkId is public.
// ---------------------------------------------------------------------------
export const paymentLinks = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  linkId: v.string(), // pl_... public identifier
  title: v.string(),
  description: v.optional(v.string()),
  // Fixed amount, or null = customer chooses at checkout ("open amount")
  amountMinor: v.optional(v.number()),
  currency: v.string(),
  status: v.union(v.literal("active"), v.literal("disabled")),
  expiresAt: v.optional(v.number()),
  maxUses: v.optional(v.number()),
  useCount: v.number(),
  successCount: v.number(),
  createdByUserId: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_link_id", ["linkId"])
  .index("by_org_created", ["orgId", "createdAt"]);

// ---------------------------------------------------------------------------
// Beneficiaries — payout destinations. Full account numbers are
// NEVER stored; masked display + sha-256 hash for duplicate detection only.
// ---------------------------------------------------------------------------
export const beneficiaries = defineTable({
  orgId: v.id("organizations"),
  name: v.string(), // account holder name
  bankName: v.string(),
  bankCode: v.optional(v.string()),
  accountMasked: v.string(), // e.g. "••••4832"
  accountHash: v.string(), // sha256(accountNumber+bankCode) — duplicate detection
  currency: v.string(),
  status: v.union(v.literal("verified"), v.literal("pending_verification"), v.literal("rejected")),
  verifiedAt: v.optional(v.number()),
  createdByUserId: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_hash", ["orgId", "accountHash"]);

// ---------------------------------------------------------------------------
// Payouts — merchant payouts to beneficiaries.
// PENDING → PROCESSING → SUCCESSFUL | FAILED | REVERSED
// ---------------------------------------------------------------------------
export const payouts = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  beneficiaryId: v.id("beneficiaries"),
  payoutId: v.string(), // po_...
  reference: v.string(), // idempotent merchant reference (unique per org)
  amountMinor: v.number(),
  feeMinor: v.number(),
  currency: v.string(),
  status: v.union(
    v.literal("PENDING"),
    v.literal("PROCESSING"),
    v.literal("SUCCESSFUL"),
    v.literal("FAILED"),
    v.literal("REVERSED"),
  ),
  provider: v.optional(v.string()),
  providerReference: v.optional(v.string()),
  failureCategory: v.optional(v.string()),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  failureRetryable: v.optional(v.boolean()),
  narration: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_payout_id", ["payoutId"])
  .index("by_org_reference", ["orgId", "reference"])
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_status_created", ["orgId", "status", "createdAt"]);

// ---------------------------------------------------------------------------
// Disputes — chargeback lifecycle per transaction.
// ---------------------------------------------------------------------------
export const disputes = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.id("transactions"),
  disputeId: v.string(), // dsp_...
  status: v.union(
    v.literal("OPEN"),
    v.literal("AWAITING_EVIDENCE"),
    v.literal("UNDER_REVIEW"),
    v.literal("WON"),
    v.literal("LOST"),
    v.literal("CANCELLED"),
  ),
  reasonCode: v.string(), // e.g. fraudulent, product_not_received, duplicate
  reasonDetails: v.optional(v.string()),
  amountMinor: v.number(),
  currency: v.string(),
  evidence: v.optional(
    v.array(
      v.object({
        note: v.string(),
        addedBy: v.string(),
        addedAt: v.number(),
      }),
    ),
  ),
  resolution: v.optional(v.string()),
  resolvedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_dispute_id", ["disputeId"])
  .index("by_transaction", ["transactionId"])
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_status_created", ["orgId", "status", "createdAt"]);

export const disputeEvents = defineTable({
  disputeId: v.id("disputes"),
  type: v.string(), // opened, evidence_added, resolved, cancelled
  data: v.optional(v.any()),
  actor: v.string(),
  at: v.number(),
}).index("by_dispute", ["disputeId", "at"]);

// ---------------------------------------------------------------------------
// Provider health — per provider/environment/day aggregates that
// feed the routing engine and the dashboard.
// ---------------------------------------------------------------------------
export const providerHealth = defineTable({
  provider: v.string(),
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  day: v.string(), // UTC YYYY-MM-DD
  charges: v.number(),
  successful: v.number(),
  failed: v.number(),
  pending: v.number(),
  latencySumMs: v.number(),
  lastErrorAt: v.optional(v.number()),
  lastErrorMessage: v.optional(v.string()),
  declined: v.optional(v.number()),
  unknown: v.optional(v.number()),
  feeSumMinorUsd: v.optional(v.number()),
  updatedAt: v.number(),
}).index("by_provider_env_day", ["provider", "environment", "day"]);

// ---------------------------------------------------------------------------
// Provider connections — credentials an org (or the platform, orgId absent)
// holds with a processor. Secrets are AES-256-GCM sealed; only hints leave
// the server. One org can hold several connections to the same provider
// (e.g. two Stripe accounts for two entities).
// ---------------------------------------------------------------------------
export const providerConnections = defineTable({
  orgId: v.optional(v.id("organizations")),
  connectionKey: v.string(), // public id used in webhook URLs: pc_...
  providerId: v.string(),
  environment: envValidator,
  label: v.string(),
  enabled: v.boolean(),
  priority: v.number(), // −100…100
  sealedCredentials: v.optional(v.string()),
  credentialHints: v.optional(v.any()), // { secretKey: "sk_live_…a1b2" }
  pricing: v.optional(v.object({ pctBps: v.number(), fixedMinor: v.number(), fixedCurrency: v.string() })),
  status: v.union(v.literal("active"), v.literal("unverified"), v.literal("error"), v.literal("disabled")),
  lastVerifiedAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
  createdByUserId: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_org_env", ["orgId", "environment"])
  .index("by_connection_key", ["connectionKey"]);

// Merchant routing rules (prefer / exclude / only) evaluated in `order`.
export const routingRules = defineTable({
  orgId: v.id("organizations"),
  name: v.string(),
  enabled: v.boolean(),
  order: v.number(),
  match: v.object({
    countries: v.optional(v.array(v.string())),
    currencies: v.optional(v.array(v.string())),
    methods: v.optional(v.array(v.string())),
    minAmountMinor: v.optional(v.number()),
    maxAmountMinor: v.optional(v.number()),
    minRiskScore: v.optional(v.number()),
  }),
  action: v.object({
    type: v.union(v.literal("prefer"), v.literal("exclude"), v.literal("only")),
    providers: v.array(v.string()),
  }),
  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.string()),
}).index("by_org_order", ["orgId", "order"]);

// Every routing decision, with each candidate's verdict — explainability.
export const routingDecisions = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.id("transactions"),
  request: v.any(),
  chain: v.array(v.object({ providerId: v.string(), connectionId: v.string() })),
  evaluations: v.any(),
  matchedRules: v.array(v.string()),
  explanation: v.string(),
  outcome: v.optional(v.string()),
  decidedProvider: v.optional(v.string()),
  at: v.number(),
})
  .index("by_transaction", ["transactionId"])
  .index("by_org_at", ["orgId", "at"]);

// One row per provider call for a payment (primary + failovers).
export const paymentAttempts = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.id("transactions"),
  attempt: v.number(),
  providerId: v.string(),
  connectionId: v.string(),
  environment: envValidator,
  idempotencyKey: v.string(),
  status: v.string(), // provider ChargeStatus
  providerReference: v.optional(v.string()),
  providerStatus: v.optional(v.string()),
  failureCategory: v.optional(v.string()),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  latencyMs: v.number(),
  probe: v.boolean(),
  currency: v.string(),
  amountMinor: v.number(),
  country: v.optional(v.string()),
  paymentMethod: v.string(),
  startedAt: v.number(),
})
  .index("by_transaction", ["transactionId", "attempt"])
  .index("by_org_started", ["orgId", "startedAt"])
  .index("by_connection_started", ["connectionId", "startedAt"]);

// Circuit breaker state per connection (pure transitions in orchestration/circuit.ts).
export const circuitStates = defineTable({
  connectionId: v.string(),
  providerId: v.string(),
  state: v.union(v.literal("closed"), v.literal("open"), v.literal("half_open")),
  consecutiveFailures: v.number(),
  openedAt: v.optional(v.number()),
  nextProbeAt: v.optional(v.number()),
  cooldownMs: v.optional(v.number()),
  lastFailureReason: v.optional(v.string()),
  updatedAt: v.number(),
}).index("by_connection", ["connectionId"]);

// Inbound provider webhooks — de-duplicated by (provider, eventId).
export const providerEvents = defineTable({
  providerId: v.string(),
  connectionKey: v.string(),
  eventId: v.string(),
  rawType: v.string(),
  verified: v.boolean(),
  outcome: v.string(), // applied | noop | stale | exception | unmatched | rejected
  transactionId: v.optional(v.id("transactions")),
  detail: v.optional(v.string()),
  receivedAt: v.number(),
})
  .index("by_provider_event", ["providerId", "eventId"])
  .index("by_received", ["receivedAt"]);

// Recovery queue — unknown outcomes and abandoned customer actions are
// resolved by polling the SAME provider, never by re-sending.
export const recoveryJobs = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.id("transactions"),
  kind: v.union(v.literal("charge_status"), v.literal("refund_status"), v.literal("action_expiry")),
  providerId: v.string(),
  connectionId: v.string(),
  checksDone: v.number(),
  nextCheckAt: v.number(),
  deadlineAt: v.number(),
  status: v.union(v.literal("open"), v.literal("resolved"), v.literal("escalated"), v.literal("cancelled")),
  lastResult: v.optional(v.string()),
  refundId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_status_next", ["status", "nextCheckAt"])
  .index("by_transaction", ["transactionId"]);

// Refund instructions — one row per refund, separate from the payment.
export const refunds = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.id("transactions"),
  refundId: v.string(), // rf_...
  amountMinor: v.number(),
  currency: v.string(),
  status: v.union(v.literal("pending"), v.literal("successful"), v.literal("failed")),
  provider: v.string(),
  providerRefundReference: v.optional(v.string()),
  reason: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  requestedBy: v.string(),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
})
  .index("by_transaction", ["transactionId"])
  .index("by_refund_id", ["refundId"])
  .index("by_org_created", ["orgId", "createdAt"]);

// FX — rate snapshots from pluggable sources and customer quotes.
export const fxRateSnapshots = defineTable({
  base: v.string(),
  source: v.string(),
  rates: v.any(), // { [ISO]: decimal string }
  sourceTimestamp: v.number(),
  fetchedAt: v.number(),
}).index("by_base_fetched", ["base", "fetchedAt"]);

export const fxQuotes = defineTable({
  orgId: v.id("organizations"),
  quoteId: v.string(), // fxq_...
  from: v.string(),
  to: v.string(),
  midRate: v.string(),
  rate: v.string(),
  spreadBps: v.number(),
  sourceAmountMinor: v.number(),
  targetAmountMinor: v.number(),
  spreadCostMinor: v.number(),
  source: v.string(),
  sourceTimestamp: v.number(),
  expiresAt: v.number(),
  usedByTransactionId: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_quote_id", ["quoteId"])
  .index("by_org_created", ["orgId", "createdAt"]);

// Provider settlement-report reconciliation runs.
export const reconRuns = defineTable({
  orgId: v.id("organizations"),
  provider: v.string(),
  source: v.string(), // filename / "api"
  periodStart: v.optional(v.number()),
  periodEnd: v.optional(v.number()),
  rows: v.number(),
  matched: v.number(),
  exceptions: v.number(),
  totals: v.any(), // per-currency { reportedMinor, expectedMinor, feeReportedMinor, feeExpectedMinor }
  status: v.union(v.literal("completed"), v.literal("failed")),
  createdBy: v.string(),
  createdAt: v.number(),
}).index("by_org_created", ["orgId", "createdAt"]);

// MFA (TOTP) — secret sealed with the platform key.
export const userMfa = defineTable({
  userId: v.id("users"),
  sealedSecret: v.string(),
  status: v.union(v.literal("pending"), v.literal("enabled")),
  lastUsedCounter: v.optional(v.number()),
  /** Step-up window: sensitive actions allowed until this time. */
  verifiedUntil: v.optional(v.number()),
  recoveryCodeHashes: v.optional(v.array(v.string())),
  createdAt: v.number(),
  enabledAt: v.optional(v.number()),
}).index("by_user", ["userId"]);

// Platform feature flags (operations console).
export const featureFlags = defineTable({
  key: v.string(),
  enabled: v.boolean(),
  description: v.string(),
  updatedBy: v.optional(v.string()),
  updatedAt: v.number(),
}).index("by_key", ["key"]);

// API usage metering — per key per UTC day.
export const apiUsage = defineTable({
  orgId: v.id("organizations"),
  apiKeyId: v.id("apiKeys"),
  day: v.string(),
  requests: v.number(),
  errors4xx: v.number(),
  errors5xx: v.number(),
  byRoute: v.any(), // { "POST /api/v1/payments": n }
  updatedAt: v.number(),
})
  .index("by_key_day", ["apiKeyId", "day"])
  .index("by_org_day", ["orgId", "day"]);

// Team invitations — the invitee joins by signing in with the invited email.
export const orgInvitations = defineTable({
  orgId: v.id("organizations"),
  email: v.string(),
  role: roleValidator,
  status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked")),
  invitedBy: v.id("users"),
  expiresAt: v.number(),
  createdAt: v.number(),
  acceptedAt: v.optional(v.number()),
})
  .index("by_email_status", ["email", "status"])
  .index("by_org", ["orgId"]);

// Enterprise sales enquiries from the public website.
export const contactRequests = defineTable({
  name: v.string(),
  email: v.string(),
  company: v.string(),
  country: v.optional(v.string()),
  volume: v.optional(v.string()),
  message: v.optional(v.string()),
  status: v.union(v.literal("new"), v.literal("contacted"), v.literal("closed")),
  createdAt: v.number(),
}).index("by_email_created", ["email", "createdAt"]).index("by_created", ["createdAt"]);

// In-app notifications (alerts, recon exceptions, provider incidents).
export const notifications = defineTable({
  orgId: v.optional(v.id("organizations")), // absent = platform operators
  kind: v.string(), // provider_incident | recon_exception | anomaly | security | system
  severity: v.union(v.literal("info"), v.literal("warning"), v.literal("critical")),
  title: v.string(),
  body: v.string(),
  link: v.optional(v.string()),
  dedupeKey: v.optional(v.string()),
  readBy: v.optional(v.array(v.string())),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_dedupe", ["dedupeKey"]);

// ---------------------------------------------------------------------------
// GitHub integration — org-scoped connection for repository visibility in the
// developer platform. The PAT is stored only as a SHA-256 hash (see github.ts).
// ---------------------------------------------------------------------------
export const githubConnections = defineTable({
  orgId: v.id("organizations"),
  /** GitHub user/org the token belongs to (from /user endpoint). */
  accountLogin: v.string(),
  accountType: v.string(), // "User" | "Organization"
  /** Bare PAT never stored — kept only as SHA-256 hash; last 4 chars for UI. */
  tokenHash: v.string(),
  tokenHint: v.string(),
  scopes: v.optional(v.string()),
  connectedByUserId: v.optional(v.id("users")),
  status: v.union(v.literal("active"), v.literal("revoked")),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastVerifiedAt: v.optional(v.number()),
})
  .index("by_org", ["orgId"])
  .index("by_org_login", ["orgId", "accountLogin"]);

const schema = defineSchema(
  {
    ...authTables, // do not remove or modify

    users: defineTable({
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      email: v.optional(v.string()),
      emailVerificationTime: v.optional(v.number()),
      isAnonymous: v.optional(v.boolean()),
      role: v.optional(roleValidator),
    }).index("email", ["email"]),

    organizations,
    orgMembers,
    merchants,
    apiKeys,
    transactions,
    transactionEvents,
    ledgerAccounts,
    ledgerEntries,
    idempotencyKeys,
    settlementBatches,
    bankRecords,
    reconExceptions,
    webhookEndpoints,
    webhookDeliveries,
    auditLogs,
    customers,
    paymentLinks,
    beneficiaries,
    payouts,
    disputes,
    disputeEvents,
    providerHealth,
    githubConnections,
    providerConnections,
    routingRules,
    routingDecisions,
    paymentAttempts,
    circuitStates,
    providerEvents,
    recoveryJobs,
    refunds,
    fxRateSnapshots,
    fxQuotes,
    reconRuns,
    userMfa,
    featureFlags,
    apiUsage,
    notifications,
    orgInvitations,
    contactRequests,
  },
  {
    schemaValidation: false,
  },
);

export default schema;
