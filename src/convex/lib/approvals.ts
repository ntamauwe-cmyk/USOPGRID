// Two-person approval ("maker-checker") policy, pure and tested.

export type PayoutApprovalMode = "off" | "all" | "above";
export interface ApprovalPolicy {
  payouts: PayoutApprovalMode;
  /** Whole US dollars; payouts at or above this USD value need a second approver (mode "above"). */
  payoutThresholdUsd?: number;
}

export const DEFAULT_POLICY: ApprovalPolicy = { payouts: "off" };

/** Does a payout of this USD value (minor units, null = unknown) need approval? Unknown value fails safe. */
export function payoutNeedsApproval(policy: ApprovalPolicy | undefined, usdMinor: number | null): boolean {
  const p = policy ?? DEFAULT_POLICY;
  if (p.payouts === "off") return false;
  if (p.payouts === "all") return true;
  if (usdMinor === null) return true;
  return usdMinor >= Math.round((p.payoutThresholdUsd ?? 0) * 100);
}

/** Bulk payouts follow the same switch: any non-off policy requires approval of the whole batch. */
export function bulkNeedsApproval(policy: ApprovalPolicy | undefined): boolean {
  return (policy ?? DEFAULT_POLICY).payouts !== "off";
}

function strictness(p: ApprovalPolicy): [number, number] {
  // Higher is stricter. For "above", a LOWER threshold is stricter.
  if (p.payouts === "all") return [2, 0];
  if (p.payouts === "above") return [1, -(p.payoutThresholdUsd ?? 0)];
  return [0, 0];
}

/** True if moving from `current` to `next` weakens the control (needs a second approver). */
export function isLoosening(current: ApprovalPolicy | undefined, next: ApprovalPolicy): boolean {
  const [a1, a2] = strictness(current ?? DEFAULT_POLICY);
  const [b1, b2] = strictness(next);
  return b1 < a1 || (b1 === a1 && b2 < a2);
}

export function validatePolicy(p: ApprovalPolicy): string | null {
  if (p.payouts === "above") {
    const t = p.payoutThresholdUsd;
    if (t === undefined || !Number.isFinite(t) || t <= 0 || t > 1e9) return "Enter a threshold in US dollars greater than zero.";
  }
  return null;
}

export function describePolicy(p: ApprovalPolicy | undefined): string {
  const q = p ?? DEFAULT_POLICY;
  if (q.payouts === "all") return "Every payout needs a second approver";
  if (q.payouts === "above") return `Payouts of US$${(q.payoutThresholdUsd ?? 0).toLocaleString("en-US")} or more need a second approver`;
  return "Off";
}
