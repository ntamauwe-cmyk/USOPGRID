import type { AuthConfig } from "convex/server";

// USOPGRID trusts exactly one token issuer: this deployment itself.
//
// The template this project started from also trusted tokens signed by its
// hosting platform (freebuff). That meant an outside party could mint sessions
// for this payment platform, so it has been removed entirely. Convex also
// requires every environment variable referenced here to be set, so this file
// deliberately reads nothing beyond CONVEX_SITE_URL (provided by Convex).
//
// The deployment self-issues JWTs (iss = CONVEX_SITE_URL, no `kid` header)
// validated via OIDC discovery at `${domain}/.well-known/openid-configuration`,
// served by auth.addHttpRoutes() in convex/http.ts. Do NOT convert this entry
// to `type: "customJwt"`: that path rejects tokens without a `kid` header, so
// sign-in would never confirm and RequireAuth would loop back to /auth.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
