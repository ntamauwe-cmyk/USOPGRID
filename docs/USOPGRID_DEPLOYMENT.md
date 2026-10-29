# USOPGRID Deployment

## Components

| Component | Hosting |
|---|---|
| Frontend (Vite SPA + public website) | Any static host/CDN (Vercel, Netlify, Cloudflare Pages, S3+CloudFront). SPA fallback to `index.html`. |
| Backend (Convex functions, crons, HTTP API) | Convex Cloud (or self-hosted Convex backend). |
| API domain | `https://<deployment>.convex.site` or a custom domain (e.g. `api.usopgrid.com`) via Convex custom domains. |

## First deployment

```bash
npm install
npx convex deploy                      # creates/updates the production backend, runs codegen + typecheck
npx convex env set USOPGRID_ENCRYPTION_KEY "$(openssl rand -base64 32)" --prod
npx convex env set USOPGRID_PLATFORM_ADMINS "ops@yourcompany.com" --prod
npx convex env set OPENSANCTIONS_API_KEY "…" --prod          # recommended
npx convex env set RESEND_API_KEY "re_…" --prod               # sign-in emails
npx convex env set OTP_EMAIL_FROM "USOPGRID <login@mail.yourdomain.com>" --prod
npx convex env set VLY_APP_NAME "USOPGRID" --prod
# optional platform-owned provider accounts: see .env.example
VITE_CONVEX_URL=https://<deployment>.convex.cloud npm run build
# upload dist/ to your static host. public/_headers (Netlify, Cloudflare Pages)
# and vercel.json carry the security headers; on other hosts copy them from
# deploy/security-headers.json. If the API uses a custom domain other than
# api.usopgrid.com, add it to connect-src there and run `npm run headers`.
```

Development: `npx convex dev` + `npm run dev`.

## Checks before going live

- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass in CI.
- [ ] Encryption key set and backed up in a secrets manager.
- [ ] Platform admins set; operations console reachable.
- [ ] FX snapshot present (Operations → System health; first refresh runs within an hour, or trigger `fxrates:refreshRatesInternal` from the Convex dashboard).
- [ ] At least one live provider connection per target market, **Test** passing, provider webhook URL configured at the provider.
- [ ] Merchant webhook endpoints verified with signature checking.
- [ ] Sanctions screening configured; jurisdiction policy reviewed by counsel.
- [ ] Sign-in email configured (`RESEND_API_KEY` + `OTP_EMAIL_FROM`); old template relay key revoked.
- [ ] `USOPGRID_ALLOW_FEDERATED_LOGIN` unset; `VITE_EDITOR_PREVIEW` unset for the production build.
- [ ] Every platform operator has enrolled an authenticator.
- [ ] Security headers present: `curl -sI https://your-site | grep -i content-security-policy`.
- [ ] Payout provider (Paystack/Flutterwave) webhook URL set to the connection's URL; Paystack "OTP for transfers" disabled for API transfers.
- [ ] WAF/CDN in front of public endpoints.
- [ ] Backups: enable Convex scheduled backups (daily) and test a restore.

## CI (recommended)

`.github/workflows/ci.yml` runs install, typecheck, lint, tests and build on
every push and pull request.

## Rollback

Frontend: redeploy the previous build. Backend: `npx convex deploy` from the
previous commit. Schema changes in this release are additive (new tables,
optional fields, widened unions), so rolling back code does not require a data
migration.

## Data migration notes

- Existing transactions remain valid. Legacy rows without `connectionId` are
  refunded through the platform connection for their provider.
- Old ledger account display names (e.g. "RAEVOLT fees NGN") are preserved for
  historical integrity; new accounts use USOPGRID names.
- `ROLE_PERMISSIONS` changed: `viewer` now has `analytics:view`; new role
  `risk_compliance`. Existing members keep their roles.
