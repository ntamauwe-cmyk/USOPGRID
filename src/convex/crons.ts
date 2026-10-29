import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const c = cronJobs();

// Outbound merchant webhooks: signed, retried with backoff, dead-lettered.
c.interval("dispatch-webhooks", { minutes: 1 }, internal.webhooks.dispatchDue, {});

// Recovery queue: resolve unknown / pending provider outcomes by status lookup.
c.interval("recover-provider-outcomes", { minutes: 1 }, internal.recovery.runDue, {});

// Payouts in flight: resolve by status lookup at the same provider (never re-send).
c.interval("recover-payouts", { minutes: 2 }, internal.payouts.recoverPayouts, {});

// FX reference rates.
c.interval("refresh-fx-rates", { hours: 1 }, internal.fxrates.refreshRatesInternal, {});

// Idempotency records expire after 24 h.
c.interval("purge-idempotency-keys", { hours: 1 }, internal.lib.idempotency.purgeExpiredInternal, {});

// Approval requests older than 72 h can no longer be approved.
c.interval("expire-approvals", { hours: 1 }, internal.approvals.expireStale, {});

// Expired throttle counters.
c.interval("purge-rate-buckets", { hours: 1 }, internal.lib.httpserviceInternal.purgeBucketsInternal, {});

// Anomaly detection over provider/merchant performance.
c.interval("detect-anomalies", { minutes: 15 }, internal.analytics.detectAnomaliesInternal, {});

export default c;
