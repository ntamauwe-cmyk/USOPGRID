/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as analytics from "../analytics.js";
import type * as api_ from "../api.js";
import type * as apiInternal from "../apiInternal.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as connections from "../connections.js";
import type * as contact from "../contact.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as disputes from "../disputes.js";
import type * as fxrates from "../fxrates.js";
import type * as github from "../github.js";
import type * as http from "../http.js";
import type * as keyRotation from "../keyRotation.js";
import type * as lib_analytics from "../lib/analytics.js";
import type * as lib_apikeys from "../lib/apikeys.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_fees from "../lib/fees.js";
import type * as lib_fx from "../lib/fx.js";
import type * as lib_httpservice from "../lib/httpservice.js";
import type * as lib_httpserviceInternal from "../lib/httpserviceInternal.js";
import type * as lib_idempotency from "../lib/idempotency.js";
import type * as lib_ipallow from "../lib/ipallow.js";
import type * as lib_keyring from "../lib/keyring.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_openapi from "../lib/openapi.js";
import type * as lib_rbac from "../lib/rbac.js";
import type * as lib_recon from "../lib/recon.js";
import type * as lib_risk from "../lib/risk.js";
import type * as lib_sso from "../lib/sso.js";
import type * as notifications from "../notifications.js";
import type * as ops from "../ops.js";
import type * as orchestration_circuit from "../orchestration/circuit.js";
import type * as orchestration_compliance from "../orchestration/compliance.js";
import type * as orchestration_engine from "../orchestration/engine.js";
import type * as orchestration_retry from "../orchestration/retry.js";
import type * as orchestration_router from "../orchestration/router.js";
import type * as orchestration_states from "../orchestration/states.js";
import type * as orgs from "../orgs.js";
import type * as paylinks from "../paylinks.js";
import type * as payments from "../payments.js";
import type * as payouts from "../payouts.js";
import type * as providerWebhooks from "../providerWebhooks.js";
import type * as providerhealth from "../providerhealth.js";
import type * as providers from "../providers.js";
import type * as providers_adyen from "../providers/adyen.js";
import type * as providers_checkoutcom from "../providers/checkoutcom.js";
import type * as providers_dlocal from "../providers/dlocal.js";
import type * as providers_flutterwave from "../providers/flutterwave.js";
import type * as providers_http from "../providers/http.js";
import type * as providers_index from "../providers/index.js";
import type * as providers_mercadopago from "../providers/mercadopago.js";
import type * as providers_mpesa from "../providers/mpesa.js";
import type * as providers_paystack from "../providers/paystack.js";
import type * as providers_razorpay from "../providers/razorpay.js";
import type * as providers_sandbox from "../providers/sandbox.js";
import type * as providers_stripe from "../providers/stripe.js";
import type * as providers_types from "../providers/types.js";
import type * as providers_xendit from "../providers/xendit.js";
import type * as queries from "../queries.js";
import type * as reconciliation from "../reconciliation.js";
import type * as recovery from "../recovery.js";
import type * as routing from "../routing.js";
import type * as security from "../security.js";
import type * as services from "../services.js";
import type * as servicesInternal from "../servicesInternal.js";
import type * as settlements from "../settlements.js";
import type * as signInOptions from "../signInOptions.js";
import type * as users from "../users.js";
import type * as webhooks from "../webhooks.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  analytics: typeof analytics;
  api: typeof api_;
  apiInternal: typeof apiInternal;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  connections: typeof connections;
  contact: typeof contact;
  crons: typeof crons;
  customers: typeof customers;
  disputes: typeof disputes;
  fxrates: typeof fxrates;
  github: typeof github;
  http: typeof http;
  keyRotation: typeof keyRotation;
  "lib/analytics": typeof lib_analytics;
  "lib/apikeys": typeof lib_apikeys;
  "lib/audit": typeof lib_audit;
  "lib/crypto": typeof lib_crypto;
  "lib/fees": typeof lib_fees;
  "lib/fx": typeof lib_fx;
  "lib/httpservice": typeof lib_httpservice;
  "lib/httpserviceInternal": typeof lib_httpserviceInternal;
  "lib/idempotency": typeof lib_idempotency;
  "lib/ipallow": typeof lib_ipallow;
  "lib/keyring": typeof lib_keyring;
  "lib/ledger": typeof lib_ledger;
  "lib/openapi": typeof lib_openapi;
  "lib/rbac": typeof lib_rbac;
  "lib/recon": typeof lib_recon;
  "lib/risk": typeof lib_risk;
  "lib/sso": typeof lib_sso;
  notifications: typeof notifications;
  ops: typeof ops;
  "orchestration/circuit": typeof orchestration_circuit;
  "orchestration/compliance": typeof orchestration_compliance;
  "orchestration/engine": typeof orchestration_engine;
  "orchestration/retry": typeof orchestration_retry;
  "orchestration/router": typeof orchestration_router;
  "orchestration/states": typeof orchestration_states;
  orgs: typeof orgs;
  paylinks: typeof paylinks;
  payments: typeof payments;
  payouts: typeof payouts;
  providerWebhooks: typeof providerWebhooks;
  providerhealth: typeof providerhealth;
  providers: typeof providers;
  "providers/adyen": typeof providers_adyen;
  "providers/checkoutcom": typeof providers_checkoutcom;
  "providers/dlocal": typeof providers_dlocal;
  "providers/flutterwave": typeof providers_flutterwave;
  "providers/http": typeof providers_http;
  "providers/index": typeof providers_index;
  "providers/mercadopago": typeof providers_mercadopago;
  "providers/mpesa": typeof providers_mpesa;
  "providers/paystack": typeof providers_paystack;
  "providers/razorpay": typeof providers_razorpay;
  "providers/sandbox": typeof providers_sandbox;
  "providers/stripe": typeof providers_stripe;
  "providers/types": typeof providers_types;
  "providers/xendit": typeof providers_xendit;
  queries: typeof queries;
  reconciliation: typeof reconciliation;
  recovery: typeof recovery;
  routing: typeof routing;
  security: typeof security;
  services: typeof services;
  servicesInternal: typeof servicesInternal;
  settlements: typeof settlements;
  signInOptions: typeof signInOptions;
  users: typeof users;
  webhooks: typeof webhooks;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
