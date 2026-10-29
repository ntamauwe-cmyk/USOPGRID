// USOPGRID public REST API v1.
//
// Every authenticated endpoint goes through `endpoint()`, which:
//   - authenticates the secret key (hash lookup) and applies its rate limit
//   - resolves tenant + environment FROM THE KEY, never from the request
//   - assigns / echoes a correlation id (X-Request-Id → X-USOPGRID-Request-Id)
//   - maps every error into the documented error envelope
//   - meters usage per key, per route, per day
//
// Request bodies accept snake_case (documented) and the earlier camelCase.

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  authenticateRequest,
  readJsonBody,
  requestIdFrom,
  jsonOk,
  handleApiError,
  corsPreflight,
  ApiError,
  API_VERSION,
  type AuthedKey,
  clientIp,
  throttle,
} from "./lib/httpservice";
import { fingerprint } from "./lib/idempotency";
import { listDescriptors, getAdapter, PAYMENT_METHODS } from "./providers/index";
import { route as routePayment } from "./orchestration/router";
import { STATE_LABELS } from "./orchestration/states";
import type { ProcessResult, TransactionSummary } from "./payments";
import type { RoutingContext } from "./connections";
import { CURRENCIES, COUNTRIES } from "../lib/geo";
import { buildOpenApiSpec } from "./lib/openapi";
import { approvalGate } from "./payouts";

type Handler = (ctx: ActionCtx, request: Request, key: AuthedKey, requestId: string) => Promise<Response>;

