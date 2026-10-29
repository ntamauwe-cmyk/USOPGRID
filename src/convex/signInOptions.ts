import { query } from "./_generated/server";
import { ssoProviders } from "./lib/sso";

/** Public: which enterprise sign-in buttons to show. Reveals names only, never settings. */
export const list = query({
  args: {},
  handler: async () => ({ sso: ssoProviders(process.env) }),
});
