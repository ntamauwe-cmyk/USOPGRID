import { httpRouter } from "convex/server";
import { auth } from "./auth";
import * as api from "./api";
import { receive as providerWebhook } from "./providerWebhooks";
import { publicStatus } from "./status";

const http = httpRouter();

auth.addHttpRoutes(http);

// ---------------------------------------------------------------------------
// USOPGRID public API — /api/v1
// ---------------------------------------------------------------------------
const routes: [string, "GET" | "POST", Parameters<typeof http.route>[0]["handler"], boolean?][] = [
  ["/api/v1/health", "GET", api.health],
  ["/api/v1/status", "GET", publicStatus],
  ["/api/v1/whoami", "GET", api.whoami],
  ["/api/v1/openapi.json", "GET", api.openapi],
  ["/api/v1/reference", "GET", api.referenceData],
  ["/api/v1/payments", "POST", api.createPayment],
  ["/api/v1/payments", "GET", api.listPayments],
  ["/api/v1/payments/", "GET", api.getPayment, true],
  ["/api/v1/payments/", "POST", api.refundPayment, true],
  ["/api/v1/providers", "GET", api.listProviders],
  ["/api/v1/routing/simulate", "POST", api.simulateRouting],
  ["/api/v1/fx/quotes", "POST", api.createFxQuote],
  ["/api/v1/balance", "GET", api.getBalance],
  ["/api/v1/settlements", "GET", api.listSettlements],
  ["/api/v1/payouts", "POST", api.createPayout],
  ["/api/v1/payouts", "GET", api.listPayouts],
  ["/api/v1/customers", "GET", api.listCustomers],
  // Recurring billing
  ["/api/v1/payment_methods", "GET", api.listPaymentMethods],
  ["/api/v1/payment_methods", "POST", api.createPaymentMethod],
  ["/api/v1/payment_methods/", "POST", api.paymentMethodAction, true],
  ["/api/v1/plans", "GET", api.listPlans],
  ["/api/v1/plans", "POST", api.createPlan],
  ["/api/v1/recipients", "GET", api.listRecipients],
  ["/api/v1/recipients", "POST", api.createRecipient],
  ["/api/v1/recipients/", "GET", api.getRecipient, true],
  ["/api/v1/recipients/", "POST", api.recipientAction, true],
  ["/api/v1/subscriptions", "GET", api.listSubscriptions],
  ["/api/v1/subscriptions", "POST", api.createSubscription],
  ["/api/v1/subscriptions/", "GET", api.getSubscription, true],
  ["/api/v1/subscriptions/", "POST", api.subscriptionAction, true],
  // Payment links (public, link-scoped)
  ["/api/v1/checkout/", "GET", api.getLinkPublic, true],
  ["/api/v1/checkout/", "POST", api.checkoutWithLink, true],
  // Inbound provider webhooks (signature-verified per provider)
  ["/api/v1/webhooks/providers/", "POST", providerWebhook, true],
];

const preflight = new Set<string>();
for (const [path, method, handler, prefix] of routes) {
  if (prefix) http.route({ pathPrefix: path, method, handler });
  else http.route({ path, method, handler });
  const key = `${prefix ? "p" : "x"}:${path}`;
  if (!preflight.has(key)) {
    preflight.add(key);
    if (prefix) http.route({ pathPrefix: path, method: "OPTIONS", handler: api.corsHandler });
    else http.route({ path, method: "OPTIONS", handler: api.corsHandler });
  }
}

export default http;
