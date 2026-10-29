// USOPGRID public HTTP service layer.
// Standardized response envelopes, error taxonomy, CORS, rate limiting,
// correlation ids and API-key authentication. Every /api/v1 handler composes
// these helpers.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { sha256Hex, timingSafeEqual } from "./crypto";

// ---------------------------------------------------------------------------
// Response envelopes — consistent, predictable
// ---------------------------------------------------------------------------
export const API_VERSION = "2026-10-01";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Correlation-Id, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "X-USOPGRID-Request-Id, X-Correlation-Id, Retry-After, USOPGRID-Version",
};

function baseHeaders(requestId?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "USOPGRID-Version": API_VERSION,
    ...(requestId ? { "X-USOPGRID-Request-Id": requestId, "X-Correlation-Id": requestId } : {}),
    ...CORS_HEADERS,
  };
}

export function jsonOk(body: unknown, status = 200, requestId?: string): Response {
  return new Response(JSON.stringify({ status: "success", requestId, data: body }), { status, headers: baseHeaders(requestId) });
}

export type ApiErrorCode =
  | "authentication_error"
  | "authorization_error"
  | "validation_error"
  | "conflict"
  | "not_found"
  | "idempotency_conflict"
  | "provider_unavailable"
  | "rate_limited"
  | "processing_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  authentication_error: 401,
  authorization_error: 403,
  validation_error: 422,
  conflict: 409,
  not_found: 404,
  idempotency_conflict: 422,
  provider_unavailable: 503,
  rate_limited: 429,
  processing_error: 500,
};

export class ApiError extends Error {
  code: ApiErrorCode;
  retryable: boolean;
  retryAfterSec?: number;
  details?: unknown;
  constructor(code: ApiErrorCode, message: string, retryable = false, opts: { retryAfterSec?: number; details?: unknown } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSec = opts.retryAfterSec;
    this.details = opts.details;
  }
}

export function jsonError(err: ApiError, requestId?: string): Response {
  return new Response(
    JSON.stringify({
      status: "error",
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        ...(err.details !== undefined ? { details: err.details } : {}),
        doc_url: `https://usopgrid.com/developers#errors-${err.code}`,
      },
      requestId,
    }),
    {
      status: STATUS_BY_CODE[err.code],
      headers: { ...baseHeaders(requestId), ...(err.retryAfterSec ? { "Retry-After": String(err.retryAfterSec) } : {}) },
    },
  );
}

export function handleApiError(err: unknown, requestId?: string): Response {
  if (err instanceof ApiError) return jsonError(err, requestId);
  // ConvexError (from engine mutations) — map to validation errors.
  const message = err instanceof Error ? err.message : "Internal processing error";
  const m = /(VALIDATION_ERROR|CONFLICT|FORBIDDEN|NOT_FOUND|FX_UNAVAILABLE)/.exec(message);
  if (m && m.index > 0) return handleApiError(new Error(message.slice(m.index)), requestId);
  if (message.startsWith("VALIDATION_ERROR")) {
    return jsonError(new ApiError("validation_error", message.replace("VALIDATION_ERROR: ", "")), requestId);
  }
  if (message.startsWith("CONFLICT")) {
    return jsonError(new ApiError("conflict", message.replace("CONFLICT: ", "")), requestId);
  }
  if (message.startsWith("FORBIDDEN")) {
    return jsonError(new ApiError("authorization_error", message), requestId);
  }
  if (message.startsWith("NOT_FOUND")) {
    return jsonError(new ApiError("not_found", message.replace(/^NOT_FOUND:?\s*/, "")), requestId);
  }
  if (message.startsWith("FX_UNAVAILABLE")) {
    return jsonError(new ApiError("provider_unavailable", message.replace("FX_UNAVAILABLE: ", ""), true, { retryAfterSec: 60 }), requestId);
  }
  // Never leak stack traces.
  console.error("[api] unhandled error:", message);
  return jsonError(new ApiError("processing_error", "Internal processing error"), requestId);
}

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" } });
}

// ---------------------------------------------------------------------------
// Rate limiting — per-key fixed window, stored in the database.
// 120 requests per minute per key (see httpserviceInternal).
// ---------------------------------------------------------------------------

// Consume one rate-limit token for a key. Atomic server-side (see
// consumeRateLimitInternal); fail-open on limiter infrastructure errors so
// an internal blip can never 500 genuine financial traffic — the provider
// call and financial engine remain fully protected by their own guards.
export async function checkRateLimit(ctx: ActionCtx, apiKeyId: string): Promise<void> {
  try {
    const result = (await ctx.runMutation(internal.lib.httpserviceInternal.consumeRateLimitInternal, {
      apiKeyId: apiKeyId as never,
    })) as { ok: boolean; retryAfterMs: number } | undefined;
    if (result && !result.ok) {
      throw new ApiError("rate_limited", "Rate limit exceeded. Retry shortly.", true, { retryAfterSec: Math.ceil(result.retryAfterMs / 1000) });
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error("rate limiter unavailable, failing open", {
      apiKeyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// API key authentication
// ---------------------------------------------------------------------------
export interface AuthedKey {
  keyId: string;
  orgId: string;
  environment: "sandbox" | "production";
  mode: "secret" | "publishable";
  prefix: string;
}

export async function authenticateRequest(
  ctx: ActionCtx,
  request: Request,
): Promise<AuthedKey> {
  const header = request.headers.get("Authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1];
  const xKey = request.headers.get("x-api-key");
  const presented = bearer ?? xKey;
  if (!presented) {
    throw new ApiError("authentication_error", "Missing API key. Pass 'Authorization: Bearer <key>' or 'x-api-key'.");
  }

  const hash = await sha256Hex(presented.trim());
  const key = await ctx.runQuery(internal.payments.apiKeyByHash, { hash });
  if (!key) {
    throw new ApiError("authentication_error", "Invalid or revoked API key.");
  }
  if (key.mode !== "secret") {
    throw new ApiError("authorization_error", "Publishable keys cannot authenticate server-side requests. Use a secret key.");
  }

  await checkRateLimit(ctx, key._id);

  return {
    keyId: key._id,
    orgId: key.orgId,
    environment: key.environment,
    mode: key.mode,
    prefix: key.prefix,
  };
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("validation_error", "Request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("validation_error", "Request body must be valid JSON.");
  }
}

/** Correlation id: honour a caller-supplied X-Request-Id / X-Correlation-Id (sanitized), else mint one. */
export function requestIdFrom(request: Request): string {
  const supplied = request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id");
  if (supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied)) return supplied;
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export { timingSafeEqual };
