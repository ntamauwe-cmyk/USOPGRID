import type { ReactNode } from "react";
import { Link } from "react-router";
import { SiteLayout, usePageMeta } from "./SiteLayout";
import { STATE_LABELS, TX_STATES } from "@/convex/orchestration/states";
import { SANDBOX_SIMULATION_KEYS, PAYMENT_METHODS, METHOD_LABELS } from "@/convex/providers/index";

const TOC = [
  ["getting-started", "Getting started"],
  ["authentication", "Authentication"],
  ["sandbox", "Sandbox"],
  ["payments", "Create a payment"],
  ["lifecycle", "Transaction lifecycle"],
  ["idempotency", "Idempotency"],
  ["webhooks", "Webhooks"],
  ["errors", "Errors"],
  ["refunds", "Refunds"],
  ["routing", "Routing"],
  ["fx", "FX quotes"],
  ["pagination", "Pagination & limits"],
  ["api-reference", "API reference"],
  ["sdks", "SDKs"],
  ["versioning", "Versioning"],
  ["security", "Security guidance"],
  ["troubleshooting", "Troubleshooting"],
] as const;

function Code({ children }: { children: ReactNode }) {
  return (
    <div className="ug-code">
      <pre><code>{children}</code></pre>
    </div>
  );
}

const STATE_DESC: Record<string, string> = {
  CREATED: "Recorded, not yet validated.",
  VALIDATED: "Passed validation, risk and compliance.",
  ACCEPTED: "A route exists; about to be sent.",
  PROCESSING: "Being sent to the provider chain.",
  PENDING: "Provider accepted it, or the outcome is being confirmed (see outcome_unknown), or the customer must act.",
  SUCCESSFUL: "Funds captured. Ledger posted.",
  FAILED: "Could not be processed. See failure.",
  DECLINED: "Refused by the issuer, risk or compliance.",
  CANCELLED: "Cancelled before completion.",
  EXPIRED: "Customer action was not completed in time.",
  REFUND_PENDING: "A refund is in progress.",
  PARTIALLY_REFUNDED: "Part of the amount has been refunded.",
  REFUNDED: "Fully refunded.",
  REVERSED: "Reversed, e.g. after a lost dispute.",
  DISPUTED: "A chargeback is open.",
  RECONCILIATION_EXCEPTION: "Provider and USOPGRID records disagree; finance is reviewing.",
};

const ERRORS: [string, number, string][] = [
  ["authentication_error", 401, "Missing, invalid, revoked or expired key."],
  ["authorization_error", 403, "The key or organization may not do this (publishable key, suspended org)."],
  ["validation_error", 422, "The request is malformed. The message names the field."],
  ["idempotency_conflict", 422, "Idempotency-Key reused with a different body."],
  ["not_found", 404, "No such object in your organization."],
  ["conflict", 409, "Duplicate reference, request already in progress, or amount exceeds what can be refunded."],
  ["rate_limited", 429, "Over 120 requests per minute for this key. Honour Retry-After."],
  ["provider_unavailable", 503, "No provider could take the request right now. Safe to retry with the same Idempotency-Key."],
  ["processing_error", 500, "Unexpected error. Safe to retry with the same Idempotency-Key; contact support with the request id."],
];

