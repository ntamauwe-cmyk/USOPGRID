# RAEVOLT — Production-Readiness Audit Report

**Project:** RAEVOLT Payment Infrastructure (standalone project by RAE Technologies Limited)
**Scope of audit:** Full codebase, backend (Convex), public API v1, dashboard, ledger, auth/RBAC, webhooks, security posture.
**Audit method:** Static review + executed tests against the running deployment (unit tests, live API regression suite, ledger conservation audit). Nothing in this report is based on inspection alone.

---

## CURRENT STATUS

**TECHNICALLY VERIFIED PRODUCTION CANDIDATE — NOT YET LIVE.**

All financial flows run on the built-in **sandbox adapter**. No live payment rail is connected. No real money has been processed. No regulatory approval is claimed or implied.

---

## Issues found and fixed during the audit

| # | Severity | Issue | Fix | Verified by |
|---|---|---|---|---|
| 1 | Critical | Rate limiter caused sporadic **500** errors under concurrent load (read-then-write split across functions caused optimistic-concurrency conflict storms) | Rebuilt as a single atomic `consumeRateLimitInternal` mutation (check + increment + `lastUsedAt` in one pass); limiter fails **open** on internal errors so genuine traffic is never 500'd by limiter infra | 130-request burst: **429s returned, zero 500s** |
| 2 | Critical | **Idempotent replay was broken** for requests without a client reference: the server injected a randomly generated reference *before* fingerprinting, so identical retries always produced different fingerprints | Fingerprint now covers client-supplied fields only | Same key + same body → exact replay (same `txn_` id); same key + different body → `422 idempotency_conflict` |
| 3 | Critical | **Refunds and payouts were not idempotent** — a network retry could double-refund or duplicate a payout | Shared `withIdempotency` runner across financial mutation paths | Refund replay with same key returned the original response; no second refund posted |
| 4 | High | Customer **lifetime volume mixed currencies** into one scalar (NGN + USD summed as raw minor units — a financial misstatement) | Volume tracked per currency (`lifetimeVolumeByCurrency`); API + dashboard updated | API returns per-currency map |
| 5 | High | **No risk engine existed** (spec gap) | Deterministic rules engine (`src/convex/lib/risk.ts`): amount thresholds, customer velocity, failed-payment velocity, org burst, disposable-email and missing-email signals; decisions ALLOW / REVIEW / HOLD / BLOCK with explainable reasons; enforced in the payment path before any provider call | Live: ₦1,500 → ALLOW/`SUCCESSFUL`; ₦250,000 → HOLD → `FAILED` with `risk_blocked`, score and reasons recorded; **no ledger entries posted for blocked payments** |
| 6 | High | **Unauthenticated bootstrap mutation** (`verifyBootstrap.ts`) left in backend — any caller could mint an org + secret key | File deleted; deployment re-verified | File absent; `bunx convex dev --once` clean |
| 7 | Medium | `.gitignore` did not cover bare `.env` | Added | `.env` and `.env.local` ignored |

---

## Verified capabilities (executed, not assumed)

| Capability | Result |
|---|---|
| `GET /api/v1/health` | ✅ 200, structured envelope |
| Payment creation | ✅ `SUCCESSFUL`, correct fee math (integer minor units) |
| Payment retrieval / status consistency | ✅ |
| Refunds, partial refunds | ✅ `PARTIALLY_REFUNDED` with correct cumulative `refundedMinor` |
| Over-refund rejection | ✅ `conflict` (cannot exceed refundable remainder) |
| Customer auto-creation and listing | ✅ |
| Settlements endpoints | ✅ 200 |
| Structured 404 / validation errors | ✅ `not_found`, `validation_error` with request IDs |
| API-key authentication | ✅ 401 for missing/invalid keys; publishable keys rejected for server auth |
| Rate limiting | ✅ 120 req/min/key → 429, atomic, zero 500s |
| Risk engine | ✅ ALLOW/HOLD/BLOCK enforced live, reasons recorded |
| Payment idempotency | ✅ exact replay; conflict on payload mismatch |
| Refund idempotency | ✅ replay, never double-refund |
| Payout idempotency | ✅ same runner |
| **Double-entry ledger integrity** | ✅ **37 entries / 14 posting groups / 0 unbalanced** across payments, refunds, payouts, chargebacks, settlements |
| Multi-currency accounting | ✅ per-currency conservation; balances per currency |
| Webhook HMAC verification | ✅ HMAC-SHA256 over `"<ts>.<payload>"`, constant-time comparison |
| Integer minor-unit money handling | ✅ no floats in financial math; fee rounding deterministic half-up |
| Server-side secret protection | ✅ keys stored SHA-256-hashed, shown once; secret scan clean |

---

## Test results (final run)

- **Unit tests:** `bun test src/tests/` — **36 passed, 0 failed** (money formatting, crypto incl. RFC 4231 HMAC vector, API-key shape, idempotency canonicalization, fee engine rounding + currency normalization, risk decision bands)
- **TypeScript:** `bunx tsc -b --noEmit` — **0 errors**
- **Convex deploy:** `bunx convex dev --once` — clean push, functions ready
- **Live API regression:** 13-point suite (see table above) — all passed
- **Secret scan:** no API keys, tokens, passwords, or private keys in source
- **Ledger conservation audit:** 0 unbalanced posting groups

---

## Remaining external dependencies (explicitly NOT satisfied)

1. **Live payment-rail credentials** — Paystack/Flutterwave (or other) adapter code is architected (`PaymentProviderAdapter` interface + sandbox adapter), but no live credentials exist and none were invented.
2. **Real provider integration testing** — requires a provider sandbox/live account.
3. **Real bank statement/transaction feed** — current bank records in reconciliation are a simulated feed.
4. **Production reconciliation testing** — depends on the above.
5. **Regulatory/licensing requirements** — none obtained or claimed. RAEVOLT makes no licensing, CBN, NIBSS, card-network membership, or PCI DSS claims. Compliance remains the responsibility of the operating entity's legal review.
6. **Production infrastructure validation** — load, failover, and disaster-recovery testing on production infrastructure.
7. **Controlled production rollout** — staged launch with monitoring has not occurred.

---

## Security posture summary

- No secrets, keys, or credentials in source control (scan verified).
- Secret keys: generated once, shown once, SHA-256 hashed at rest, prefixed for display.
- All consequential actions audit-logged (actor, action, resource, before/after, request ID).
- CORS `*` is intentional and safe for bearer-token APIs (no cookies → no CSRF surface; wildcard cannot be combined with credentialed requests).
- No card data stored; card-data boundary designed around provider-hosted collection/tokenization.
- Sandbox and production separated at the key, environment, and adapter levels.