function endpoint(routeName: string, fn: Handler) {
  return httpAction(async (ctx, request) => {
    const requestId = requestIdFrom(request);
    let key: AuthedKey | null = null;
    let res: Response;
    try {
      key = await authenticateRequest(ctx, request);
      if (key.scope === "read_only" && !routeName.startsWith("GET ")) {
        throw new ApiError("authorization_error", "This API key is read-only. Use a full-access key to create or change data.");
      }
      res = await fn(ctx, request, key, requestId);
    } catch (err) {
      res = handleApiError(err, requestId);
    }
    if (key) {
      try {
        await ctx.runMutation(internal.lib.httpserviceInternal.meterInternal, {
          apiKeyId: key.keyId as Id<"apiKeys">,
          orgId: key.orgId as Id<"organizations">,
          route: routeName,
          status: res.status,
        });
      } catch {
        // metering must never fail a financial request
      }
    }
    return res;
  });
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------
function pick<T = unknown>(body: Record<string, unknown>, ...names: string[]): T | undefined {
  for (const n of names) if (body[n] !== undefined && body[n] !== null) return body[n] as T;
  return undefined;
}

function optString(body: Record<string, unknown>, max: number, ...names: string[]): string | undefined {
  const val = pick(body, ...names);
  if (val === undefined) return undefined;
  if (typeof val !== "string") throw new ApiError("validation_error", `${names[0]} must be a string.`);
  const t = val.trim();
  if (t.length > max) throw new ApiError("validation_error", `${names[0]} must be at most ${max} characters.`);
  return t || undefined;
}

function sanitizeMetadata(m: unknown): Record<string, unknown> | undefined {
  if (m === undefined || m === null) return undefined;
  if (typeof m !== "object" || Array.isArray(m)) throw new ApiError("validation_error", "metadata must be an object.");
  const entries = Object.entries(m as Record<string, unknown>);
  if (entries.length > 50) throw new ApiError("validation_error", "metadata supports at most 50 keys.");
  for (const [k, val] of entries) {
    if (k.length > 40) throw new ApiError("validation_error", "metadata keys must be at most 40 characters.");
    if (typeof val === "string" && val.length > 500) throw new ApiError("validation_error", "metadata values must be at most 500 characters.");
    if (typeof val === "object" && val !== null) throw new ApiError("validation_error", "metadata values must be strings, numbers or booleans.");
  }
  return m as Record<string, unknown>;
}

function paymentJson(t: TransactionSummary) {
  return {
    id: t.transactionId,
    object: "payment",
    reference: t.reference,
    status: t.status,
    status_label: STATE_LABELS[t.status as keyof typeof STATE_LABELS] ?? t.status,
    amount: t.amountMinor,
    currency: t.currency,
    payment_method: t.paymentMethod,
    country: t.country,
    provider: t.provider,
    provider_reference: t.providerReference,
    fee: t.feeMinor,
    net: t.netMinor,
    refunded_amount: t.refundedMinor,
    attempts: t.attempts,
    failovers: t.failovers,
    outcome_unknown: t.outcomeUnknown,
    next_action: t.nextAction,
    failure: t.failure,
    created_at: new Date(t.createdAt).toISOString(),
  };
}

function txnJson(t: Doc<"transactions">) {
  return paymentJson({
    transactionId: t.transactionId,
    reference: t.reference,
    status: t.status,
    amountMinor: t.amountMinor,
    currency: t.currency,
    paymentMethod: t.paymentMethod,
    country: t.country ?? null,
    feeMinor: t.feeMinor ?? null,
    netMinor: t.netMinor ?? null,
    refundedMinor: t.refundedMinor ?? 0,
    provider: t.provider,
    providerReference: t.providerReference ?? null,
    attempts: t.attemptCount ?? 0,
    failovers: t.failoverCount ?? 0,
    outcomeUnknown: t.outcomeUnknown ?? false,
    nextAction: (t.nextAction as TransactionSummary["nextAction"]) ?? null,
    failure: t.failureCode
      ? { category: t.failureCategory ?? "", code: t.failureCode, message: t.failureMessage ?? "", retryable: t.failureRetryable ?? false }
      : null,
    createdAt: t.createdAt,
  });
}

async function resolvePrimaryMerchant(ctx: ActionCtx, orgId: Id<"organizations">): Promise<Id<"merchants">> {
  const merchant = await ctx.runQuery(internal.apiInternal.orgPrimaryMerchantInternal, { orgId });
  if (!merchant) throw new ApiError("validation_error", "No merchant is configured for this organization. Create one in the dashboard.");
  return merchant._id;
}

function processResultToResponse(result: ProcessResult, requestId: string): { status: number; body: unknown } {
  if (result.kind === "rejected" || !result.transaction) {
    const code = (result.error?.code ?? "processing_error") as ConstructorParameters<typeof ApiError>[0];
    throw new ApiError(code, result.error?.message ?? "Payment could not be created.");
  }
  void requestId;
  return { status: 201, body: { payment: paymentJson(result.transaction) } };
}

// ---------------------------------------------------------------------------
// POST /api/v1/payments
// ---------------------------------------------------------------------------
export const createPayment = endpoint("POST /payments", async (ctx, request, key, requestId) => {
  const body = await readJsonBody(request);
  const amountMinor = pick<number>(body, "amount", "amountMinor");
  const currency = String(pick(body, "currency") ?? "").toUpperCase();
  const paymentMethod = String(pick(body, "payment_method", "paymentMethod") ?? "");
  const country = optString(body, 2, "country")?.toUpperCase();
  const customer = (pick<Record<string, unknown>>(body, "customer") ?? {}) as Record<string, unknown>;
  const customerEmail = optString(customer, 254, "email") ?? optString(body, 254, "customer_email", "customerEmail");
  const customerName = optString(customer, 200, "name") ?? optString(body, 200, "customer_name", "customerName");
  const customerPhone = optString(customer, 32, "phone") ?? optString(body, 32, "customer_phone", "customerPhone");
  const reference = optString(body, 120, "reference") ?? `ref_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const metadata = sanitizeMetadata(pick(body, "metadata"));
  const savePaymentMethod = pick(body, "save_payment_method", "savePaymentMethod") === true;

  if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) <= 0) {
    throw new ApiError("validation_error", "amount must be a positive integer in the currency's minor unit (e.g. cents).");
  }
  if (savePaymentMethod && !customerEmail) throw new ApiError("validation_error", "save_payment_method needs customer.email, so the saved method belongs to a customer.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError("validation_error", "currency must be a 3-letter ISO 4217 code.");
  if (!(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    throw new ApiError("validation_error", `payment_method must be one of: ${PAYMENT_METHODS.join(", ")}.`);
  }
  if (customerEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    throw new ApiError("validation_error", "customer.email must be a valid email address.");
  }
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw new ApiError("validation_error", "country must be an ISO 3166-1 alpha-2 code.");

  const orgId = key.orgId as Id<"organizations">;
  const args = {
    orgId,
    merchantId: await resolvePrimaryMerchant(ctx, orgId),
    environment: key.environment,
    amountMinor: amountMinor as number,
    currency,
    reference,
    paymentMethod,
    country,
    customerEmail: customerEmail?.toLowerCase(),
    customerName,
    customerPhone,
    paymentToken: optString(body, 500, "payment_token", "paymentToken"),
    returnUrl: optString(body, 2000, "return_url", "returnUrl"),
    description: optString(body, 500, "description"),
    metadata,
    requestId,
    actor: key.prefix,
    savePaymentMethod: savePaymentMethod || undefined,
  };

  const idemKey = request.headers.get("Idempotency-Key");
  if (!idemKey) {
    const result: ProcessResult = await ctx.runAction(internal.payments.processPaymentInternal, args);
    const r = processResultToResponse(result, requestId);
    return jsonOk(r.body, r.status, requestId);
  }
  if (idemKey.length > 255) throw new ApiError("validation_error", "Idempotency-Key must be at most 255 characters.");

  // Fingerprint covers client-supplied fields only (never server-generated ones).
  const fp = await fingerprint({ amountMinor, currency, paymentMethod, country: country ?? null, reference: pick(body, "reference") ?? null, customerEmail: customerEmail ?? null, metadata: metadata ?? null, env: key.environment, savePaymentMethod });
  const acquired = await ctx.runMutation(internal.lib.idempotency.acquireInternal, { orgId, key: idemKey, fp });
  if (acquired.type === "replay") return jsonOk(acquired.responseBody, acquired.statusCode, requestId);
  if (acquired.type === "conflict") throw new ApiError("idempotency_conflict", "This Idempotency-Key was already used with a different request body.");
  if (acquired.type === "in_progress") throw new ApiError("conflict", "An identical request is currently in progress. Retry shortly.", true, { retryAfterSec: 2 });
  try {
    const result: ProcessResult = await ctx.runAction(internal.payments.processPaymentInternal, { ...args, idempotencyKey: idemKey });
    const r = processResultToResponse(result, requestId);
    await ctx.runMutation(internal.lib.idempotency.completeInternal, {
      recordId: acquired.recordId as Id<"idempotencyKeys">,
      response: { statusCode: r.status, body: r.body },
      transactionId: undefined,
    });
    return jsonOk(r.body, r.status, requestId);
  } catch (err) {
    await ctx.runMutation(internal.lib.idempotency.failInternal, { recordId: acquired.recordId as Id<"idempotencyKeys"> });
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/payments — list with cursor pagination + filters
// ---------------------------------------------------------------------------
export const listPayments = endpoint("GET /payments", async (ctx, request, key, requestId) => {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 25) || 25, 1), 100);
  const status = url.searchParams.get("status")?.toUpperCase() || undefined;
  const parseDate = (name: string) => {
    const raw = url.searchParams.get(name);
    if (!raw) return undefined;
    const t = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw);
    if (!Number.isFinite(t)) throw new ApiError("validation_error", `${name} must be an ISO-8601 date or unix seconds.`);
    return t;
  };
  if (status && !(status in STATE_LABELS)) throw new ApiError("validation_error", `status must be one of: ${Object.keys(STATE_LABELS).join(", ")}.`);
  const page = (await ctx.runQuery(internal.apiInternal.listTransactionsInternal, {
    orgId: key.orgId as Id<"organizations">,
    environment: key.environment,
    status,
    createdGte: parseDate("created_gte"),
    createdLte: parseDate("created_lte"),
    cursor: url.searchParams.get("cursor") || null,
    limit,
  })) as { page: Doc<"transactions">[]; isDone: boolean; continueCursor: string };
  return jsonOk({ object: "list", data: page.page.map(txnJson), has_more: !page.isDone, next_cursor: page.isDone ? null : page.continueCursor }, 200, requestId);
});

// ---------------------------------------------------------------------------
// GET /api/v1/payments/:id   and   POST /api/v1/payments/:id/refund
// ---------------------------------------------------------------------------
export const getPayment = endpoint("GET /payments/:id", async (ctx, request, key, requestId) => {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const transactionId = parts[3] ?? "";
  if (parts.length > 4) throw new ApiError("not_found", "Unknown endpoint.");
  const d = (await ctx.runQuery(internal.apiInternal.transactionDetailInternal, { orgId: key.orgId as Id<"organizations">, transactionId })) as {
    txn: Doc<"transactions">;
    attempts: Doc<"paymentAttempts">[];
    routing: Doc<"routingDecisions"> | null;
    refunds: Doc<"refunds">[];
    events: Doc<"transactionEvents">[];
  } | null;
  if (!d) throw new ApiError("not_found", `No payment '${transactionId}' in this organization.`);
  return jsonOk(
    {
      payment: {
        ...txnJson(d.txn),
        customer: { email: d.txn.customerEmail ?? null, name: d.txn.customerName ?? null },
        metadata: d.txn.metadata ?? {},
        routing: d.routing ? { explanation: d.routing.explanation, chain: d.routing.chain.map((c) => c.providerId), matched_rules: d.routing.matchedRules } : null,
        attempt_log: d.attempts
          .sort((a, b) => a.attempt - b.attempt)
          .map((a) => ({ attempt: a.attempt, provider: a.providerId, status: a.status, latency_ms: a.latencyMs, failure: a.failureCode ? { category: a.failureCategory, code: a.failureCode, message: a.failureMessage } : null })),
        refunds: d.refunds.map((r) => ({ id: r.refundId, amount: r.amountMinor, status: r.status, created_at: new Date(r.createdAt).toISOString() })),
        timeline: d.events.sort((a, b) => a.at - b.at).map((e) => ({ type: e.type, from: e.fromStatus ?? null, to: e.toStatus ?? null, at: new Date(e.at).toISOString() })),
        updated_at: new Date(d.txn.updatedAt).toISOString(),
      },
    },
    200,
    requestId,
  );
});

export const refundPayment = endpoint("POST /payments/:id/refund", async (ctx, request, key, requestId) => {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean); // api v1 payments :id refund
  if (parts.length !== 5 || parts[4] !== "refund") throw new ApiError("not_found", "Unknown endpoint. Use POST /api/v1/payments/:id/refund.");
  const transactionId = parts[3];
  let amountMinor: number | undefined;
  let reason: string | undefined;
  const text = await request.text();
  if (text.trim()) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError("validation_error", "Request body must be valid JSON.");
    }
    const amt = pick<number>(body, "amount", "amountMinor");
    if (amt !== undefined) {
      if (!Number.isSafeInteger(amt) || amt <= 0) throw new ApiError("validation_error", "amount must be a positive integer (minor units).");
      amountMinor = amt;
    }
    reason = optString(body, 500, "reason");
  }
  const result = (await ctx.runAction(internal.payments.refundInternal, {
    transactionId,
    orgId: key.orgId as Id<"organizations">,
    amountMinor,
    reason,
    idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
    requestId,
    actor: key.prefix,
  })) as { kind: "error" | "done"; code?: string; message?: string; transaction?: TransactionSummary; refundId?: string };
  if (result.kind === "error") {
    const map: Record<string, ConstructorParameters<typeof ApiError>[0]> = {
      not_found: "not_found",
      validation_error: "validation_error",
      conflict: "conflict",
      idempotency_conflict: "idempotency_conflict",
      provider_refund_failed: "provider_unavailable",
    };
    const code = map[result.code ?? ""] ?? "processing_error";
    throw new ApiError(code, result.message ?? "Refund failed.", code === "provider_unavailable");
  }
  return jsonOk({ refund: { id: result.refundId, status: result.transaction?.status === "REFUND_PENDING" ? "pending" : "successful" }, payment: paymentJson(result.transaction!) }, 200, requestId);
});

// ---------------------------------------------------------------------------
// Capability discovery + routing simulation
// ---------------------------------------------------------------------------
export const listProviders = endpoint("GET /providers", async (_ctx, _request, _key, requestId) => {
  return jsonOk(
    {
      object: "list",
      data: listDescriptors().map((d) => ({
        id: d.id,
        name: d.displayName,
        category: d.category,
        countries: d.countries,
        currencies: d.currencies,
        payment_methods: d.methods,
        operations: d.operations,
        docs_url: d.docsUrl,
      })),
    },
    200,
    requestId,
  );
});

export const simulateRouting = endpoint("POST /routing/simulate", async (ctx, request, key, requestId) => {
  const body = await readJsonBody(request);
  const amountMinor = pick<number>(body, "amount", "amountMinor");
  const currency = String(pick(body, "currency") ?? "").toUpperCase();
  const method = String(pick(body, "payment_method", "paymentMethod") ?? "");
  const country = optString(body, 2, "country")?.toUpperCase();
  if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) <= 0) throw new ApiError("validation_error", "amount must be a positive integer.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError("validation_error", "currency must be ISO 4217.");
  const rc: RoutingContext = await ctx.runQuery(internal.connections.routingContextInternal, { orgId: key.orgId as Id<"organizations">, environment: key.environment });
  const candidates = rc.candidates.flatMap((c) => {
    const a = getAdapter(c.providerId);
    return a ? [{ ...c, descriptor: a.descriptor }] : [];
  });
  const d = routePayment({ request: { country, currency, method, amountMinor: amountMinor as number }, candidates, stats: rc.stats, circuits: rc.circuits, rules: rc.rules, strategy: rc.strategy, now: Date.now() });
  return jsonOk(
    {
      explanation: d.explanation,
      chain: d.chain.map((c) => c.providerId),
      candidates: d.evaluations.map((e) => ({ provider: e.providerId, eligible: e.eligible, score: e.score, reasons: e.reasons, components: e.components, estimated_fee: e.estimatedFeeMinor, circuit: e.circuit })),
      matched_rules: d.matchedRules,
    },
    200,
    requestId,
  );
});

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------
export const createFxQuote = endpoint("POST /fx/quotes", async (ctx, request, key, requestId) => {
  const body = await readJsonBody(request);
  const from = String(pick(body, "from", "source_currency") ?? "").toUpperCase();
  const to = String(pick(body, "to", "target_currency") ?? "").toUpperCase();
  const amountMinor = pick<number>(body, "amount", "amountMinor");
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw new ApiError("validation_error", "from and to must be ISO 4217 codes.");
  if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) <= 0) throw new ApiError("validation_error", "amount must be a positive integer in minor units of `from`.");
  const q = await ctx.runMutation(internal.fxrates.createQuoteInternal, { orgId: key.orgId as Id<"organizations">, from, to, amountMinor: amountMinor as number });
  return jsonOk(
    {
      quote: {
        id: q.quoteId,
        from: q.from,
        to: q.to,
        source_amount: q.sourceAmountMinor,
        target_amount: q.targetAmountMinor,
        rate: q.rate,
        mid_rate: q.midRate,
        spread_bps: q.spreadBps,
        rate_source: q.source,
        rate_timestamp: new Date(q.sourceTimestamp).toISOString(),
        expires_at: new Date(q.expiresAt).toISOString(),
      },
    },
    201,
    requestId,
  );
});

// ---------------------------------------------------------------------------
// Balance / settlements / payouts / customers (unchanged contracts)
// ---------------------------------------------------------------------------
export const getBalance = endpoint("GET /balance", async (ctx, _request, key, requestId) => {
  const balances = (await ctx.runQuery(internal.apiInternal.orgBalancesInternal, { orgId: key.orgId as Id<"organizations"> })) as {
    merchantName: string;
    currency: string;
    balanceMinor: number;
    kind: string;
  }[];
  return jsonOk({ balances: balances.map((b) => ({ account: b.kind, merchant: b.merchantName, currency: b.currency, balance: b.balanceMinor })) }, 200, requestId);
});

export const listSettlements = endpoint("GET /settlements", async (ctx, request, key, requestId) => {
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 20) || 20, 100);
  const batches = (await ctx.runQuery(internal.apiInternal.listBatchesInternal, { orgId: key.orgId as Id<"organizations">, limit })) as Doc<"settlementBatches">[];
  return jsonOk(
    {
      settlements: batches.map((b) => ({
        reference: b.reference,
        status: b.status,
        currency: b.currency,
        gross: b.grossMinor,
        fee: b.feeMinor,
        reserve: b.reserveMinor,
        net: b.netMinor,
        settled_at: b.settledAt ? new Date(b.settledAt).toISOString() : null,
        created_at: new Date(b.createdAt).toISOString(),
      })),
    },
    200,
    requestId,
  );
});

export const createPayout = endpoint("POST /payouts", async (ctx, request, key, requestId) => {
  const body = await readJsonBody(request);
  const amountMinor = pick<number>(body, "amount", "amountMinor");
  const beneficiaryId = pick<string>(body, "beneficiary_id", "beneficiaryId");
  if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) <= 0) throw new ApiError("validation_error", "amount must be a positive integer (minor units).");
  if (typeof beneficiaryId !== "string" || !beneficiaryId) throw new ApiError("validation_error", "beneficiary_id is required.");
  let beneficiary: Doc<"beneficiaries"> | null = null;
  try {
    beneficiary = await ctx.runQuery(internal.apiInternal.beneficiaryByIdInternal, { beneficiaryId: beneficiaryId as Id<"beneficiaries"> });
  } catch {
    beneficiary = null;
  }
  if (!beneficiary || beneficiary.orgId !== key.orgId) throw new ApiError("not_found", "Beneficiary not found in this organization.");
  // Two-person approval: the payout waits for a second team member in the dashboard.
  const approvalId = await approvalGate(ctx, {
    orgId: key.orgId as Id<"organizations">,
    beneficiary,
    amountMinor: amountMinor as number,
    narration: optString(body, 140, "narration"),
    requestedBy: `api:${key.prefix}`,
    requestedByLabel: `API key ${key.prefix}`,
    idempotencyKey: request.headers.get("Idempotency-Key") ? `payout_${request.headers.get("Idempotency-Key")}` : undefined,
  });
  if (approvalId) {
    return jsonOk({ payout: null, approval: { id: approvalId, status: "pending_approval", message: "This payout needs a second approver in the USOPGRID dashboard (Approvals) before money moves." } }, 202, requestId);
  }
  const result = (await ctx.runAction(internal.payouts.payoutInternal, {
    orgId: key.orgId as Id<"organizations">,
    beneficiaryId: beneficiaryId as Id<"beneficiaries">,
    amountMinor: amountMinor as number,
    narration: optString(body, 140, "narration"),
    idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
    actor: key.prefix,
    requestId,
  })) as { kind: string; message?: string; payoutId?: string; status?: string };
  if (result.kind === "error") {
    const msg = result.message ?? "Payout failed.";
    throw new ApiError(
      msg.startsWith("VALIDATION_ERROR") ? "validation_error" : msg.startsWith("NOT_FOUND") ? "not_found" : msg.startsWith("CONFLICT") ? "conflict" : "processing_error",
      msg.replace(/^(VALIDATION_ERROR|NOT_FOUND|CONFLICT): /, ""),
    );
  }
  const payout = (await ctx.runQuery(internal.apiInternal.payoutByPayoutIdInternal, { payoutId: result.payoutId! })) as Doc<"payouts"> | null;
  return jsonOk(
    {
      payout: payout
        ? {
            id: payout.payoutId,
            status: payout.status,
            amount: payout.amountMinor,
            fee: payout.feeMinor,
            currency: payout.currency,
            beneficiary: { name: beneficiary.name, account: beneficiary.accountMasked, bank: beneficiary.bankName },
            provider_reference: payout.providerReference ?? null,
            failure: payout.failureCode ? { code: payout.failureCode, message: payout.failureMessage, retryable: payout.failureRetryable ?? false } : null,
          }
        : { id: result.payoutId, status: result.status },
    },
    201,
    requestId,
  );
});

export const listPayouts = endpoint("GET /payouts", async (ctx, request, key, requestId) => {
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 20) || 20, 100);
  const payouts = (await ctx.runQuery(internal.apiInternal.listPayoutsInternal, { orgId: key.orgId as Id<"organizations">, limit })) as Doc<"payouts">[];
  return jsonOk(
    {
      payouts: payouts.map((p) => ({
        id: p.payoutId,
        status: p.status,
        amount: p.amountMinor,
        fee: p.feeMinor,
        currency: p.currency,
        beneficiary_id: p.beneficiaryId,
        provider_reference: p.providerReference ?? null,
        failure: p.failureCode ? { code: p.failureCode, message: p.failureMessage } : null,
        created_at: new Date(p.createdAt).toISOString(),
      })),
    },
    200,
    requestId,
  );
});

export const listCustomers = endpoint("GET /customers", async (ctx, request, key, requestId) => {
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 50) || 50, 200);
  const customers = (await ctx.runQuery(internal.apiInternal.listCustomersInternal, { orgId: key.orgId as Id<"organizations">, limit })) as Doc<"customers">[];
  return jsonOk(
    {
      customers: customers.map((c) => ({
        email: c.email,
        name: c.name ?? null,
        transactions: c.transactionCount,
        successful: c.successfulCount,
        // Per-currency lifetime volume in minor units — never summed across currencies.
        lifetime_volume_by_currency: (c.lifetimeVolumeByCurrency as Record<string, number> | undefined) ?? {},
        status: c.status,
        last_seen: c.lastTransactionAt ? new Date(c.lastTransactionAt).toISOString() : null,
      })),
    },
    200,
    requestId,
  );
});

// ---------------------------------------------------------------------------
// Public (unauthenticated) endpoints
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Recurring billing: saved payment methods, plans, subscriptions
// ---------------------------------------------------------------------------
const billingError = (err: unknown): never => {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^(?:Uncaught ConvexError: )?(VALIDATION_ERROR|NOT_FOUND|CONFLICT|FORBIDDEN): (.*)$/s.exec(msg);
  if (m) throw new ApiError(m[1] === "NOT_FOUND" ? "not_found" : m[1] === "CONFLICT" ? "conflict" : m[1] === "FORBIDDEN" ? "authorization_error" : "validation_error", m[2]);
  throw err;
};

export const listPaymentMethods = endpoint("GET /payment_methods", async (ctx, request, key, requestId) => {
  const email = new URL(request.url).searchParams.get("customer_email") ?? undefined;
  const rows = await ctx.runQuery(internal.billing.listPaymentMethodsInternal, { orgId: key.orgId as Id<"organizations">, customerEmail: email });
  return jsonOk({ payment_methods: rows.filter((r) => r.livemode === (key.environment === "production")) }, 200, requestId);
});

export const createPaymentMethod = endpoint("POST /payment_methods", async (ctx, request, key, requestId) => {
  const body = await readJsonBody(request);
  const provider = String(pick(body, "provider") ?? "");
  const token = String(pick(body, "token") ?? "");
  const email = optString(body, 254, "customer_email")?.toLowerCase();
  if (!provider || !token || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError("validation_error", "provider, token and a valid customer_email are required.");
  const r = await ctx.runAction(internal.billing.importPaymentMethodInternal, {
    orgId: key.orgId as Id<"organizations">,
    environment: key.environment,
    providerId: provider,
    token,
    customerEmail: email,
    brand: optString(body, 24, "brand"),
    last4: optString(body, 4, "last4"),
    expMonth: typeof body.exp_month === "number" ? body.exp_month : undefined,
    expYear: typeof body.exp_year === "number" ? body.exp_year : undefined,
  });
  if (r.error || !r.methodId) throw new ApiError("validation_error", r.error ?? "Could not save the payment method.");
  const rows = await ctx.runQuery(internal.billing.listPaymentMethodsInternal, { orgId: key.orgId as Id<"organizations">, customerEmail: email });
  return jsonOk({ payment_method: rows.find((p) => p.id === r.methodId) ?? { id: r.methodId } }, 201, requestId);
});

export const paymentMethodAction = endpoint("POST /payment_methods/:id/revoke", async (ctx, request, key, requestId) => {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[4] !== "revoke" || parts.length !== 5) throw new ApiError("not_found", "Unknown endpoint.");
  const r = await ctx.runMutation(internal.billing.revokePaymentMethodInternal, { orgId: key.orgId as Id<"organizations">, methodId: parts[3], actor: key.prefix });
  if (!r) throw new ApiError("not_found", "No such payment method in this organization.");
  return jsonOk({ payment_method: r }, 200, requestId);
});

export const listPlans = endpoint("GET /plans", async (ctx, _request, key, requestId) =>
  jsonOk({ plans: await ctx.runQuery(internal.billing.listPlansInternal, { orgId: key.orgId as Id<"organizations"> }) }, 200, requestId),
);

export const createPlan = endpoint("POST /plans", async (ctx, request, key, requestId) => {
  const body = await readJsonBody(request);
  try {
    const plan = await ctx.runMutation(internal.billing.createPlanInternal, {
      orgId: key.orgId as Id<"organizations">,
      name: String(pick(body, "name") ?? ""),
      amountMinor: Number(pick(body, "amount")),
      currency: String(pick(body, "currency") ?? "").toUpperCase(),
      interval: String(pick(body, "interval") ?? "") as "day" | "week" | "month" | "year",
      intervalCount: Number(pick(body, "interval_count") ?? 1),
      trialDays: pick(body, "trial_days") === undefined ? undefined : Number(pick(body, "trial_days")),
      actor: key.prefix,
    });
    return jsonOk({ plan }, 201, requestId);
  } catch (err) {
    return billingError(err);
  }
});

export const listSubscriptions = endpoint("GET /subscriptions", async (ctx, request, key, requestId) => {
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 50) || 50, 200);
  const rows = await ctx.runQuery(internal.billing.listSubscriptionsInternal, { orgId: key.orgId as Id<"organizations">, limit });
  return jsonOk({ subscriptions: rows.filter((r) => r.livemode === (key.environment === "production")) }, 200, requestId);
});

export const createSubscription = endpoint("POST /subscriptions", async (ctx, request, key, requestId) => {
  const body = await readJsonBody(request);
  const orgId = key.orgId as Id<"organizations">;
  try {
    const sub = await ctx.runMutation(internal.billing.createSubscriptionInternal, {
      orgId,
      merchantId: await resolvePrimaryMerchant(ctx, orgId),
      environment: key.environment,
      planId: String(pick(body, "plan_id", "plan") ?? ""),
      paymentMethodId: String(pick(body, "payment_method_id", "payment_method") ?? ""),
      customerName: optString(body, 200, "customer_name"),
      trialDays: pick(body, "trial_days") === undefined ? undefined : Number(pick(body, "trial_days")),
      metadata: sanitizeMetadata(pick(body, "metadata")),
      actor: key.prefix,
    });
    return jsonOk({ subscription: sub }, 201, requestId);
  } catch (err) {
    return billingError(err);
  }
});

export const getSubscription = endpoint("GET /subscriptions/:id", async (ctx, request, key, requestId) => {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts.length !== 4) throw new ApiError("not_found", "Unknown endpoint.");
  const s = await ctx.runQuery(internal.billing.getSubscriptionInternal, { orgId: key.orgId as Id<"organizations">, subscriptionId: parts[3] });
  if (!s) throw new ApiError("not_found", "No such subscription in this organization.");
  return jsonOk({ subscription: s }, 200, requestId);
});

export const subscriptionAction = endpoint("POST /subscriptions/:id/cancel", async (ctx, request, key, requestId) => {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[4] !== "cancel" || parts.length !== 5) throw new ApiError("not_found", "Unknown endpoint.");
  const body = await readJsonBody(request).catch(() => ({}) as Record<string, unknown>);
  try {
    const s = await ctx.runMutation(internal.billing.cancelSubscriptionInternal, { orgId: key.orgId as Id<"organizations">, subscriptionId: parts[3], atPeriodEnd: pick(body, "at_period_end") === true, actor: key.prefix });
    return jsonOk({ subscription: s }, 200, requestId);
  } catch (err) {
    return billingError(err);
  }
});

/** Who is calling: key prefix, environment, scope and the client address USOPGRID sees (for IP allowlists). */
export const whoami = endpoint("GET /whoami", async (_ctx, _request, key, requestId) =>
  jsonOk({ key: key.prefix, environment: key.environment, scope: key.scope, client_ip: key.clientIp }, 200, requestId),
);

export const health = httpAction(async (_ctx, request) =>
  jsonOk({ service: "usopgrid-api", version: "v1", api_version: API_VERSION, time: new Date().toISOString() }, 200, requestIdFrom(request)),
);

export const openapi = httpAction(async (_ctx, request) => {
  const origin = new URL(request.url).origin;
  return new Response(JSON.stringify(buildOpenApiSpec(origin), null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
});

export const referenceData = httpAction(async (_ctx, request) =>
  jsonOk(
    {
      currencies: Object.values(CURRENCIES).filter((c) => c.active).map((c) => ({ code: c.code, name: c.name, minor_unit: c.decimals, symbol: c.symbol })),
      countries: Object.values(COUNTRIES).map((c) => ({ code: c.code, name: c.name, currency: c.currency, region: c.region })),
      payment_methods: PAYMENT_METHODS,
      transaction_states: Object.keys(STATE_LABELS),
    },
    200,
    requestIdFrom(request),
  ),
);

/** GET /api/v1/checkout/:linkId — public link preview (safe fields only). */
export const getLinkPublic = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const linkId = new URL(request.url).pathname.split("/").filter(Boolean)[3] ?? "";
    const ip = clientIp(request);
    if (ip) await throttle(ctx, `checkout_view:ip:${ip}`, 60, 60_000);
    const resolved = (await ctx.runQuery(internal.apiInternal.linkForCheckoutInternal, { linkId })) as { link: Doc<"paymentLinks">; merchantName: string } | null;
    if (!resolved) throw new ApiError("not_found", "Unknown payment link.");
    const { link } = resolved;
    return jsonOk(
      {
        linkId: link.linkId,
        title: link.title,
        description: link.description ?? null,
        amountMinor: link.amountMinor ?? null,
        currency: link.currency,
        status: link.status,
        expired: link.expiresAt !== undefined && link.expiresAt < Date.now(),
        usesExhausted: link.maxUses !== undefined && link.useCount >= link.maxUses,
        merchantName: resolved.merchantName,
        environment: (await ctx.runQuery(internal.apiInternal.orgInfoInternal, { orgId: link.orgId }))?.environment ?? "sandbox",
        paymentMethods: PAYMENT_METHODS,
      },
      200,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

/** POST /api/v1/checkout/:linkId — pay a payment link (public, link-scoped, org environment). */
export const checkoutWithLink = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const linkId = new URL(request.url).pathname.split("/").filter(Boolean)[3] ?? "";
    if (!linkId.startsWith("pl_") || linkId.length > 64) throw new ApiError("not_found", "Unknown payment link.");
    // Card-testing defence: cap attempts per client and per link.
    const ip = clientIp(request);
    if (ip) await throttle(ctx, `checkout_pay:ip:${ip}`, 10, 10 * 60_000);
    await throttle(ctx, `checkout_pay:link:${linkId}`, 60, 10 * 60_000);
    const resolved = (await ctx.runQuery(internal.apiInternal.linkForCheckoutInternal, { linkId })) as { link: Doc<"paymentLinks">; merchantName: string } | null;
    if (!resolved) throw new ApiError("not_found", "Unknown payment link.");
    const { link } = resolved;
    if (link.status !== "active") throw new ApiError("conflict", "This payment link is disabled.");
    if (link.expiresAt !== undefined && link.expiresAt < Date.now()) throw new ApiError("conflict", "This payment link has expired.");
    if (link.maxUses !== undefined && link.useCount >= link.maxUses) throw new ApiError("conflict", "This payment link has reached its usage limit.");
    const org = await ctx.runQuery(internal.apiInternal.orgInfoInternal, { orgId: link.orgId });
    if (!org) throw new ApiError("not_found", "Unknown payment link.");

    const body = await readJsonBody(request);
    const amountMinor = typeof body.amountMinor === "number" ? body.amountMinor : link.amountMinor;
    const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim().toLowerCase() : undefined;
    const customerName = typeof body.customerName === "string" ? body.customerName.slice(0, 200) : undefined;
    const paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod : "card";
    const country = typeof body.country === "string" ? body.country.toUpperCase() : undefined;
    if (link.amountMinor !== undefined && amountMinor !== link.amountMinor) throw new ApiError("validation_error", "This link has a fixed amount.");
    if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) <= 0) throw new ApiError("validation_error", "amountMinor is required for open-amount links.");
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new ApiError("validation_error", "customerEmail is required at checkout.");

    const result: ProcessResult = await ctx.runAction(internal.payments.processPaymentInternal, {
      orgId: link.orgId,
      merchantId: link.merchantId,
      environment: org.environment,
      amountMinor: amountMinor as number,
      currency: link.currency,
      reference: `link_${link.linkId.slice(3, 11)}_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`,
      paymentMethod,
      country,
      customerEmail,
      customerName,
      paymentToken: typeof body.paymentToken === "string" ? body.paymentToken : undefined,
      returnUrl: typeof body.returnUrl === "string" ? body.returnUrl : undefined,
      metadata: { source: "payment_link", linkId, ...(org.environment === "sandbox" && typeof body.simulate === "string" ? { simulate: body.simulate } : {}) },
      requestId,
      actor: `link:${linkId}`,
    });
    const r = processResultToResponse(result, requestId);
    await ctx.runMutation(internal.paylinks.recordLinkAttemptInternal, { linkId, successful: result.transaction?.status === "SUCCESSFUL" });
    return jsonOk({ ...(r.body as object), payment_summary: result.transaction, link: { linkId, title: link.title } }, 201, requestId);
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

export const corsHandler = httpAction(async () => corsPreflight());
