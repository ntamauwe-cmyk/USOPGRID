// OpenAPI 3.1 description of the USOPGRID public API, served at
// GET /api/v1/openapi.json. Generated from the same registries the API uses
// (payment methods, states, providers) so it cannot drift from them.

import { PAYMENT_METHODS } from "../providers/types";
import { TX_STATES } from "../orchestration/states";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema: object, description = "OK") => ({
  description,
  content: { "application/json": { schema: { type: "object", properties: { status: { const: "success" }, requestId: { type: "string" }, data: schema } } } },
});
const errors = {
  "401": { $ref: "#/components/responses/AuthenticationError" },
  "422": { $ref: "#/components/responses/ValidationError" },
  "429": { $ref: "#/components/responses/RateLimited" },
};
const idem = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 }, description: "Makes the request safe to retry. Same key + same body replays the original response; same key + different body returns 422 idempotency_conflict. Keys are kept 24 hours." };

export function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "USOPGRID API",
      version: "v1",
      summary: "Enterprise payment infrastructure — Powering Every Payment Connection.",
      description:
        "Orchestrate payments across global and regional providers through one API. Amounts are integers in the currency's minor unit (ISO 4217 exponent). Sandbox keys (`sk_sandbox_…`) only reach simulated rails; production keys only reach live providers.",
      contact: { name: "USOPGRID Developer Support", url: "https://usopgrid.com/developers" },
      "x-owner": "RAE Horizon Technologies Limited",
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Payments" },
      { name: "Refunds" },
      { name: "Routing" },
      { name: "FX" },
      { name: "Balances & settlements" },
      { name: "Payouts" },
      { name: "Customers" },
      { name: "Reference" },
    ],
    paths: {
      "/payments": {
        post: {
          tags: ["Payments"],
          operationId: "createPayment",
          summary: "Create and process a payment",
          description: "Validates, screens (risk + compliance), routes to the best eligible provider and processes the payment, failing over only when it is provably safe.",
          parameters: [idem],
          requestBody: { required: true, content: { "application/json": { schema: ref("PaymentCreate") } } },
          responses: { "201": ok({ type: "object", properties: { payment: ref("Payment") } }, "Payment created"), ...errors, "409": { $ref: "#/components/responses/Conflict" } },
        },
        get: {
          tags: ["Payments"],
          operationId: "listPayments",
          summary: "List payments",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { enum: [...TX_STATES] } },
            { name: "created_gte", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "created_lte", in: "query", schema: { type: "string", format: "date-time" } },
          ],
          responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: ref("Payment") }, has_more: { type: "boolean" }, next_cursor: { type: ["string", "null"] } } }), ...errors },
        },
      },
      "/payments/{id}": {
        get: {
          tags: ["Payments"],
          operationId: "getPayment",
          summary: "Retrieve a payment with routing explanation, attempt log and timeline",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok({ type: "object", properties: { payment: ref("Payment") } }), "404": { $ref: "#/components/responses/NotFound" }, ...errors },
        },
      },
      "/payments/{id}/refund": {
        post: {
          tags: ["Refunds"],
          operationId: "refundPayment",
          summary: "Refund a payment (full or partial)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, idem],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "integer", minimum: 1, description: "Omit for a full refund of the remaining amount." }, reason: { type: "string", maxLength: 500 } } } } } },
          responses: { "200": ok({ type: "object", properties: { refund: { type: "object" }, payment: ref("Payment") } }), "409": { $ref: "#/components/responses/Conflict" }, ...errors },
        },
      },
      "/routing/simulate": {
        post: {
          tags: ["Routing"],
          operationId: "simulateRouting",
          summary: "Dry-run the router: which provider would process this payment, and why",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["amount", "currency", "payment_method"], properties: { amount: { type: "integer" }, currency: { type: "string" }, payment_method: { enum: [...PAYMENT_METHODS] }, country: { type: "string" } } } } } },
          responses: { "200": ok({ type: "object" }), ...errors },
        },
      },
      "/providers": { get: { tags: ["Routing"], operationId: "listProviders", summary: "Provider capability registry", responses: { "200": ok({ type: "object" }), ...errors } } },
      "/fx/quotes": {
        post: {
          tags: ["FX"],
          operationId: "createFxQuote",
          summary: "Lock an exchange rate for 5 minutes",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["from", "to", "amount"], properties: { from: { type: "string" }, to: { type: "string" }, amount: { type: "integer" } } } } } },
          responses: { "201": ok({ type: "object" }), "503": { description: "No fresh rate available" }, ...errors },
        },
      },
      "/balance": { get: { tags: ["Balances & settlements"], operationId: "getBalance", summary: "Merchant balances from the ledger", responses: { "200": ok({ type: "object" }), ...errors } } },
      "/settlements": { get: { tags: ["Balances & settlements"], operationId: "listSettlements", summary: "Settlement batches", responses: { "200": ok({ type: "object" }), ...errors } } },
      "/payouts": {
        post: { tags: ["Payouts"], operationId: "createPayout", summary: "Pay out to a verified beneficiary", parameters: [idem], responses: { "201": ok({ type: "object" }), ...errors } },
        get: { tags: ["Payouts"], operationId: "listPayouts", summary: "List payouts", responses: { "200": ok({ type: "object" }), ...errors } },
      },
      "/customers": { get: { tags: ["Customers"], operationId: "listCustomers", summary: "Customers built from payment activity", responses: { "200": ok({ type: "object" }), ...errors } } },
      "/reference": { get: { tags: ["Reference"], operationId: "referenceData", security: [], summary: "ISO currencies, countries, methods and states", responses: { "200": ok({ type: "object" }) } } },
      "/health": { get: { tags: ["Reference"], operationId: "health", security: [], summary: "Liveness", responses: { "200": ok({ type: "object" }) } } },
    },
    webhooks: {
      paymentEvent: {
        post: {
          summary: "Event delivered to your endpoint",
          description:
            "Signed with your endpoint secret: header `X-USOPGRID-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + rawBody)>`. Reject if |now − t| > 300 s. De-duplicate on `X-USOPGRID-Event-Id`. Events: payment.successful, payment.pending, payment.requires_action, payment.declined, payment.failed, payment.expired, payment.refunded, refund.pending, refund.failed, payment.reconciliation_exception.",
          requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
          responses: { "200": { description: "Acknowledge with any 2xx within 10 s" } },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Secret API key: sk_sandbox_… or sk_live_…" } },
      responses: {
        AuthenticationError: { description: "Missing, invalid or revoked key", content: { "application/json": { schema: ref("Error") } } },
        ValidationError: { description: "Invalid request", content: { "application/json": { schema: ref("Error") } } },
        NotFound: { description: "Not found in this organization", content: { "application/json": { schema: ref("Error") } } },
        Conflict: { description: "Conflicting state (duplicate reference, request in progress, exceeds refundable)", content: { "application/json": { schema: ref("Error") } } },
        RateLimited: { description: "Too many requests — honour Retry-After", content: { "application/json": { schema: ref("Error") } } },
      },
      schemas: {
        PaymentCreate: {
          type: "object",
          required: ["amount", "currency", "payment_method"],
          properties: {
            amount: { type: "integer", minimum: 1, description: "Minor units, e.g. 1050 = 10.50 USD; 1500 = ¥1,500." },
            currency: { type: "string", pattern: "^[A-Z]{3}$" },
            payment_method: { enum: [...PAYMENT_METHODS] },
            country: { type: "string", pattern: "^[A-Z]{2}$", description: "Payer country; strongly recommended (routing + compliance)." },
            reference: { type: "string", maxLength: 120, description: "Your unique reference. Duplicates are rejected with 409." },
            customer: { type: "object", properties: { email: { type: "string", format: "email" }, name: { type: "string" }, phone: { type: "string", description: "E.164, required for mobile money." } } },
            payment_token: { type: "string", description: "Provider token from a hosted field / SDK. Raw card numbers are never accepted." },
            return_url: { type: "string", format: "uri" },
            description: { type: "string" },
            metadata: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "Up to 50 keys. In sandbox, `simulate` drives outcomes." },
          },
        },
        Payment: {
          type: "object",
          properties: {
            id: { type: "string" },
            object: { const: "payment" },
            reference: { type: "string" },
            status: { enum: [...TX_STATES] },
            amount: { type: "integer" },
            currency: { type: "string" },
            payment_method: { type: "string" },
            country: { type: ["string", "null"] },
            provider: { type: "string" },
            provider_reference: { type: ["string", "null"] },
            fee: { type: ["integer", "null"] },
            net: { type: ["integer", "null"] },
            refunded_amount: { type: "integer" },
            attempts: { type: "integer" },
            failovers: { type: "integer" },
            outcome_unknown: { type: "boolean", description: "True while USOPGRID is confirming an ambiguous provider response. Do not retry with a new reference." },
            next_action: { type: ["object", "null"] },
            failure: { type: ["object", "null"], properties: { category: { type: "string" }, code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" } } },
            created_at: { type: "string", format: "date-time" },
          },
        },
        WebhookEvent: {
          type: "object",
          properties: { id: { type: "string" }, event: { type: "string" }, created_at: { type: "string" }, livemode: { type: "boolean" }, data: ref("Payment") },
        },
        Error: {
          type: "object",
          properties: {
            status: { const: "error" },
            requestId: { type: "string" },
            error: {
              type: "object",
              properties: {
                code: { enum: ["authentication_error", "authorization_error", "validation_error", "conflict", "not_found", "idempotency_conflict", "provider_unavailable", "rate_limited", "processing_error"] },
                message: { type: "string" },
                retryable: { type: "boolean" },
                doc_url: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}
