// Which enterprise sign-in providers are configured on this deployment.
// A provider counts only when every required setting is present and HTTPS.

export type SsoProvider = { id: "google" | "microsoft-entra-id" | "okta" | "oidc"; label: string };

type Env = Record<string, string | undefined>;

const httpsUrl = (v: string | undefined) => !!v && /^https:\/\/[^\s]+$/.test(v);

export function ssoProviders(env: Env): SsoProvider[] {
  const out: SsoProvider[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) out.push({ id: "google", label: "Google Workspace" });
  if (env.AUTH_MICROSOFT_ENTRA_ID_ID && env.AUTH_MICROSOFT_ENTRA_ID_SECRET && httpsUrl(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER))
    out.push({ id: "microsoft-entra-id", label: "Microsoft" });
  if (env.AUTH_OKTA_ID && env.AUTH_OKTA_SECRET && httpsUrl(env.AUTH_OKTA_ISSUER)) out.push({ id: "okta", label: "Okta" });
  if (env.AUTH_OIDC_ID && env.AUTH_OIDC_SECRET && httpsUrl(env.AUTH_OIDC_ISSUER))
    out.push({ id: "oidc", label: (env.AUTH_OIDC_NAME ?? "").trim().slice(0, 40) || "Company SSO" });
  return out;
}
