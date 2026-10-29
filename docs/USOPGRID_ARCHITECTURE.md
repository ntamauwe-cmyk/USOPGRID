# USOPGRID Architecture

**USOPGRID — Powering Every Payment Connection.**
Enterprise payment infrastructure by RAE Horizon Technologies Limited.

## 1. Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | React 19, Vite 7, Tailwind 4, shadcn/Radix, Recharts | Existing stack; kept. |
| Public website | React + a standalone stylesheet (`src/site/site.css`) | Framework-independent, renders identically everywhere, previewable without the app shell. |
| Backend | Convex (queries, mutations, actions, HTTP actions, crons) | Existing stack. Serializable (OCC) transactions for money, reactive queries for dashboards, scheduled jobs. |
| Auth | `@convex-dev/auth` (email OTP + anonymous sandbox) + USOPGRID TOTP MFA | Existing; MFA added. |
| Crypto | Web Crypto only (SHA-2, HMAC, AES-256-GCM, CSPRNG) | No hand-rolled primitives; runs in Convex V8, browsers, Bun, Node. |

No new npm dependencies were added.

## 2. System view

```
 Merchant apps ── REST /api/v1 ──┐        Dashboard (React) ── Convex queries/mutations
                                  ▼                │
                     ┌────────── USOPGRID API (http.ts / api.ts) ─────────┐
                     │ auth (hashed keys) · rate limit · idempotency ·     │
                     │ correlation ids · usage metering · error envelope   │
                     └──────────────────────┬──────────────────────────────┘
                                            ▼
          payments.ts  processPaymentInternal (Convex action)
          1 validate → 2 create (CREATED) → 3 risk + compliance (VALIDATED|DECLINED)
          4 route (router.ts, explained, saved) → ACCEPTED → PROCESSING
          5 executeChain (engine.ts) over provider adapters with circuit gates
          6 apply outcome via state machine (states.ts) → ledger, webhooks, recovery
                                            │
           ┌──────────────┬─────────────────┼───────────────────┬────────────────┐
           ▼              ▼                 ▼                   ▼                ▼
   providers/*.ts   connections.ts     lib/ledger.ts       webhooks.ts      recovery.ts
   12 adapters      credentials,       double-entry,       signed outbound  unknown-outcome
   (1 contract)     circuits, health   immutable           + dead letters   resolution (cron)
           ▲
   providerWebhooks.ts  ← signed inbound provider events (verified, de-duplicated, state-machined)
```

## 3. Core modules

| Module | Responsibility | Pure? |
|---|---|---|
| `orchestration/states.ts` | 16-state transition table; `resolveProviderOutcome` (apply / noop / stale / exception) | yes |
| `orchestration/router.ts` | Eligibility, rules (prefer/exclude/only), scoring (smoothed success, cost incl. caps, latency, priority), explanation | yes |
| `orchestration/engine.ts` | Charge chain executor: failover rules, idempotency keys per connection, circuit outcomes | yes |
| `orchestration/circuit.ts` | Closed → open → half-open breaker with doubling cooldown | yes |
| `orchestration/retry.ts` | Full-jitter backoff; recovery schedule (15 s … 12 h, 72 h deadline) | yes |
| `orchestration/compliance.ts` | Jurisdiction policy + OpenSanctions watchlist screening | yes (+fetch) |
| `providers/*` | Adapter contract + 12 adapters (2 sandbox rails, Stripe, Adyen, Checkout.com, dLocal, Paystack, Flutterwave, M-Pesa, Razorpay, Mercado Pago, Xendit) | yes (+fetch) |
| `lib/fx.ts` | Exact rational FX, spreads, quotes, cross rates, snapshot merge | yes |
| `lib/fees.ts` | Merchant fee engine (never reinterprets foreign fixed fees) | yes |
| `lib/risk.ts` | Explainable rules engine on USD-normalized amounts | yes |
| `lib/recon.ts` | RFC 4180 CSV parsing, settlement report matching, typed findings | yes |
| `lib/analytics.ts` | Metric definitions, provider ranking, anomaly z-score, forecast, safe CSV | yes |
| `lib/openapi.ts` | OpenAPI 3.1 spec generated from the live registries | yes |
| `payments.ts` | Orchestration action, finalizers (success/failure/exception), refunds | Convex |
| `connections.ts` | Routing context, sealed-credential resolution, circuit gate, attempt telemetry, notifications | Convex |
| `recovery.ts`, `providerWebhooks.ts`, `fxrates.ts`, `analytics.ts`, `reconciliation.ts`, `routing.ts`, `providers.ts`, `security.ts`, `ops.ts`, `notifications.ts`, `contact.ts` | Feature modules | Convex |

Every pure module is unit-tested with Bun (`src/tests`).

## 4. Data model (Convex tables)

Existing: organizations, orgMembers, merchants, apiKeys, transactions, transactionEvents, ledgerAccounts, ledgerEntries, idempotencyKeys, settlementBatches, bankRecords, reconExceptions, webhookEndpoints, webhookDeliveries, auditLogs, customers, paymentLinks, beneficiaries, payouts, disputes, disputeEvents, providerHealth, githubConnections.

Added: providerConnections, routingRules, routingDecisions, paymentAttempts, circuitStates, providerEvents, recoveryJobs, refunds, fxRateSnapshots, fxQuotes, reconRuns, userMfa, featureFlags, apiUsage, notifications, orgInvitations, contactRequests.

`transactions` gained: country, connectionId, attemptCount, failoverCount, outcomeUnknown, nextAction, providerFeeMinor, complianceDecision, fx, customerPhone, and indexes `by_provider_reference`, `by_status_updated`, `by_org_env_created`. Existing records remain valid (all new fields optional; status union is a superset).

## 5. Key invariants

1. **Money is integer minor units** with the correct ISO 4217 exponent for all 155 active currencies (JPY 0, KWD 3, …).
2. **One instruction, one charge.** Provider idempotency key = `transactionId:connectionId`. Ambiguous outcomes (timeout, transport, 5xx) are never failed over; they enter the recovery queue.
3. **State only moves forward** through `canTransition`; contradictory provider reports raise reconciliation exceptions.
4. **Ledger postings only on confirmed outcomes**; balanced, immutable; corrections are new postings.
5. **Tenant from credentials**: org resolved from session or API key; inbound provider events are rejected if they reference another org's payment.
6. **Environment isolation**: sandbox rails unreachable in production; platform env credentials are environment-suffixed.
7. **Explainability**: every routing decision is stored with each candidate's verdict and score.

## 6. Routing algorithm

```
eligible = candidates where enabled ∧ envelope(country,currency,method,limits) ∧ circuit available
                       ∧ not excluded by rule ∧ (no "only" rule ∨ in its set)
score    = w_s·successSmoothed + w_c·(1 − min(feeRate, 8%)/8%) + w_l·(1 − min(latency,10s)/10s)
           + 0.05·priority/100 + 0.25·[preferred by rule]
successSmoothed = (successes + 0.85·20)/(attempts + 20)    (14-day provider history)
chain    = top N by score (N = strategy.maxAttempts, default 3)
```
Weights default to success 0.60 / cost 0.25 / latency 0.15 and are configurable per organization.

## 7. Scheduled jobs (`crons.ts`)

| Job | Interval |
|---|---|
| Outbound webhook dispatch | 1 min |
| Recovery queue (unknown/pending outcomes, action expiry) | 1 min |
| FX rate refresh | 1 h |
| Idempotency key purge | 1 h |
| Provider anomaly detection | 15 min |
