# USOPGRID Security

## Controls implemented

| Area | Control | Where |
|---|---|---|
| Authentication | Email OTP (Convex Auth); anonymous sessions limited to sandbox (cannot go live) | `auth.ts`, `orgs.updateOrgEnvironment` |
| MFA | TOTP (RFC 6238, SHA-1/6 digits/30 s, ±1 step), single-use per time step, 8 hashed recovery codes, 15-min step-up window | `security.ts`, `lib/crypto.ts` |
| Step-up | Required for provider credentials, routing, API keys, refunds, role changes, invitations, going live — whenever the user has MFA or the org policy requires it | `lib/rbac.requireSensitive`, `components/StepUp.tsx` |
| Authorization | 7 roles → 15 permissions, checked server-side on every function | `schema.ROLE_PERMISSIONS`, `lib/rbac.ts` |
| Tenant isolation | Org derived from session/API key; every lookup re-checks `orgId`; inbound provider events for another org are rejected | all modules |
| Platform staff | Operations console gated by `USOPGRID_PLATFORM_ADMINS`; every operator action audited as `operator:<email>` | `ops.ts` |
| API keys | 256-bit random, shown once, SHA-256 at rest, sandbox/live split, rotation with grace period, revocation, per-key rate limit | `services.ts`, `lib/apikeys.ts` |
| Provider credentials | AES-256-GCM, random 96-bit IV, AAD = connection key (no ciphertext swapping), key from `USOPGRID_ENCRYPTION_KEY`, hints only to clients, destroyed on revoke | `lib/crypto.ts`, `providers.ts`, `connections.ts` |
| Card data | Never accepted; only provider tokens (`payment_token`) | API validation |
| Bank accounts | Masked + SHA-256 hash only | `payouts.ts` |
| Webhooks out | HMAC-SHA256 with timestamp; event id for de-duplication | `webhooks.ts` |
| Webhooks in | Provider-specific signature verification over raw body, size limit 1 MB, unverified events recorded and rejected, de-duplication by event id | `providerWebhooks.ts` |
| Replay / idempotency | Idempotency keys; state machine ignores stale/duplicate events; TOTP counter replay protection | `lib/idempotency.ts`, `orchestration/states.ts` |
| Input validation | Currency/country/method registries, metadata limits, amount safe-integer checks, CSV parser rejects excess precision | `api.ts`, `payments.ts`, `lib/recon.ts` |
| Output handling | Error envelope never leaks stack traces; CSV export neutralizes formula injection; `nosniff`, `no-store` headers | `lib/httpservice.ts`, `lib/analytics.toCsv` |
| Compliance | Jurisdiction policy (block CU/IR/KP; review high-risk list), sanctions screening via OpenSanctions on live payments, fail-closed on screening outage | `orchestration/compliance.ts`, `payments.ts` |
| Audit | Append-only audit log with actor/before/after for all privileged actions | `lib/audit.ts` |
| Privacy | Self-hosted fonts and assets (no third-party requests on the website) | `public/fonts` |
| Crypto hygiene | Web Crypto only; constant-time comparisons; rejection-sampled random tokens | `lib/crypto.ts` |

## Known risks and required actions before production

1. **`src/convex/auth/emailOtp.ts` contains a hard-coded API key** for the
   template's OTP email relay (`auth.freebuff.app`). Rotate it and move it to an
   environment variable, or replace the relay with your own email provider
   (Resend, SES, Postmark). The original template marks this file read-only, so only its
   default sender name was changed (to USOPGRID).
2. Set `USOPGRID_ENCRYPTION_KEY` (32 random bytes, base64) and store it in a
   secrets manager with a documented rotation procedure. Without it, provider
   connections and MFA are disabled (fail closed).
3. Set `OPENSANCTIONS_API_KEY` (or another screening provider) before
   processing live payments; without it only the jurisdiction policy applies.
4. Review `DEFAULT_JURISDICTION_POLICY` with counsel for each licence you operate under.
5. Rate limiting is per key in the database; put a WAF/CDN rate limit in front
   of the public endpoints (`/checkout`, `/webhooks/providers`, contact form).
6. Run dependency scanning (`npm audit`, GitHub Dependabot) in CI — the build
   environment had no registry access.
7. PCI DSS: USOPGRID stays in SAQ-A scope only while all card capture uses
   provider-hosted fields. Do not add raw PAN fields.

## Encryption key rotation

Ciphertexts are versioned (`v1.<iv>.<ct>`). To rotate: deploy the new key as
`USOPGRID_ENCRYPTION_KEY` alongside the old one under a new version tag, re-seal
connections in a migration, then retire the old key. (The migration action is
on the roadmap; until then, rotation means re-entering credentials.)

## Reporting vulnerabilities

security@usopgrid.com
