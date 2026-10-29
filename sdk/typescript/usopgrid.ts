// USOPGRID TypeScript client — zero dependencies, works in Node 18+, Bun,
// Deno and edge runtimes (uses fetch + Web Crypto).
//
//   const ug = new Usopgrid({ apiKey: "sk_sandbox_…", baseUrl: "https://…/api/v1" });
//   const p = await ug.payments.create({ amount: 1050, currency: "USD", payment_method: "card", country: "US" });
//
// - Every POST gets an Idempotency-Key (yours, or a generated one reused
//   across this call's retries), so retries can never double-charge.
// - Retryable failures (429, 409 in-progress, 503, 5xx, network) retry with
//   exponential backoff + jitter, honouring Retry-After.

export type PaymentMethod =
  | "card" | "bank_transfer" | "open_banking" | "mobile_money" | "ussd" | "wallet" | "qr"
  | "account_to_account" | "upi" | "pix" | "cash_voucher" | "bnpl" | "direct_debit";

export interface PaymentCreate {
  amount: number;
  currency: string;
  payment_method: PaymentMethod;
  country?: string;
  reference?: string;
  customer?: { email?: string; name?: string; phone?: string };
  payment_token?: string;
  return_url?: string;
  description?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface Payment {
  id: string;
  object: "payment";
  reference: string;
  status: string;
  amount: number;
  currency: string;
  payment_method: string;
  country: string | null;
  provider: string;
  provider_reference: string | null;
  fee: number | null;
  net: number | null;
  refunded_amount: number;
  attempts: number;
  failovers: number;
  outcome_unknown: boolean;
  next_action: { type: string; url?: string; instructions?: string } | null;
  failure: { category: string; code: string; message: string; retryable: boolean } | null;
  created_at: string;
  [extra: string]: unknown;
}

export class UsopgridError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "UsopgridError";
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type RequestOpts = { idempotencyKey?: string; requestId?: string };

export class Usopgrid {
  private readonly key: string;
  private readonly base: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly f: typeof fetch;

  constructor(o: ClientOptions) {
    if (!o.apiKey?.startsWith("sk_")) throw new Error("USOPGRID: a secret key (sk_…) is required");
    this.key = o.apiKey;
    this.base = o.baseUrl.replace(/\/$/, "");
    this.maxRetries = o.maxRetries ?? 3;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.f = o.fetch ?? fetch;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, opts: RequestOpts = {}): Promise<T> {
    const idem = method === "POST" ? (opts.idempotencyKey ?? `sdk_${crypto.randomUUID()}`) : undefined;
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await this.f(`${this.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
            ...(idem ? { "Idempotency-Key": idem } : {}),
            ...(opts.requestId ? { "X-Request-Id": opts.requestId } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        netErr = e;
      } finally {
        clearTimeout(timer);
      }
      const retryable = !res || res.status === 429 || res.status === 409 || res.status >= 500;
      if (res && res.ok) return ((await res.json()) as { data: T }).data;
      if (retryable && attempt < this.maxRetries && (method === "GET" || idem)) {
        const ra = Number(res?.headers.get("retry-after"));
        const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.random() * Math.min(8000, 500 * 2 ** attempt);
        attempt++;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (!res) throw new UsopgridError("network_error", netErr instanceof Error ? netErr.message : "network error", 0, true);
      const j = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; retryable: boolean }; requestId?: string };
      throw new UsopgridError(j.error?.code ?? "processing_error", j.error?.message ?? `HTTP ${res.status}`, res.status, j.error?.retryable ?? retryable, j.requestId);
    }
  }

  payments = {
    create: (p: PaymentCreate, o?: RequestOpts) => this.request<{ payment: Payment }>("POST", "/payments", p, { idempotencyKey: o?.idempotencyKey ?? (p.reference ? `pay_${p.reference}` : undefined), ...o }).then((r) => r.payment),
    retrieve: (id: string) => this.request<{ payment: Payment }>("GET", `/payments/${encodeURIComponent(id)}`).then((r) => r.payment),
    list: (q: { limit?: number; cursor?: string; status?: string; created_gte?: string; created_lte?: string } = {}) =>
      this.request<{ data: Payment[]; has_more: boolean; next_cursor: string | null }>("GET", `/payments?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
    refund: (id: string, r: { amount?: number; reason?: string } = {}, o?: RequestOpts) =>
      this.request<{ refund: { id: string; status: string }; payment: Payment }>("POST", `/payments/${encodeURIComponent(id)}/refund`, r, o),
  };

  routing = {
    simulate: (r: { amount: number; currency: string; payment_method: PaymentMethod; country?: string }) => this.request<{ explanation: string; chain: string[] }>("POST", "/routing/simulate", r),
  };

  fx = {
    quote: (q: { from: string; to: string; amount: number }) => this.request<{ quote: Record<string, unknown> }>("POST", "/fx/quotes", q).then((r) => r.quote),
  };

  providers = { list: () => this.request<{ data: unknown[] }>("GET", "/providers").then((r) => r.data) };
  balance = { retrieve: () => this.request<{ balances: unknown[] }>("GET", "/balance").then((r) => r.balances) };
}

/** Verify an X-USOPGRID-Signature header over the RAW body. */
export async function verifyWebhook(rawBody: string, header: string, secret: string, toleranceSec = 300, nowSec = Date.now() / 1000): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec || !parts.v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${rawBody}`)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