export default function Developers() {
  usePageMeta("Developers", "USOPGRID API documentation: authentication, payments, lifecycle, idempotency, webhooks, errors, sandbox and reference.");
  return (
    <SiteLayout>
      <section className="ug-dark ug-page-head">
        <div className="ug-wrap">
          <h1 className="ug-h1">Developer documentation</h1>
          <p className="ug-lede">Everything needed to take a first sandbox payment in minutes and run production traffic safely.</p>
          <div className="ug-actions" style={{ marginTop: 28 }}>
            <Link to="/auth" className="ug-btn ug-btn-gold">Get sandbox keys</Link>
            <a href="#api-reference" className="ug-btn ug-btn-ghost">API reference</a>
          </div>
        </div>
      </section>
      <section className="ug-section">
        <div className="ug-wrap ug-docs">
          <nav className="ug-toc" aria-label="Documentation">
            {TOC.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
          </nav>
          <article className="ug-doc">
            <section id="getting-started">
              <h2>Getting started</h2>
              <ol>
                <li>Sign in and open <strong>Developers</strong> in the dashboard. Create a sandbox secret key; it is shown once.</li>
                <li>Copy your API base URL from the same page. It looks like <code>https://&lt;deployment&gt;.convex.site/api/v1</code>, or <code>https://api.usopgrid.com/api/v1</code> on the hosted platform.</li>
                <li>Create a payment (below). In the sandbox it is routed to simulated rails and completes instantly.</li>
                <li>Add a webhook endpoint and verify signatures before going live.</li>
              </ol>
              <Code>{`export USOPGRID_API=https://<your-deployment>.convex.site/api/v1
export USOPGRID_SECRET_KEY=sk_sandbox_...

curl "$USOPGRID_API/health"`}</Code>
            </section>

            <section id="authentication">
              <h2>Authentication</h2>
              <p>Send your secret key as a bearer token. Keys are scoped to one organization and one environment, and are stored by USOPGRID only as SHA-256 hashes.</p>
              <Code>{`Authorization: Bearer sk_sandbox_9fK...   # sandbox
Authorization: Bearer sk_live_Q2m...      # production`}</Code>
              <ul>
                <li>Secret keys belong on your servers only. Publishable keys (<code>pk_…</code>) cannot authenticate API calls.</li>
                <li>Rotate a key from the dashboard: the old key keeps working for a grace period (24 hours by default) so you can roll deployments.</li>
                <li>Every response carries <code>X-USOPGRID-Request-Id</code>. Send your own <code>X-Request-Id</code> to correlate logs end to end.</li>
              </ul>
            </section>

            <section id="sandbox">
              <h2>Sandbox</h2>
              <p>Sandbox keys reach two simulated rails covering every country, currency and method. Control the outcome with <code>metadata.simulate</code>:</p>
              <table>
                <thead><tr><th>simulate</th><th>Result</th></tr></thead>
                <tbody>
                  {SANDBOX_SIMULATION_KEYS.map((k) => (
                    <tr key={k}>
                      <td><code>{k}</code></td>
                      <td>
                        {({
                          success: "SUCCESSFUL (default)",
                          pending: "PENDING, then SUCCESSFUL on the first status check",
                          requires_action: "PENDING with next_action.redirect",
                          issuer_decline: "DECLINED, issuer_decline",
                          insufficient_funds: "DECLINED, insufficient_funds",
                          fraud_rejection: "DECLINED, fraud_rejection",
                          invalid_payment_information: "DECLINED, invalid_payment_information",
                          customer_cancellation: "DECLINED, customer_cancellation",
                          timeout: "PENDING with outcome_unknown, recovery confirms SUCCESSFUL",
                          timeout_declined: "PENDING with outcome_unknown, recovery confirms DECLINED",
                          failover: "Primary rail down; succeeds on the backup rail (failovers: 1)",
                          provider_down: "Every rail down; FAILED, provider_outage",
                        } as Record<string, string>)[k] ?? k}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>Sandbox and production never mix: the key decides the environment, so a sandbox key can never reach live credentials.</p>
            </section>

            <section id="payments">
              <h2>Create a payment</h2>
              <p><code>POST /payments</code>. Amounts are integers in the currency's minor unit: <code>1050</code> USD is $10.50, <code>1500</code> JPY is ¥1,500, <code>1234</code> KWD is 1.234 KWD.</p>
              <Code>{`curl "$USOPGRID_API/payments" \\
  -H "Authorization: Bearer $USOPGRID_SECRET_KEY" \\
  -H "Idempotency-Key: order-7781" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 2500000,
    "currency": "NGN",
    "payment_method": "card",
    "country": "NG",
    "reference": "order-7781",
    "customer": { "email": "ada@example.com", "name": "Ada Obi" },
    "payment_token": "<token from the provider's hosted fields>",
    "return_url": "https://shop.example/return",
    "metadata": { "cart_id": "c_19" }
  }'`}</Code>
              <table>
                <thead><tr><th>Field</th><th>Notes</th></tr></thead>
                <tbody>
                  <tr><td><code>payment_method</code></td><td>{PAYMENT_METHODS.map((m) => METHOD_LABELS[m]).join(", ")}.</td></tr>
                  <tr><td><code>country</code></td><td>Payer country, ISO 3166-1 alpha-2. Strongly recommended: it drives routing and compliance screening.</td></tr>
                  <tr><td><code>reference</code></td><td>Your unique id, up to 120 characters. A duplicate returns 409.</td></tr>
                  <tr><td><code>customer.phone</code></td><td>E.164 format. Required for mobile money (e.g. M-Pesa STK push).</td></tr>
                  <tr><td><code>payment_token</code></td><td>A provider token from hosted fields or an SDK. Raw card numbers are never accepted.</td></tr>
                </tbody>
              </table>
              <p>The response contains the payment with <code>status</code>, <code>provider</code>, <code>attempts</code>, <code>failovers</code>, <code>fee</code>, <code>net</code>, <code>next_action</code> and <code>failure</code>. <code>GET /payments/:id</code> adds the routing explanation, attempt log, refunds and timeline.</p>
            </section>

            <section id="lifecycle">
              <h2>Transaction lifecycle</h2>
              <p>States only move along allowed transitions; duplicate or out-of-order provider events are recorded but never applied.</p>
              <table>
                <thead><tr><th>State</th><th>Meaning</th></tr></thead>
                <tbody>{TX_STATES.map((s) => <tr key={s}><td><code>{s}</code><div style={{ fontSize: 13, color: "var(--ink-3)" }}>{STATE_LABELS[s]}</div></td><td>{STATE_DESC[s]}</td></tr>)}</tbody>
              </table>
              <div className="ug-callout">
                When <code>outcome_unknown</code> is true the provider did not give a clear answer. Do not create a new payment for the same order. USOPGRID asks that provider for the result (15 s, 1 min, 5 min, 15 min, 1 h, 3 h, 12 h) and sends a webhook when it resolves. Unresolved after 72 hours, it becomes a reconciliation exception.
              </div>
            </section>

            <section id="idempotency">
              <h2>Idempotency</h2>
              <p>Send <code>Idempotency-Key</code> on every POST. Use one key per business operation (for example the order id plus attempt number).</p>
              <ul>
                <li>Same key, same body: the original response is replayed, even if the first call is still processing elsewhere (you receive 409 <code>conflict</code> while it is in flight).</li>
                <li>Same key, different body: 422 <code>idempotency_conflict</code>.</li>
                <li>Keys are retained for 24 hours. A failed request releases its key so you can retry.</li>
                <li>Downstream, USOPGRID sends its own stable idempotency key to each provider, so a retry can never charge twice at the provider.</li>
              </ul>
            </section>

            <section id="webhooks">
              <h2>Webhooks</h2>
              <p>Register endpoints in the dashboard and choose events. Each delivery is a POST with these headers:</p>
              <Code>{`X-USOPGRID-Signature: t=1761742800,v1=5f0c...e91
X-USOPGRID-Event: payment.successful
X-USOPGRID-Event-Id: evt_8Jd...      # de-duplicate on this
X-USOPGRID-Delivery-Attempt: 1`}</Code>
              <p>Events: <code>payment.successful</code>, <code>payment.pending</code>, <code>payment.requires_action</code>, <code>payment.declined</code>, <code>payment.failed</code>, <code>payment.expired</code>, <code>payment.refunded</code>, <code>refund.pending</code>, <code>refund.failed</code>, <code>payment.reconciliation_exception</code>, or <code>*</code> for all.</p>
              <h3>Verify the signature</h3>
              <Code>{`// Node.js
import crypto from "node:crypto";

export function verify(rawBody, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1 ?? ""));
}`}</Code>
              <Code>{`# Python
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str, tolerance=300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > tolerance:
        return False
    signed = parts["t"].encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`}</Code>
              <ul>
                <li>Use the raw request body, before any JSON parsing.</li>
                <li>Respond 2xx within 10 seconds, then do the work asynchronously.</li>
                <li>Failed deliveries retry after 30 s, 2 min, 10 min, 30 min, 2 h and 6 h, then move to a dead-letter queue you can replay from the dashboard.</li>
                <li>Events can arrive more than once and out of order. De-duplicate on the event id and read <code>data.status</code>.</li>
              </ul>
            </section>

            <section id="errors">
              <h2>Errors</h2>
              <Code>{`{
  "status": "error",
  "requestId": "req_7c1e...",
  "error": {
    "code": "validation_error",
    "message": "currency must be a 3-letter ISO 4217 code.",
    "retryable": false,
    "doc_url": "https://usopgrid.com/developers#errors-validation_error"
  }
}`}</Code>
              <table>
                <thead><tr><th>Code</th><th>HTTP</th><th>Meaning</th></tr></thead>
                <tbody>{ERRORS.map(([c, h, m]) => <tr key={c} id={`errors-${c}`}><td><code>{c}</code></td><td>{h}</td><td>{m}</td></tr>)}</tbody>
              </table>
              <p>Payment-level failures (declines, provider outages) are not HTTP errors: the payment is created and its <code>failure</code> object has a <code>category</code>, <code>code</code>, <code>message</code> and <code>retryable</code> flag.</p>
            </section>

            <section id="refunds">
              <h2>Refunds</h2>
              <Code>{`curl -X POST "$USOPGRID_API/payments/txn_m2x9.../refund" \\
  -H "Authorization: Bearer $USOPGRID_SECRET_KEY" \\
  -H "Idempotency-Key: refund-order-7781-1" \\
  -d '{ "amount": 500000, "reason": "Item returned" }'   # omit amount for the full remainder`}</Code>
              <p>Refunds go back through the provider that took the payment. Concurrent refunds can never exceed the captured amount. If the provider's answer is unclear the payment stays <code>REFUND_PENDING</code> until its webhook confirms the result.</p>
            </section>

            <section id="routing">
              <h2>Routing</h2>
              <p>Ask the router what it would do, with your live configuration, without moving money:</p>
              <Code>{`curl -X POST "$USOPGRID_API/routing/simulate" \\
  -H "Authorization: Bearer $USOPGRID_SECRET_KEY" \\
  -d '{ "amount": 100000, "currency": "KES", "payment_method": "mobile_money", "country": "KE" }'`}</Code>
              <p><code>GET /providers</code> lists every provider's countries, currencies, methods and supported operations. Configure rules, weights and provider priorities in the dashboard under Routing.</p>
            </section>

            <section id="fx">
              <h2>FX quotes</h2>
              <Code>{`curl -X POST "$USOPGRID_API/fx/quotes" -H "Authorization: Bearer $USOPGRID_SECRET_KEY" \\
  -d '{ "from": "USD", "to": "NGN", "amount": 10000 }'
# → { "quote": { "id": "fxq_...", "target_amount": 15149475, "rate": "1514.9475",
#      "mid_rate": "1530.25", "spread_bps": 100, "expires_at": "..." } }`}</Code>
              <p>Rates are exact decimals; conversion uses rational arithmetic with half-even rounding. Quotes expire after 5 minutes and are refused if the underlying rates are more than 36 hours old.</p>
            </section>

            <section id="pagination">
              <h2>Pagination and limits</h2>
              <p>List endpoints accept <code>limit</code> (1 to 100) and return <code>next_cursor</code>; pass it back as <code>cursor</code>. <code>GET /payments</code> also filters by <code>status</code>, <code>created_gte</code> and <code>created_lte</code>.</p>
              <p>Each key may make 120 requests per minute. Exceeding it returns 429 with <code>Retry-After</code>.</p>
            </section>

            <section id="api-reference">
              <h2>API reference</h2>
              <p>The complete OpenAPI 3.1 specification is served at <code>GET /api/v1/openapi.json</code>; import it into Postman, Insomnia or a code generator.</p>
              <table>
                <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
                <tbody>
                  {[
                    ["POST", "/payments", "Create and process a payment"],
                    ["GET", "/payments", "List payments"],
                    ["GET", "/payments/:id", "Retrieve with routing, attempts and timeline"],
                    ["POST", "/payments/:id/refund", "Full or partial refund"],
                    ["POST", "/routing/simulate", "Dry-run the router"],
                    ["GET", "/providers", "Provider capability registry"],
                    ["POST", "/fx/quotes", "Lock an exchange rate"],
                    ["GET", "/balance", "Ledger balances"],
                    ["GET", "/settlements", "Settlement batches"],
                    ["POST", "/payouts", "Pay out to a beneficiary"],
                    ["GET", "/payouts", "List payouts"],
                    ["GET", "/customers", "Customers"],
                    ["GET", "/reference", "Currencies, countries, methods, states (public)"],
                    ["GET", "/health", "Liveness (public)"],
                  ].map(([m, p, d]) => <tr key={m + p}><td><code>{m}</code></td><td><code>{p}</code></td><td>{d}</td></tr>)}
                </tbody>
              </table>
            </section>

            <section id="sdks">
              <h2>SDKs</h2>
              <p>The API is plain JSON over HTTPS, so no SDK is required. The repository ships a typed TypeScript client in <code>sdk/typescript</code> with automatic idempotency keys, retries with backoff for retryable errors, and a webhook verifier. Generate clients for other languages from the OpenAPI specification.</p>
              <Code>{`import { Usopgrid } from "./sdk/typescript/usopgrid";

const ug = new Usopgrid({ apiKey: process.env.USOPGRID_SECRET_KEY!, baseUrl: process.env.USOPGRID_API! });
const payment = await ug.payments.create({ amount: 2500000, currency: "NGN", payment_method: "card", country: "NG", reference: "order-7781" });`}</Code>
            </section>

            <section id="versioning">
              <h2>Versioning</h2>
              <p>The path version (<code>/api/v1</code>) changes only for breaking changes. Each response carries a dated <code>USOPGRID-Version</code> header. Additive changes (new fields, events, enum values) can appear at any time, so ignore fields you do not recognise.</p>
            </section>

            <section id="security">
              <h2>Security guidance</h2>
              <ul>
                <li>Keep secret keys in a secrets manager; never in client apps or repositories. Rotate them on staff changes.</li>
                <li>Collect card details only through your provider's hosted fields or SDK, so card data never touches your servers or USOPGRID.</li>
                <li>Verify every webhook signature and reject timestamps older than five minutes.</li>
                <li>Enable MFA for every dashboard user; owners can require it for sensitive actions.</li>
                <li>Use separate sandbox and production keys per service so a leak can be revoked narrowly.</li>
              </ul>
            </section>

            <section id="troubleshooting">
              <h2>Troubleshooting</h2>
              <table>
                <thead><tr><th>Symptom</th><th>Cause and fix</th></tr></thead>
                <tbody>
                  <tr><td>FAILED with <code>no_route</code></td><td>No connected provider covers that country, currency and method. Check <code>/routing/simulate</code> for each provider's reason and connect one that does.</td></tr>
                  <tr><td>Stuck in PENDING</td><td>Either the customer must act (<code>next_action</code>) or the outcome is being confirmed (<code>outcome_unknown</code>). Wait for the webhook; do not retry with a new reference.</td></tr>
                  <tr><td>DECLINED with <code>compliance_review_required</code></td><td>The payer country is on the review list. Contact support to arrange a manual review.</td></tr>
                  <tr><td>401 after rotating a key</td><td>The old key's grace period ended. Deploy the new key.</td></tr>
                  <tr><td>Webhook signature mismatch</td><td>You are signing the parsed and re-serialized body. Use the raw bytes exactly as received.</td></tr>
                  <tr><td>Amount rejected for KES or IDR</td><td>Some providers require whole units in these currencies; send multiples of 100 minor units.</td></tr>
                </tbody>
              </table>
            </section>
          </article>
        </div>
      </section>
    </SiteLayout>
  );
}
