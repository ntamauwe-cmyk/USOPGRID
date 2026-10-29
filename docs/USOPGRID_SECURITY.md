# USOPGRID Security

## Controls implemented

| Area | Control | Where |
|---|---|---|
| Authentication | Email OTP (Convex Auth); anonymous sessions limited to sandbox (cannot go live) | `auth.ts`, `orgs.updateOrgEnvironment` |
| Sign-in | 8-digit email codes (10⁸ space), 15-minute expiry, sent via Resend or your relay from deployment settings; no secrets in code; Convex Auth failed-attempt limits; patched Auth.js (homoglyph email bypass fixed) | `auth/emailOtp.ts` |
| MFA | TOTP (RFC 6238, SHA-1/6 digits/30 s, ±1 step), single-use per time step, 8 hashed recovery codes, 15-min step-up window, max 10 code attempts per user per 15 minutes | `security.ts`, `lib/crypto.ts` |
| Step-up | Required for provider credentials, routing, API keys, refunds, role changes, invitations, going live — whenever the user has MFA or the org policy requires it | `lib/rbac.requireSensitive`, `components/StepUp.tsx` |
| Authorization | 7 roles → 15 permissions, checked server-side on every function | `schema.ROLE_PERMISSIONS`, `lib/rbac.ts` |
| Tenant isolation | Org derived from session/API key; every lookup re-checks `orgId`; inbound provider events for another org are rejected | all modules |
| Platform staff | Operations console gated by `USOPGRID_PLATFORM_ADMINS`; every operator change requires an enrolled authenticator plus fresh step-up (no opt-out); every action audited as `operator:<email>` | `ops.ts`, `lib/rbac.requireOperatorStepUp` |
| Federated identity | Tokens from the template's hosting platform are not trusted unless `USOPGRID_ALLOW_FEDERATED_LOGIN=true` | `auth.config.ts` |
| API keys | 256-bit random, shown once, SHA-256 at rest, sandbox/live split, rotation with grace period, revocation, per-key rate limit; live secret keys refused when sent from a browser (`Origin` header present) | `services.ts`, `lib/apikeys.ts`, `lib/httpservice.ts` |
| Secrets at rest | AES-256-GCM, random 96-bit IV, AAD binds each ciphertext to its record (no swapping between records), versioned keyring with key ids, operator-run re-encryption (compare-and-set, audited); hints only to clients; destroyed on revoke | `lib/keyring.ts`, `keyRotation.ts` |
| Card data | Never accepted; only provider tokens (`payment_token`) | API validation |
| Payout accounts | Full number sealed (AAD = org + account hash), decrypted only inside the payout action to instruct the provider; UI/API see a masked value; adding a beneficiary and sending a payout require step-up | `payouts.ts` |
| Abuse limits | Checkout: 10 attempts per client per 10 min and 60 per payment link (card-testing defence); provider webhooks: 600/min per connection, forged deliveries recorded at most 20/min; limiter fails closed on these public surfaces | `lib/httpservice.throttle`, `api.ts`, `providerWebhooks.ts` |
| Browser hardening | CSP (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), HSTS, X-Frame-Options DENY, COOP, CORP, Permissions-Policy, nosniff, strict referrer; generated for Netlify/Cloudflare (`public/_headers`) and Vercel (`vercel.json`) from `deploy/security-headers.json`, test fails on drift. The API sends `default-src 'none'`, HSTS and DENY on every response | `deploy/`, `scripts/gen-headers.mjs` |
| Supply chain | No third-party script at runtime: the template's editor plugin (which loaded a CDN script and posted page screenshots/errors to any parent window) and toolbar are excluded from production builds; `npm audit`: 0 known vulnerabilities (29 Oct 2026) | `vite.config.ts`, `src/main.tsx` |
| Webhooks out | HMAC-SHA256 with timestamp; event id for de-duplication | `webhooks.ts` |
| Webhooks in | Provider-specific signature verification over raw body, size limit 1 MB, unverified events recorded and rejected, de-duplication by event id | `providerWebhooks.ts` |
| Replay / idempotency | Idempotency keys; state machine ignores stale/duplicate events; TOTP counter replay protection | `lib/idempotency.ts`, `orchestration/states.ts` |
| Input validation | Currency/country/method registries, metadata limits, amount safe-integer checks, CSV parser rejects excess precision | `api.ts`, `payments.ts`, `lib/recon.ts` |
| Output handling | Error envelope never leaks stack traces (production error screen hides stacks; email-sender errors never echo request config); CSV export neutralizes formula injection; `nosniff`, `no-store` headers | `lib/httpservice.ts`, `lib/analytics.toCsv` |
| Compliance | Jurisdiction policy (block CU/IR/KP; review high-risk list), sanctions screening via OpenSanctions on live payments, fail-closed on screening outage | `orchestration/compliance.ts`, `payments.ts` |
| Audit | Append-only audit log with actor/before/after for all privileged actions | `lib/audit.ts` |
| Privacy | Self-hosted fonts and assets (no third-party requests on the website) | `public/fonts` |
| Crypto hygiene | Web Crypto only; constant-time comparisons; rejection-sampled random tokens | `lib/crypto.ts` |

## Known risks and required actions before production

1. **Sign-in email.** The relay key that the template hard-coded
   (`fb_email_…`) has been removed from the code but remains in git history, so
   treat it as public: ask the relay's owner to revoke it, and configure
   `RESEND_API_KEY` + `OTP_EMAIL_FROM` (or your own relay). Email sign-in stays
   off until one is set.
2. Set the encryption key (`USOPGRID_ENCRYPTION_KEY`, or the keyring
   variables) and store every key in a secrets manager. Without it, provider
   connections, MFA and live payouts are disabled (fail closed).
3. Set `OPENSANCTIONS_API_KEY` (or another screening provider) before
   processing live payments; without it only the jurisdiction policy applies.
4. Review `DEFAULT_JURISDICTION_POLICY` with counsel for each licence you operate under.
5. Application-level limits now cover checkout, webhooks and MFA; still put a
   WAF/CDN (e.g. Cloudflare) in front of the API domain for volumetric attacks
   and bot management.
6b. Every platform operator must enrol an authenticator before they can change
   anything in the operations console.
6. Run dependency scanning (`npm audit`, GitHub Dependabot) in CI — the build
   environment had no registry access.
7. PCI DSS: USOPGRID stays in SAQ-A scope only while all card capture uses
   provider-hosted fields. Do not add raw PAN fields.

## Encryption key rotation

Ciphertexts carry their key id (`v2.<kid>.<iv>.<ct>`; legacy `v1.` values
belong to `USOPGRID_ENCRYPTION_KEY`, id `k0`).

1. Generate a key: `openssl rand -base64 32`, store it in your secrets manager.
2. `npx convex env set USOPGRID_ENCRYPTION_KEYS "k1:<old>,k2:<new>" --prod`
   (or keep `USOPGRID_ENCRYPTION_KEY` as `k0` and add only `k2:<new>`).
3. `npx convex env set USOPGRID_ENCRYPTION_KEY_ID k2 --prod`. New secrets use k2.
4. Operations console → Encryption keys → **Re-encrypt with active key**
   (operator + MFA; audited as `security.secrets_resealed`). Re-run until
   **Check key usage** shows nothing on the old key.
5. Remove the old key from the environment.

## Reporting vulnerabilities

security@usopgrid.com
