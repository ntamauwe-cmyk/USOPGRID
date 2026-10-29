// USOPGRID provider contract.
//
// The orchestration engine only ever talks to this interface. Adding a new
// processor = one file implementing ProviderAdapter + one line in the
// registry. Nothing in the payment engine, router, API or UI changes.

export const PAYMENT_METHODS = [
  "card",
  "bank_transfer",
  "open_banking",
  "mobile_money",
  "ussd",
  "wallet",
  "qr",
  "account_to_account",
  "upi",
  "pix",
  "cash_voucher",
  "bnpl",
  "direct_debit",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  card: "Cards",
  bank_transfer: "Bank transfer",
  open_banking: "Open banking",
  mobile_money: "Mobile money",
  ussd: "USSD",
  wallet: "Digital wallets",
  qr: "QR payments",
  account_to_account: "Account-to-account",
  upi: "UPI",
  pix: "Pix",
  cash_voucher: "Cash vouchers",
  bnpl: "Buy now, pay later",
  direct_debit: "Direct debit",
};

export type FailureCategory =
  | "timeout"
  | "temporary_provider_failure"
  | "network_error"
  | "issuer_decline"
  | "insufficient_funds"
  | "invalid_payment_information"
  | "fraud_rejection"
  | "provider_outage"
  | "customer_cancellation"
  | "configuration_error"
  | "rate_limited"
  | "compliance_block"
  | "unsupported";

export interface FailureInfo {
  category: FailureCategory;
  code: string;
  message: string;
  /** May the SAME instruction be retried (same provider, same idempotency key)? */
  retryable: boolean;
  /**
   * Is it certain the provider did NOT accept the instruction, so a DIFFERENT
   * provider may be tried without risk of charging the customer twice?
   */
  safeToFailover: boolean;
  /** Raw provider code for diagnostics. */
  providerCode?: string;
}

export interface NextAction {
  type: "redirect" | "display_instructions" | "await_customer_confirmation";
  url?: string;
  instructions?: string;
  expiresAt?: number;
}

export interface ChargeRequest {
  transactionId: string;
  /** Provider-side idempotency key; stable per (transaction, provider). */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  reference: string;
  paymentMethod: string;
  country?: string;
  customer?: { email?: string; name?: string; phone?: string; document?: string };
  /** Opaque token from a provider-hosted field / SDK. Raw PANs never enter USOPGRID. */
  paymentToken?: string;
  returnUrl?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /**
   * Merchant-initiated charge of a saved payment method (subscription
   * renewal): `paymentToken` is the provider's reusable token and no customer
   * is present.
   */
  recurring?: boolean;
  /** Ask the provider to keep the payment method for future charges. */
  savePaymentMethod?: boolean;
}

