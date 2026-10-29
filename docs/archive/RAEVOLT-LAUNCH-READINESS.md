# RAEVOLT — Launch Readiness Report

**RAEVOLT Payment Infrastructure by RAE Technologies Limited**
Standalone project. Not affiliated with, and not sharing code, data, credentials, or infrastructure with RAE Pay, RAE Wallet, RAE Mind AI, Heyra, or BIGWINZ BET.

---

## CURRENT STATUS

**TECHNICALLY VERIFIED PRODUCTION CANDIDATE — NOT YET LIVE.**

What this means, precisely:

- The application builds, deploys, typechecks, and passes its test suite.
- The full financial core (payments, refunds, settlements, double-entry ledger, idempotency, risk controls) has been **executed and verified** against the running deployment — not merely inspected.
- **No live payment rail is connected.** All money movement runs on the built-in sandbox adapter.
- **No real money has been processed.**
- **No regulatory approval has been obtained or is claimed.**

---

## What is verified and working (sandbox environment)

| Area | State |
|---|---|
| Public API v1 (`/api/v1/*`) | Versioned, bearer-key auth, structured envelopes, request IDs |
| Payment lifecycle | CREATED → PROCESSING → SUCCESSFUL / FAILED with full event timeline |
| Failure intelligence | Category, code, message, retry guidance on every failure |
| Refunds | Full + partial, over-refund rejection, cumulative refund tracking |
| Idempotency | Payments, refunds, payouts: exact replay on retry, conflict on payload mismatch |
| Double-entry ledger | Immutable entries, posting-group conservation verified (0 unbalanced) |
| Settlements | Ledger-balance batch model, settle + reconcile cycle |
| Risk engine | Deterministic rules, ALLOW/REVIEW/HOLD/BLOCK, enforced pre-provider |
| Webhooks | Signed (HMAC-SHA256), exponential backoff retries, dead-letter + replay |
| API keys | sk_/pk_ formats, shown once, SHA-256 at rest, env separation |
| Rate limiting | 120 req/min/key, atomic, 429 responses |
| RBAC | Permission-level checks: owner/admin/finance/developer/operations/viewer |
| Multi-tenancy | Org-scoped data isolation on every query |
| Dashboard | Overview, Transactions, Transaction 360, Settlements, Customers, Payment Links, Payouts, Disputes, Developers, Webhooks, Team, Audit |
| Hosted checkout | `/pay/:linkId` public payment page wired to the same engine |

---

## What is NOT yet true (do not assume otherwise)

| Item | Status |
|---|---|
| Live Paystack / Flutterwave / bank connectivity | **Not connected.** Adapter interface exists; no credentials configured. |
| Real money processing | **Never occurred.** |
| Real bank statement feed for reconciliation | **Simulated feed only.** |
| Production reconciliation testing | **Not performed** (depends on real feed). |
| Regulatory / licensing approvals | **Not obtained, not claimed.** Requires legal review of the final business model. |
| PCI DSS certification | **Not obtained, not claimed.** Card-data boundary designed for future compliance. |
| Production load / failover validation | **Not performed.** |
| Controlled production rollout | **Not started.** |

---

## Path to live (ordered)

1. **Provider credentials** — obtain sandbox-then-live credentials from chosen rails; implement adapters behind the existing `PaymentProviderAdapter` interface; set env vars only when adapter code exists (see README checklist).
2. **Provider integration testing** — full lifecycle against provider sandbox: success, decline, timeout, refund, webhook receipt + signature verification, reconciliation.
3. **Bank feed ingestion** — replace simulated feed with real statement import; re-run reconciliation suite.
4. **Compliance review** — KYC/KYB workflows, licensing requirements for target markets, sanctions screening where applicable.
5. **Production infrastructure validation** — load tests, failover drills, backup/restore, monitoring and alerting.
6. **Controlled rollout** — invite-only merchants, shadow-mode reconciliation, gradual traffic increase, incident runbooks.

---

## Verification commands

```bash
bun test src/tests/          # 36 unit tests
bunx tsc -b --noEmit         # typecheck (0 errors)
bunx convex dev --once       # deploy backend functions
bun run dev                  # frontend (platform-managed)
```
