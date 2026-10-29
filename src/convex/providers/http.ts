// Shared outbound HTTP for provider adapters: timeouts, latency capture and
// outcome classification. Adapters never call fetch directly.

import type { AdapterContext, FailureInfo } from "./types";
import { failure } from "./types";

export type HttpOutcome =
  | { kind: "response"; status: number; json: unknown; text: string; headers: Headers; latencyMs: number }
  | { kind: "timeout"; latencyMs: number }
  | { kind: "network"; message: string; latencyMs: number };

export const DEFAULT_TIMEOUT_MS = 20_000;

export async function providerFetch(
  ctx: AdapterContext,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<HttpOutcome> {
  const started = ctx.now();
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await ctx.fetch(url, {
      method: init.method,
      headers: { "User-Agent": "USOPGRID/2.0 (+https://usopgrid.com)", ...(init.headers ?? {}) },
      body: init.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { kind: "response", status: res.status, json, text, headers: res.headers, latencyMs: ctx.now() - started };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    if (aborted) return { kind: "timeout", latencyMs: ctx.now() - started };
    return { kind: "network", message: err instanceof Error ? err.message : String(err), latencyMs: ctx.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a non-2xx / transport outcome for a MONEY-MOVING request.
 *
 * Timeouts, transport errors and 5xx are AMBIGUOUS: the provider may have
 * accepted the instruction. They return null so the caller records the
 * charge as "unknown" and the recovery queue resolves it by status lookup —
 * never by sending the instruction to a second provider.
 *
 * 401/403/404-route/400-validation/429 mean the request was refused before
 * processing: safe to fail over.
 */
export function classifyHttpFailure(o: HttpOutcome, providerName: string): FailureInfo | null {
  if (o.kind === "timeout" || o.kind === "network") return null;
  const s = o.status;
  if (s === 401 || s === 403) {
    return failure("configuration_error", "provider_auth_failed", `${providerName} rejected the credentials (HTTP ${s}).`, {
      safeToFailover: true,
      providerCode: String(s),
    });
  }
  if (s === 429) {
    return failure("rate_limited", "provider_rate_limited", `${providerName} rate-limited the request.`, {
      retryable: true,
      safeToFailover: true,
      providerCode: "429",
    });
  }
  if (s >= 500) return null;
  if (s >= 400) {
    return failure("invalid_payment_information", "provider_request_rejected", `${providerName} rejected the request (HTTP ${s}).`, {
      safeToFailover: true,
      providerCode: String(s),
    });
  }
  return null;
}

export function unknownOutcome(o: HttpOutcome, providerName: string): FailureInfo {
  const msg =
    o.kind === "timeout"
      ? `${providerName} did not respond in time; outcome unknown — resolving via status lookup.`
      : o.kind === "network"
        ? `Network error talking to ${providerName} (${o.message}); outcome unknown — resolving via status lookup.`
        : `${providerName} returned HTTP ${o.status}; outcome unknown — resolving via status lookup.`;
  return failure(o.kind === "timeout" ? "timeout" : o.kind === "network" ? "network_error" : "temporary_provider_failure", "outcome_unknown", msg, {
    retryable: true,
    safeToFailover: false,
  });
}

export function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof val === "object" && !Array.isArray(val)) {
      parts.push(formEncode(val as Record<string, unknown>, key));
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (typeof item === "object" && item !== null) parts.push(formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export function requireCredential(ctx: AdapterContext, key: string, providerName: string): string {
  const val = ctx.credentials[key];
  if (!val) throw new Error(`${providerName}: missing credential '${key}'`);
  return val;
}

export function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function str(obj: unknown, path: string): string | undefined {
  const v = get(obj, path);
  return v === undefined || v === null ? undefined : String(v);
}

export function callbackUrl(ctx: AdapterContext, providerId: string): string | undefined {
  if (!ctx.callbackBaseUrl) return undefined;
  const conn = ctx.connectionId ?? `platform-${providerId}`;
  return `${ctx.callbackBaseUrl.replace(/\/$/, "")}/api/v1/webhooks/providers/${encodeURIComponent(conn)}`;
}
