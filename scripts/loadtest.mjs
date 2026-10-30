#!/usr/bin/env node
// USOPGRID load test: measures throughput, latency and correctness of the
// payments API under sustained concurrent load. Zero dependencies (Node 18+).
//
//   USOPGRID_API_URL=https://<deployment>.convex.site/api/v1 \
//   USOPGRID_LOADTEST_KEY=sk_sandbox_... \
//   DURATION_S=120 CONCURRENCY=20 node scripts/loadtest.mjs
//
// Sandbox keys only: it refuses live keys so it can never move real money.
// Besides speed, it checks the guarantees that matter under load:
//   - replaying an Idempotency-Key returns the same payment (no duplicate)
//   - 10 simultaneous identical requests create exactly one payment
// Results print as Markdown (and go to the GitHub job summary when run in
// Actions) plus a JSON file for the record.

import { writeFileSync, appendFileSync } from "node:fs";

const API = (process.env.USOPGRID_API_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.USOPGRID_LOADTEST_KEY ?? "";
const DURATION_S = Math.min(Math.max(Number(process.env.DURATION_S ?? 60) || 60, 10), 900);
const CONCURRENCY = Math.min(Math.max(Number(process.env.CONCURRENCY ?? 10) || 10, 1), 200);
// USD by default so routing rules for real test providers (often NGN) do not
// send load-test traffic to Paystack or Flutterwave's test APIs.
const CURRENCY = (process.env.CURRENCY ?? "USD").toUpperCase();
const COUNTRY = (process.env.COUNTRY ?? (CURRENCY === "NGN" ? "NG" : "US")).toUpperCase();
const AMOUNT = Number(process.env.AMOUNT_MINOR ?? 2500);
const REPLAY_EVERY = 25; // every 25th request replays an earlier key

if (!/^(https:\/\/.+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/api\/v1$/.test(API)) fail("USOPGRID_API_URL must look like https://<deployment>.convex.site/api/v1");
if (!KEY.startsWith("sk_sandbox_")) fail("USOPGRID_LOADTEST_KEY must be a SANDBOX secret key (sk_sandbox_...). Live keys are refused.");

function fail(msg) {
  console.error(`loadtest: ${msg}`);
  process.exit(2);
}

const runId = `lt${Date.now().toString(36)}`;
const lat = [];
const codes = new Map();
const outcomes = new Map();
const errors = new Map();
const issued = []; // [idempotencyKey, paymentId]
let replayChecks = 0;
let replayFailures = 0;
let seq = 0;

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

async function pay(idemKey, reference) {
  const t0 = performance.now();
  let status = 0;
  let body = null;
  try {
    const res = await fetch(`${API}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Idempotency-Key": idemKey, "X-Request-Id": `${runId}-${idemKey}`.slice(0, 120) },
      body: JSON.stringify({
        amount: AMOUNT,
        currency: CURRENCY,
        payment_method: "card",
        country: COUNTRY,
        reference,
        customer: { email: `${reference}@loadtest.usopgrid.com` },
        metadata: { simulate: "success", load_test: runId },
      }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    bump(errors, err?.cause?.code ?? err?.name ?? "network_error");
  }
  return { ms: performance.now() - t0, status, body };
}

async function worker(deadline) {
  while (performance.now() < deadline) {
    const n = ++seq;
    if (n % REPLAY_EVERY === 0 && issued.length > 0) {
      // Idempotency under load: same key must return the same payment.
      const [k, id] = issued[Math.floor(Math.random() * issued.length)];
      const r = await pay(k, k); // identical body: must replay the original response
      replayChecks++;
      if (r.body?.data?.payment?.id !== id) replayFailures++;
      continue;
    }
    const k = `${runId}-${n}`;
    const r = await pay(k, k);
    lat.push(r.ms);
    bump(codes, r.status || "network");
    const p = r.body?.data?.payment;
    if (p) {
      bump(outcomes, p.status);
      issued.push([k, p.id]);
    } else if (r.body?.error?.code) bump(errors, r.body.error.code);
    if (r.status === 429) await new Promise((res) => setTimeout(res, 1000));
  }
}

async function concurrentDuplicates() {
  const k = `${runId}-dup`;
  const rs = await Promise.all(Array.from({ length: 10 }, () => pay(k, k)));
  const ids = new Set(rs.map((r) => r.body?.data?.payment?.id).filter(Boolean));
  const conflicts = rs.filter((r) => r.status === 409).length;
  return { distinctPayments: ids.size, retryableConflicts: conflicts };
}

function q(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const who = await fetch(`${API}/whoami`, { headers: { Authorization: `Bearer ${KEY}` } }).then((r) => r.json()).catch(() => null);
if (!who?.data) fail(`could not authenticate: ${JSON.stringify(who?.error ?? who)}`);
console.log(`USOPGRID load test ${runId}: ${CONCURRENCY} concurrent clients for ${DURATION_S}s against ${API} (key ${who.data.key}, limit ${who.data.rate_limit_per_minute ?? 120}/min)`);

const dup = await concurrentDuplicates();
const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(started + DURATION_S * 1000)));
const elapsed = (performance.now() - started) / 1000;

const sorted = [...lat].sort((a, b) => a - b);
const total = lat.length;
const created = [...outcomes.values()].reduce((a, b) => a + b, 0);
const ok2xx = [...codes].filter(([c]) => String(c).startsWith("2")).reduce((n, [, v]) => n + v, 0);
const result = {
  runId,
  at: new Date().toISOString(),
  api: API,
  key: who.data.key,
  rateLimitPerMinute: who.data.rate_limit_per_minute ?? 120,
  concurrency: CONCURRENCY,
  durationS: Math.round(elapsed),
  requests: total,
  requestsPerSecond: +(total / elapsed).toFixed(2),
  paymentsCreated: created,
  paymentsPerSecond: +(created / elapsed).toFixed(2),
  successRate2xx: total ? +(ok2xx / total).toFixed(4) : 0,
  latencyMs: { p50: Math.round(q(sorted, 50)), p95: Math.round(q(sorted, 95)), p99: Math.round(q(sorted, 99)), max: Math.round(sorted.at(-1) ?? 0) },
  httpStatus: Object.fromEntries(codes),
  paymentOutcomes: Object.fromEntries(outcomes),
  errors: Object.fromEntries(errors),
  idempotency: { replayChecks, replayFailures, concurrentDuplicate: dup },
};

const pass = replayFailures === 0 && dup.distinctPayments <= 1;
const md = [
  `## USOPGRID load test ${pass ? "✅" : "❌"}`,
  "",
  `${CONCURRENCY} concurrent clients for ${result.durationS} s against the **sandbox** environment (simulated provider, real USOPGRID engine: validation, risk, routing, ledger, events). Key \`${result.key}\`, rate limit ${result.rateLimitPerMinute}/min.`,
  "",
  "| Measure | Result |",
  "|---|---|",
  `| Requests | ${result.requests} (${result.requestsPerSecond}/s) |`,
  `| Payments created | ${result.paymentsCreated} (${result.paymentsPerSecond}/s) |`,
  `| 2xx responses | ${(result.successRate2xx * 100).toFixed(2)}% |`,
  `| Latency p50 / p95 / p99 / max | ${result.latencyMs.p50} / ${result.latencyMs.p95} / ${result.latencyMs.p99} / ${result.latencyMs.max} ms |`,
  `| HTTP status codes | ${Object.entries(result.httpStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"} |`,
  `| Payment outcomes | ${Object.entries(result.paymentOutcomes).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"} |`,
  `| Errors | ${Object.entries(result.errors).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"} |`,
  `| Idempotency replays under load | ${replayChecks - replayFailures}/${replayChecks} returned the original payment |`,
  `| 10 simultaneous identical requests | ${dup.distinctPayments} payment created (${dup.retryableConflicts} told to retry) |`,
  "",
  "Notes: 429 means the key's rate limit was reached (raise it in the Operations console for load tests). Payments marked for review come from the risk engine's burst rule, which is working as designed. Latency includes the network between the test runner and the API.",
].join("\n");

console.log(md);
writeFileSync(process.env.RESULT_FILE ?? `loadtest-${runId}.json`, JSON.stringify(result, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
process.exit(pass ? 0 : 1);
