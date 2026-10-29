import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

// Status colours are their own family (see --status-* in index.css), kept
// apart from brand navy and gold: green = done, orange = in flight,
// blue = processing, red = failed, violet = money returned, magenta = needs a
// human. Each pill also carries a dot so status never relies on colour alone.
const AMBER = "bg-status-pending-bg text-status-pending";
const BLUE = "bg-status-info-bg text-status-info";
const GREEN = "bg-status-success-bg text-status-success";
const RED = "bg-status-failed-bg text-status-failed";
const VIOLET = "bg-status-returned-bg text-status-returned";
const ORANGE = "bg-status-attention-bg text-status-attention";
const MUTED = "bg-muted text-muted-foreground";
const STATUS_STYLES: Record<string, string> = {
  CREATED: MUTED, VALIDATED: MUTED, ACCEPTED: BLUE, PROCESSING: BLUE, PENDING: AMBER,
  SUCCESSFUL: GREEN, FAILED: RED, DECLINED: RED, CANCELLED: MUTED, EXPIRED: MUTED,
  REFUND_PENDING: AMBER, PARTIALLY_REFUNDED: VIOLET, REFUNDED: VIOLET, REVERSED: VIOLET,
  DISPUTED: ORANGE, RECONCILIATION_EXCEPTION: ORANGE,
  CLEARED: GREEN, SETTLED: GREEN, EXPECTED: MUTED, PARTIALLY_SETTLED: AMBER, HELD: ORANGE,
  OPEN: ORANGE, AWAITING_EVIDENCE: AMBER, UNDER_REVIEW: BLUE, WON: GREEN, LOST: RED,
  delivered: GREEN, pending: AMBER, failed: RED, dead: RED, successful: GREEN, declined: RED, unknown: AMBER, requires_action: AMBER,
  active: GREEN, unverified: AMBER, error: RED, disabled: MUTED, revoked: MUTED,
  closed: GREEN, open: RED, half_open: AMBER, resolved: GREEN, acknowledged: BLUE, escalated: ORANGE,
};

export function StatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide",
        STATUS_STYLES[status] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[1.75rem] font-semibold leading-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <p className="mt-4 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Human-readable message from a Convex / network error (strips transport prefixes and internal codes). */
export function errorMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
  const data = (err as { data?: unknown })?.data;
  let msg = typeof data === "string" ? data : err instanceof Error ? err.message : fallback;
  msg = msg.replace(/^\[CONVEX [^\]]+\]\s*/, "").replace(/^(\[Request ID: [^\]]+\]\s*)?(Server Error\s*)?/, "");
  msg = msg.replace(/^Uncaught (Convex)?Error:\s*/, "").replace(/\s+at .*$/s, "").replace(/\s*Called by client$/, "");
  msg = msg.replace(/^(VALIDATION_ERROR|CONFLICT|NOT_FOUND|FORBIDDEN|UNAUTHENTICATED|FX_UNAVAILABLE|MFA_REQUIRED|MFA_STEP_UP|ILLEGAL_TRANSITION):\s*/, "");
  return msg.trim() || fallback;
}

export function isStepUpError(err: unknown): boolean {
  const data = (err as { data?: unknown })?.data;
  const text = `${typeof data === "string" ? data : ""} ${err instanceof Error ? err.message : ""}`;
  return /MFA_STEP_UP/.test(text);
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-display text-[1.7rem] font-semibold leading-tight tabular-nums", tone === "good" ? "text-status-success" : tone === "bad" ? "text-status-failed" : tone === "warn" ? "text-status-pending" : "text-heading")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}

export function NoAccess({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="text-sm font-semibold">You don't have access to {what}</p>
      <p className="mt-1 text-sm text-muted-foreground">Ask an organization owner or administrator to change your role.</p>
    </div>
  );
}

export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(digits)}%`);
