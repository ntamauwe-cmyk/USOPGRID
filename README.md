<p><img src="public/brand/usopgrid-horizontal-light.svg" alt="USOPGRID" height="48"></p>

# USOPGRID

**Powering Every Payment Connection.**
Enterprise Payment Infrastructure by **RAE Horizon Technologies Limited**.

USOPGRID connects businesses to payment providers worldwide, routes every
payment to the provider most likely to succeed, fails over only when it is
provably safe, and reconciles every unit of value against an immutable
double-entry ledger. It is a standalone product, separate from RAE Pay, RAE
Wallet, Penroute, RAE Mind AI and Heyra. (Formerly developed as RAEVOLT; see
`docs/archive/`.)

## What it does

| Capability | Highlights |
|---|---|
| **Connectivity** | 10 live provider adapters (Stripe, Adyen, Checkout.com, dLocal, Paystack, Flutterwave, M-Pesa, Razorpay, Mercado Pago, Xendit) + two sandbox rails, behind one contract. 155 currencies with correct minor units, 250 territories, 13 payment-method families. |
| **Processing** | Versioned REST API, idempotency keys, correlation ids, 16-state lifecycle, signed webhooks in and out, refunds, payouts, payment links, disputes. |
| **Orchestration** | Explainable scoring on success rate, cost (with fee caps) and latency; prefer/exclude/only rules; circuit breakers; safe failover; recovery queue for ambiguous outcomes. |
| **Precision** | Integer money, exact FX, balanced immutable ledger, settlement-report reconciliation with typed exceptions and audited resolutions. |
| **Intelligence** | Provider ranking, success/approval/failover rates by country, method and currency, cost per success, anomaly alerts, forecasts, CSV reports, API usage. |
| **Enterprise** | 7 roles / 15 permissions, invitations, TOTP MFA with step-up for sensitive actions, key rotation, org limits, notifications, operations console for staff. |

## Repository map

```
src/
  site/                     Public website + developer portal (plain CSS, no framework)
  pages/dashboard/          Merchant dashboard (Overview … Providers, Routing, Reconciliation,
                            Analytics, Reports, Organization, Team, Security, Operations)
  components/brand.tsx      Logo system (emblem, wordmark, lockups, palette); see docs/USOPGRID_BRAND.md
  convex/                   Backend (Convex)
    orchestration/          states · router · engine · circuit · retry · compliance  (pure, tested)
    providers/              adapter contract + 12 adapters                           (pure, tested)
    lib/                    fx · fees · risk · recon · analytics · openapi · crypto · ledger …
    payments.ts             orchestration action, finalizers, refunds
    connections.ts          sealed credentials, routing context, circuits, telemetry
    recovery.ts · providerWebhooks.ts · fxrates.ts · analytics.ts · reconciliation.ts
    routing.ts · providers.ts · security.ts · ops.ts · notifications.ts · contact.ts
    api.ts · http.ts        public REST API /api/v1
  tests/                    Bun unit tests
sdk/typescript/             Zero-dependency typed client
docs/                       USOPGRID_* architecture, plan, providers, API, security, deployment, operations
public/                     logo.svg · favicon.svg · wordmark.svg · og-image.svg · fonts/
```

## Quick start

```bash
npm install
npx convex dev            # backend (generates src/convex/_generated)
npm run dev               # frontend on http://localhost:5173
npm test                  # unit tests (Bun)
```

Then sign in, open **Developers**, create a sandbox key and:

```bash
curl "$USOPGRID_API/payments" \
  -H "Authorization: Bearer sk_sandbox_…" \
  -H "Idempotency-Key: order-7781" \
  -H "Content-Type: application/json" \
  -d '{"amount": 2500000, "currency": "NGN", "payment_method": "card", "country": "NG",
       "reference": "order-7781", "metadata": {"simulate": "failover"}}'
```

The response shows the payment succeeding on the backup rail after the primary
was unavailable (`"attempts": 2, "failovers": 1`). Full docs: `/developers` on
the running site, or `GET /api/v1/openapi.json`.

## Configuration

See `.env.example`. Production requires at minimum `USOPGRID_ENCRYPTION_KEY`
and `USOPGRID_PLATFORM_ADMINS`; sanctions screening (`OPENSANCTIONS_API_KEY`)
is strongly recommended. Deployment checklist: `docs/USOPGRID_DEPLOYMENT.md`.

## Documentation

- [Architecture](docs/USOPGRID_ARCHITECTURE.md)
- [Implementation plan and status](docs/USOPGRID_IMPLEMENTATION_PLAN.md)
- [Provider integrations](docs/USOPGRID_PROVIDER_INTEGRATIONS.md)
- [API](docs/USOPGRID_API_DOCUMENTATION.md)
- [Security](docs/USOPGRID_SECURITY.md)
- [Deployment](docs/USOPGRID_DEPLOYMENT.md)
- [Operations runbook](docs/USOPGRID_OPERATIONS.md)
- [Brand identity](docs/USOPGRID_BRAND.md)

## Important

USOPGRID is payment technology. Funds are processed and held by the licensed
providers and institutions you connect; operating live in a market requires
accounts with those providers and compliance with local law.

© RAE Horizon Technologies Limited.
