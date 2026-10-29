// Sign-in providers.
//
// Email codes and the guest sandbox are always available. Enterprise single
// sign-on providers switch on automatically when their settings exist on the
// deployment (no code change), see docs/USOPGRID_DEPLOYMENT.md:
//   Google Workspace    AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET
//   Microsoft Entra ID  AUTH_MICROSOFT_ENTRA_ID_ID, AUTH_MICROSOFT_ENTRA_ID_SECRET, AUTH_MICROSOFT_ENTRA_ID_ISSUER
//   Okta                AUTH_OKTA_ID, AUTH_OKTA_SECRET, AUTH_OKTA_ISSUER
//   Any OIDC provider   AUTH_OIDC_ID, AUTH_OIDC_SECRET, AUTH_OIDC_ISSUER, AUTH_OIDC_NAME
// OAuth redirects also need SITE_URL (the web app's address).

import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import Google from "@auth/core/providers/google";
import MicrosoftEntraID from "@auth/core/providers/microsoft-entra-id";
import Okta from "@auth/core/providers/okta";
import { emailOtp } from "./auth/emailOtp";
import { ssoProviders } from "./lib/sso";

const env = process.env;

function enterpriseProviders() {
  const out = [];
  for (const p of ssoProviders(env)) {
    if (p.id === "google") out.push(Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }));
    if (p.id === "microsoft-entra-id")
      out.push(MicrosoftEntraID({ clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID, clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET, issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER }));
    if (p.id === "okta") out.push(Okta({ clientId: env.AUTH_OKTA_ID, clientSecret: env.AUTH_OKTA_SECRET, issuer: env.AUTH_OKTA_ISSUER }));
    if (p.id === "oidc")
      out.push({
        id: "oidc",
        name: p.label,
        type: "oidc" as const,
        issuer: env.AUTH_OIDC_ISSUER,
        clientId: env.AUTH_OIDC_ID,
        clientSecret: env.AUTH_OIDC_SECRET,
        checks: ["pkce", "state"] as ("pkce" | "state")[],
      });
  }
  return out;
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [emailOtp, Anonymous, ...enterpriseProviders()],
});