/** A provider-issued reusable token plus safe display details. Never a card number. */
export interface ReusableToken {
  token: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export type ChargeStatus = "successful" | "pending" | "requires_action" | "declined" | "failed" | "unknown";

export interface ChargeResult {
  status: ChargeStatus;
  providerReference?: string;
  nextAction?: NextAction;
  failure?: FailureInfo;
  /** Provider's processing fee if returned synchronously (minor units of txn currency). */
  providerFeeMinor?: number;
  /** Provider's own status string, for the event timeline. */
  providerStatus?: string;
  /** Amount/currency the provider says it actually processed — checked against our record. */
  reportedAmountMinor?: number;
  reportedCurrency?: string;
  /** Present when the provider returned a reusable token synchronously. */
  reusableToken?: ReusableToken;
}

export interface StatusQuery {
  transactionId: string;
  reference: string;
  providerReference?: string;
  currency: string;
}

export interface RefundRequest {
  transactionId: string;
  refundId: string;
  idempotencyKey: string;
  providerReference?: string;
  reference: string;
  amountMinor: number;
  currency: string;
  reason?: string;
}

export interface RefundResult {
  status: "successful" | "pending" | "failed" | "unknown";
  providerRefundReference?: string;
  failure?: FailureInfo;
}

export interface PayoutBeneficiary {
  name: string;
  /** Full account number / wallet number, decrypted only inside the payout action. */
  accountNumber: string;
  bankCode?: string;
  bankName?: string;
  /** ISO 3166-1 alpha-2 of the receiving account. */
  country?: string;
  type: "bank_account" | "mobile_money";
}

export interface PayoutRequest {
  payoutId: string;
  /** Stable per payout + connection; providers de-duplicate on it. ≥16 chars. */
  reference: string;
  amountMinor: number;
  currency: string;
  narration?: string;
  beneficiary: PayoutBeneficiary;
  metadata?: Record<string, unknown>;
}

export interface PayoutResult {
  status: "successful" | "pending" | "failed" | "unknown";
  providerReference?: string;
  providerStatus?: string;
  failure?: FailureInfo;
}

/** Provider event normalized from an inbound webhook. */
export interface ProviderEvent {
  /** Provider's unique event id — used for duplicate suppression. */
  eventId: string;
  type: "payment" | "refund" | "dispute" | "payout" | "other";
  status?: ChargeStatus | "refunded" | "partially_refunded" | "dispute_opened" | "dispute_won" | "dispute_lost" | "payout_successful" | "payout_failed" | "payout_reversed";
  providerReference?: string;
  /** Our reference / transactionId if the provider echoes it back. */
  reference?: string;
  amountMinor?: number;
  currency?: string;
  occurredAt?: number;
  failure?: FailureInfo;
  rawType: string;
  /** Reusable token delivered with a successful payment (e.g. Paystack authorization). */
  reusableToken?: ReusableToken;
}

export interface WebhookInput {
  headers: Headers;
  rawBody: string;
  url: string;
}

export type Environment = "sandbox" | "production";

export interface AdapterContext {
  environment: Environment;
  credentials: Record<string, string>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** Public base URL providers call back to (webhooks, redirects). */
  callbackBaseUrl?: string;
  /** Connection id, embedded in callback URLs so inbound events find their credentials. */
  connectionId?: string;
  timeoutMs?: number;
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help?: string;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  category: "global_acquirer" | "regional_psp" | "emerging_markets" | "mobile_money" | "open_banking" | "sandbox";
  description: string;
  website: string;
  docsUrl: string;
  /** ISO 3166 alpha-2 codes where payers can be served, or "global". */
  countries: readonly string[] | "global";
  /** ISO 4217 codes accepted for presentment, or "all". */
  currencies: readonly string[] | "all";
  methods: readonly PaymentMethod[];
  operations: {
    charge: boolean;
    status: boolean;
    refund: boolean;
    partialRefund: boolean;
    webhooks: boolean;
    settlementReports: boolean;
    /** Can send money to third-party bank / mobile-money accounts. */
    payouts?: boolean;
    /** Merchant-initiated charges of saved payment methods (subscriptions). */
    recurring?: boolean;
  };
  /** Currencies this provider can pay out in (when operations.payouts). */
  payoutCurrencies?: readonly string[];
  /** Optional per-currency bounds in minor units. */
  limits?: Record<string, { minMinor?: number; maxMinor?: number }>;
  /** Published list pricing used for cost-aware routing until real costs are observed. */
  /** capMinor: maximum fee per transaction, in fixedCurrency minor units (e.g. Paystack ₦2,000). */
  pricing: { pctBps: number; fixedMinor: number; fixedCurrency: string; notes: string; capMinor?: number };
  credentials: readonly CredentialField[];
  /** Env-var names for platform-level credentials (e.g. STRIPE_SECRET_KEY). */
  envCredentials: Record<string, string>;
}

export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  charge(ctx: AdapterContext, req: ChargeRequest): Promise<ChargeResult>;
  getStatus(ctx: AdapterContext, q: StatusQuery): Promise<ChargeResult>;
  refund(ctx: AdapterContext, req: RefundRequest): Promise<RefundResult>;
  verifyWebhook(ctx: AdapterContext, input: WebhookInput): Promise<boolean>;
  parseWebhook(ctx: AdapterContext, input: WebhookInput): ProviderEvent[];
  /** Send money to a third-party account (only when descriptor.operations.payouts). */
  payout?(ctx: AdapterContext, req: PayoutRequest): Promise<PayoutResult>;
  /** Look up a payout by our reference (and provider reference when known). */
  getPayoutStatus?(ctx: AdapterContext, q: { reference: string; providerReference?: string; currency: string }): Promise<PayoutResult>;
}

export class ProviderUnavailableError extends Error {}

export function failure(
  category: FailureCategory,
  code: string,
  message: string,
  opts: { retryable?: boolean; safeToFailover?: boolean; providerCode?: string } = {},
): FailureInfo {
  return {
    category,
    code,
    message,
    retryable: opts.retryable ?? false,
    safeToFailover: opts.safeToFailover ?? false,
    providerCode: opts.providerCode,
  };
}

/** Is the payer country / currency / method / amount inside this provider's declared envelope? */
export function descriptorSupports(
  d: ProviderDescriptor,
  q: { country?: string; currency: string; method: string; amountMinor: number },
): { ok: true } | { ok: false; reason: string } {
  if (!d.methods.includes(q.method as PaymentMethod)) return { ok: false, reason: `method ${q.method} not supported` };
  if (d.currencies !== "all" && !d.currencies.includes(q.currency)) {
    return { ok: false, reason: `currency ${q.currency} not supported` };
  }
  if (q.country && d.countries !== "global" && !d.countries.includes(q.country)) {
    return { ok: false, reason: `country ${q.country} not served` };
  }
  const lim = d.limits?.[q.currency];
  if (lim?.minMinor !== undefined && q.amountMinor < lim.minMinor) return { ok: false, reason: `below minimum ${lim.minMinor}` };
  if (lim?.maxMinor !== undefined && q.amountMinor > lim.maxMinor) return { ok: false, reason: `above maximum ${lim.maxMinor}` };
  return { ok: true };
}
