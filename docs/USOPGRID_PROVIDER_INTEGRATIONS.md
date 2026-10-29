# USOPGRID Provider Integrations

All providers implement one contract (`src/convex/providers/types.ts`):
`charge`, `getStatus`, `refund`, `verifyWebhook`, `parseWebhook`, plus a
descriptor declaring countries, currencies, methods, limits, operations,
list pricing and credential fields. Adding a provider = one adapter file +
one line in `providers/index.ts`; the router, API, webhooks, recovery queue,
dashboard catalog, website directory and OpenAPI spec pick it up automatically.

## Selection rationale

Coverage strategy: two or three **global acquirers** for cards and wallets
everywhere, plus **regional specialists** where local methods, local acquiring
or pricing beat global players. Cost is a routing input, so cheaper local
rails win automatically when they perform.

| Provider | Role | Why selected | Methods |
|---|---|---|---|
| Stripe | Global acquirer | Best developer tooling, 135+ presentment currencies, strong docs, idempotency native | cards, wallets, bank transfer, direct debit, BNPL, open banking |
| Adyen | Global acquirer (enterprise) | Interchange++ pricing for high volume, 250+ local methods, direct scheme connections | cards, wallets, bank transfer, open banking, direct debit, BNPL, QR, Pix, UPI, vouchers |
| Checkout.com | Global acquirer | Strong EU / Middle East / APAC acquiring, interchange++ | cards, wallets, bank transfer, open banking, BNPL |
| dLocal | Emerging markets | One contract for ~40 emerging markets (LatAm, Africa, Asia, Middle East) with local acquiring | cards, bank transfer, vouchers, wallets, Pix, UPI, mobile money, QR |
| Paystack | Africa (NG, GH, ZA, KE, CI, EG, RW) | Leading Nigerian PSP, low local pricing with cap | cards, bank transfer, USSD, mobile money, QR, open banking |
| Flutterwave | Africa + diaspora corridors | Widest African coverage, mobile money, multi-currency | cards, bank transfer, mobile money, USSD |
| M-Pesa (Daraja) | Kenya mobile money | Direct STK push; dominant Kenyan rail | mobile money |
| Razorpay | India | UPI, cards, netbanking with RBI-compliant flows | UPI, cards, wallets, bank transfer |
| Mercado Pago | Latin America | Market leader in AR/BR/MX/CL/CO/PE/UY, Pix | cards, Pix, vouchers, wallets |
| Xendit | Southeast Asia | ID/PH/TH/VN/MY local methods via one API | virtual accounts, e-wallets, QR, cards, retail |
| Sandbox + Sandbox Backup | Simulation | Every country/currency/method; deterministic outcomes for testing failover and recovery | all |

### Evaluated, not yet implemented

| Provider | Status / reason |
|---|---|
| Worldpay (FIS) | Strong enterprise acquiring; integration requires a commercial onboarding and certification. Adapter contract is ready; add when a merchant contract exists. |
| Nuvei | Good APM coverage; same as above. |
| PayPal / Braintree | Wallet demand is high in some markets; candidate for the next adapter. |
| Open banking AIS/PIS aggregators (TrueLayer, Tink, Yapily, Plaid, Mono, Okra) | Open-banking payments are covered via Stripe/Adyen/Checkout.com/Paystack today; a dedicated A2A adapter is the next connectivity milestone. |
| Network tokenization (Visa VTS / Mastercard MDES) | Obtained through acquirers (Stripe, Adyen, Checkout.com) rather than directly; no separate integration needed. |

## Verified list pricing (October 2026)

Used only until real provider fees are observed; merchants override with their
agreed rates per connection. Verified against public sources:

| Provider | Declared list pricing |
|---|---|
| Stripe (US) | 2.9% + US$0.30 domestic cards; international cards +1.5% |
| Adyen | US$0.13 processing fee + interchange++ + 0.60% (Visa/Mastercard) |
| Paystack (Nigeria) | 1.5% + ₦100 (₦100 waived under ₦2,500), capped at ₦2,000; international 3.9% + ₦100 |
| Flutterwave (Nigeria) | 1.4% local, capped at ₦2,000 |
| Others | Negotiated; set on the connection |

The router honours **fee caps** (`pricing.capMinor`).

## Per-provider technical notes

| Provider | Auth | Idempotency | Webhook verification | Status lookup | Notes |
|---|---|---|---|---|---|
| Stripe | Bearer secret key | `Idempotency-Key` header | `Stripe-Signature` HMAC-SHA256 over `t.body`, 5-min tolerance | PaymentIntent by id, or search by metadata when the create timed out | 402 → decline mapping |
| Adyen | `X-API-Key` | `Idempotency-Key` | HMAC-SHA256 over NotificationRequestItem fields, hex key | — (webhook-driven) | Live URL prefix required in production |
| Checkout.com | Bearer secret | `Cko-Idempotency-Key` | `Cko-Signature` HMAC-SHA256 | Payment by id | Processing channel required |
| dLocal | `X-Login`/`X-Trans-Key` + HMAC `Authorization` | `order_id` = transaction id | V2-HMAC-SHA256 of login+date+body | Payment by id | Country required |
| Paystack | Bearer secret | Reference = transaction id | `x-paystack-signature` HMAC-SHA512 | Verify by reference | Whole-kobo amounts |
| Flutterwave | Bearer secret | `tx_ref` = transaction id | `verif-hash` shared secret | Verify by tx_ref | Decimal amounts converted exactly |
| M-Pesa | OAuth client credentials | `AccountReference` | Per-connection HMAC token in callback URL; success re-confirmed via query | STK query | Whole KES only; phone required |
| Razorpay | Basic key id/secret | `reference_id` = transaction id (duplicates rejected) | `X-Razorpay-Signature` HMAC-SHA256 | Payment link / payment | |
| Mercado Pago | Bearer token | `X-Idempotency-Key` | `x-signature` manifest HMAC | Payment search | |
| Xendit | Basic secret | `Idempotency-key` header | `x-callback-token` | Invoice by external id | Whole IDR only |

**Ambiguity rule (all adapters):** timeouts, transport errors and 5xx return
`status: "unknown"` with `safeToFailover: false`; 401/403/400/429 return
`failed` with `safeToFailover: true`. This is enforced by `providers/http.ts`
and tested for every adapter (`src/tests/providers.test.ts`).

## Connecting a provider

1. Dashboard → Providers → Connect. Credentials are sealed with AES-256-GCM
   (AAD = connection key) and never shown again.
2. Copy the connection's webhook URL into the provider's dashboard:
   `https://<deployment>.convex.site/api/v1/webhooks/providers/<pc_…>`
3. Run **Test**: a status lookup for a non-existent reference proves the
   credentials without moving money.
4. Optional: set priority and agreed pricing.

Platform-owned accounts can instead be configured through environment
variables (`.env.example`); production reads `NAME`, sandbox reads `NAME_SANDBOX`.

## Sandbox verification status

| Provider | Adapter unit tests | Live sandbox run |
|---|---|---|
| Sandbox rails | Full lifecycle, failover, timeout recovery | n/a |
| Stripe | Request shape, success, decline, 5xx/timeout/network ambiguity, 401, webhook signature (valid/tampered/stale) | Requires test keys |
| Paystack, Checkout.com, Flutterwave, Xendit | Webhook verification | Requires test keys |
| All 10 live adapters | 503 → `unknown` | Requires test keys |

Live sandbox runs need each provider's test credentials, which were not
available in the build environment. See `docs/USOPGRID_IMPLEMENTATION_PLAN.md`.
