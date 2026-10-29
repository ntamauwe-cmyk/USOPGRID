# RAEVOLT — Production Checklist

Tick an item only when it is genuinely true. This checklist is the gate between
"technically verified production candidate" and "live."

---

## A. Application (current state: ✅ done and verified)

- [x] Builds and typechecks clean (`bunx tsc -b --noEmit` → 0 errors)
- [x] Unit tests pass (`bun test src/tests/` → 36/36)
- [x] Convex functions deploy clean (`bunx convex dev --once`)
- [x] Public API v1 regression suite passes (health, payments, refunds, customers, settlements, errors)
- [x] Payment lifecycle states recorded with full event timeline
- [x] Failure intelligence on every failed payment (category, code, retry guidance)
- [x] Idempotency: payments, refunds, payouts (replay verified; conflict on payload mismatch)
- [x] Double-entry ledger: conservation audit passed (0 unbalanced posting groups)
- [x] Multi-currency: per-currency balances, per-currency customer volume, per-currency fee normalization
- [x] Risk engine enforced pre-provider (ALLOW/REVIEW/HOLD/BLOCK, explainable reasons)
- [x] Rate limiting: atomic, 429 responses verified under burst
- [x] RBAC permission checks on dashboard mutations and queries
- [x] Multi-tenant data isolation on every org-scoped query
- [x] Webhook signing (HMAC-SHA256), retries with backoff, dead-letter + replay
- [x] API keys: hashed at rest, shown once, sandbox/production separation
- [x] Audit log for consequential actions
- [x] Structured error envelopes with request IDs; no stack traces exposed

## B. Security (current state: ✅ verified at code level)

- [x] Secret scan clean (no keys/tokens/passwords in source)
- [x] `.gitignore` covers `.env` and `.env.local`
- [x] Secret keys never logged; stored SHA-256-hashed
- [x] Webhook signature verification uses constant-time comparison
- [x] Input validation server-side on every API endpoint
- [x] No card data stored; tokenization boundary documented
- [ ] Third-party security review / penetration test
- [ ] Dependency vulnerability audit in CI (e.g., `bun audit` on a schedule)

## C. Live payment rails (current state: ❌ not connected)

- [ ] Provider chosen (e.g., Paystack, Flutterwave) and account approved
- [ ] `PaymentProviderAdapter` implemented for the chosen rail (interface exists)
- [ ] Credentials stored in platform secrets (env var names listed in README; never in git)
- [ ] Full lifecycle tested against provider **sandbox**: success, decline, timeout, refund, webhook receipt + signature verification
- [ ] Webhook endpoint registered with provider; replay protection verified
- [ ] Provider settlement reports reconcile against RAEVOLT ledger
- [ ] Live-mode smoke test with controlled real transactions

## D. Bank reconciliation (current state: ❌ simulated feed)

- [ ] Real bank statement / transaction feed available
- [ ] Feed ingestion implemented and scheduled
- [ ] Reconciliation exceptions workflow exercised on real data
- [ ] Settlement confirmed from bank records, not provider API responses alone

## E. Compliance & legal (current state: ❌ none obtained or claimed)

- [ ] Legal review of the final RAEVOLT business model completed
- [ ] Applicable licensing identified and obtained for target markets
- [ ] KYC/KYB workflow connected to a verification provider where required
- [ ] Sanctions screening where required
- [ ] Terms of service, privacy policy, and merchant agreements published
- [ ] PCI DSS scope assessment (required only if card data ever enters RAEVOLT systems; current design avoids it)

## F. Production infrastructure (current state: ❌ not validated)

- [ ] Production deployment environment separated from dev/sandbox
- [ ] Managed database with backups + tested restore
- [ ] Monitoring and alerting (error rates, provider latency, webhook failures, queue depth)
- [ ] Load testing at expected peak volume
- [ ] Failover drills (provider outage simulation, region/instance failure)
- [ ] Incident runbooks and on-call rotation
- [ ] Structured logs retained and queryable

## G. Controlled rollout (current state: ❌ not started)

- [ ] Invite-only initial merchant cohort
- [ ] Volume caps during early operation
- [ ] Daily reconciliation sign-off during rollout
- [ ] Rollback plan rehearsed
- [ ] Go/no-go criteria documented and met

---

**Do not check items in C–G on optimism. Each requires real external evidence.**
