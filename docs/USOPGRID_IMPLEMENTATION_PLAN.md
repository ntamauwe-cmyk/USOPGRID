# USOPGRID Implementation Plan and Status

Last updated: 29 October 2026. Legend: **Done** = implemented and verified in
this repository; **Partial** = implemented, needs an external dependency to
verify end to end; **Planned** = not implemented.

## Baseline found (RAEVOLT v1)

Convex + React app with a payments engine wired to a single sandbox adapter
(`selectProvider`), double-entry ledger, idempotency, settlements and bank
reconciliation, signed webhooks, payouts, disputes, payment links, customers,
API keys and 6-role RBAC. Defects found and fixed in this pass:

| Defect | Impact | Fix |
|---|---|---|
| Overview summed amounts across currencies and never counted successes (success rate always 0%) | Wrong numbers on the main dashboard | Rewritten on shared analytics definitions, per currency |
| Fixed fee in another currency rescaled by decimals, not converted (USD 0.50 charged as ₦0.50) | Fee misstatement | Fee engine never reinterprets foreign fixed fees; flags them for FX conversion |
| Risk amount thresholds in raw minor units of any currency | ₦50,000 (≈$30) and $50,000 scored alike | Scored on USD-equivalent from the FX engine |
| Dashboard amounts converted with ×100 | Wrong for JPY (0 decimals), KWD (3) | Exact `decimalToMinor` per currency |
| Payment-link checkout hard-coded to sandbox | Live links could never take real payments | Uses the organization's environment |
| `@vly-ai/integrations` removed from dependencies while still imported | Build failure | Restored |
| Sidebar hidden on phones with no alternative | Dashboard unusable on mobile | Mobile navigation drawer |

## Stage status

| Stage | Status | Evidence |
|---|---|---|
| 1 Discovery | Done | This table; `docs/archive/` keeps RAEVOLT-era reports |
| 2 Rebranding | Done | Logo/mark/favicon/OG image/wordmark, theme, fonts, website, app, docs, package metadata; repository rename needs owner action (see below) |
| 3 Core infrastructure | Done | State machine, router, chain executor, circuits, recovery queue, inbound webhooks, refunds rework; tests |
| 4 Provider ecosystem | Partial | 10 live adapters + 2 sandbox rails; adapter tests with mocked HTTP; live sandbox runs need provider test keys |
| 5 Enterprise functionality | Done | Providers, routing admin, invitations, 7 roles, MFA + step-up, key rotation, org profile/limits, operations console, notifications |
| 6 Analytics | Done | Analytics dashboard, provider ranking, cost per success, forecasts, anomaly cron, API usage, CSV reports |
| 7 User experience | Done (website verified visually); dashboard type-checked | Screenshots of website desktop + mobile; dashboard needs a running backend to view |
| 8 Optimization | Partial | Indexed queries for every hot path, bounded batch sizes, self-hosted subset fonts (≈210 KB); load testing not run |
| 9 Testing and deployment prep | Partial | 102 unit tests passing; backend and frontend type-check; CI workflow; full `vite build` blocked by registry access in the build environment |

## Feature matrix

| Capability | Status |
|---|---|
| Provider adapter contract + registry | Done |
| Stripe, Adyen, Checkout.com, dLocal, Paystack, Flutterwave, M-Pesa, Razorpay, Mercado Pago, Xendit | Partial (code + unit tests; live sandbox verification pending keys) |
| Intelligent routing (rules, scoring, caps, explanations) | Done |
| Failover with safety rules | Done |
| Circuit breakers | Done |
| Unknown-outcome recovery + escalation | Done |
| 16-state lifecycle | Done |
| Inbound provider webhooks (verify, dedupe, apply) | Done |
| Refunds (partial, concurrent-safe, pending) | Done |
| Disputes from provider webhooks | Done |
| FX rates, quotes, USD-normalization | Done (charging in a different currency than settlement: Planned) |
| Compliance: jurisdiction policy + sanctions screening | Done |
| Settlement-report reconciliation | Done |
| Analytics, reports, anomaly detection, forecasting | Done |
| API: versioned REST, envelope, errors, idempotency, correlation ids, pagination, rate limits, metering, OpenAPI | Done |
| TypeScript SDK | Done |
| Org management, invitations, 7 roles, MFA, step-up, key rotation | Done |
| Operations console | Done |
| Public website (13 pages) + developer portal | Done |
| Scheduled reports by email | Planned (no email provider configured) |
| Payout routing across providers | Planned (payouts still use the original adapter path) |
| Dedicated open-banking (A2A) adapter | Planned |
| Load/performance test suite | Planned |

## Access and actions needed from the owner

1. **npm registry access** in the build environment (Settings → Capabilities)
   or run `npm install && npm run build` locally/CI to complete the build check.
2. **Provider test credentials** for the providers you will launch with, to run
   live sandbox verification.
3. **Repository rename** `raevolt` → `usopgrid` (GitHub Settings → General).
   GitHub redirects the old URL automatically.
4. Production secrets listed in `docs/USOPGRID_DEPLOYMENT.md`.
5. Legal review of jurisdiction policy, privacy notice, terms and disclosures.
