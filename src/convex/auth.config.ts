import type { AuthConfig } from "convex/server";

// Freebuff-signed federated tokens (see freebuff web's
// src/lib/vly-convex-jwt.ts) let a signed-in freebuff.com user carry their
// identity into this project without going through local sign-in. customJwt
// is correct for this provider: freebuff's tokens and JWKS both carry a
// `kid` header, which the customJwt validation path requires.
const freebuffIssuer =
  process.env.VLY_CONVEX_AUTH_ISSUER ?? "https://freebuff.com";

export default {
  providers: [
    // Standard Convex Auth provider for this project's own sign-in ("Get
    // Started" email/guest, see src/convex/auth.ts). The deployment
    // self-issues JWTs (iss = CONVEX_SITE_URL, no `kid` header) validated
    // via OIDC discovery at `${domain}/.well-known/openid-configuration`,
    // served by auth.addHttpRoutes() in convex/http.ts. Do NOT convert this
    // entry to `type: "customJwt"` — that path rejects tokens without a
    // `kid` header, so sign-in would silently never confirm and RequireAuth
    // would loop back to /auth forever.
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: "convex",
    },
    // Federated tokens from the template's hosting platform are trusted ONLY
    // when explicitly enabled. Trusting an outside issuer means that issuer
    // (or anyone who compromises it) can mint sessions for this deployment, so
    // it stays off for production payment deployments.
    ...(process.env.USOPGRID_ALLOW_FEDERATED_LOGIN === "true"
      ? [
          {
            type: "customJwt" as const,
            issuer: freebuffIssuer,
            jwks: `${freebuffIssuer}/api/web/.well-known/jwks.json`,
            applicationID: "vly-convex",
            algorithm: "RS256" as const,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
