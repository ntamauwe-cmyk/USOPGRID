// USOPGRID provider registry.
//
// To add a processor: implement ProviderAdapter in its own file and append it
// here. The router, engine, API, webhooks, recovery jobs and UI all discover
// it from this list — nothing else changes.

import type { ProviderAdapter, ProviderDescriptor } from "./types";
import { sandboxAdapter, sandboxBackupAdapter } from "./sandbox";
import { stripeAdapter } from "./stripe";
import { adyenAdapter } from "./adyen";
import { checkoutComAdapter } from "./checkoutcom";
import { paystackAdapter } from "./paystack";
import { flutterwaveAdapter } from "./flutterwave";
import { mpesaAdapter } from "./mpesa";
import { razorpayAdapter } from "./razorpay";
import { mercadoPagoAdapter } from "./mercadopago";
import { xenditAdapter } from "./xendit";
import { dlocalAdapter } from "./dlocal";

export * from "./types";
export { SANDBOX_SIMULATION_KEYS } from "./sandbox";

export const ADAPTERS: readonly ProviderAdapter[] = [
  sandboxAdapter,
  sandboxBackupAdapter,
  stripeAdapter,
  adyenAdapter,
  checkoutComAdapter,
  dlocalAdapter,
  paystackAdapter,
  flutterwaveAdapter,
  mpesaAdapter,
  razorpayAdapter,
  mercadoPagoAdapter,
  xenditAdapter,
];

const BY_ID = new Map(ADAPTERS.map((a) => [a.descriptor.id, a]));

export function getAdapter(id: string): ProviderAdapter | undefined {
  return BY_ID.get(id);
}

export function listDescriptors(): ProviderDescriptor[] {
  return ADAPTERS.map((a) => a.descriptor);
}

export const SANDBOX_PROVIDER_IDS = new Set(["sandbox", "sandbox_backup"]);

/** Platform-level credentials from the environment (per-merchant connections override these). */
export function envCredentialsFor(d: ProviderDescriptor, env: Record<string, string | undefined>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [field, varName] of Object.entries(d.envCredentials)) {
    const val = env[varName];
    if (val) out[field] = val;
  }
  const missing = d.credentials.filter((c) => c.required && !out[c.key]);
  return missing.length === 0 ? out : null;
}
