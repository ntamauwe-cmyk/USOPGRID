// Marketplace split payments — pure allocation rules (no I/O, unit-tested).
//
// A payment may name up to MAX_SPLITS recipients. Each share is a fixed
// amount of minor units or a percentage (up to two decimals) of the payment
// amount. Percentages round down; whatever is not allocated stays with the
// merchant. Shares come out of the merchant's net (after USOPGRID fees), so
// the merchant — the platform — bears processing fees.
//
// Refunds reverse shares in proportion, computed cumulatively so a series of
// partial refunds reverses exactly the full share once the payment is fully
// refunded, with no drift from rounding.

export const MAX_SPLITS = 10;

export interface SplitInput {
  recipient: string;
  amount?: number;
  percent?: number;
}

export interface ResolvedShare {
  recipient: string;
  amountMinor: number;
  percentBps?: number;
}

export class SplitError extends Error {}

/** Parse the untrusted `splits` request field. */
export function parseSplitInputs(raw: unknown): SplitInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new SplitError("splits must be an array.");
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_SPLITS) throw new SplitError(`splits supports at most ${MAX_SPLITS} recipients.`);
  return raw.map((s, i) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) throw new SplitError(`splits[${i}] must be an object.`);
    const o = s as Record<string, unknown>;
    const recipient = o.recipient ?? o.recipient_id;
    if (typeof recipient !== "string" || !/^rcp_[a-z0-9]{6,40}$/.test(recipient)) throw new SplitError(`splits[${i}].recipient must be a recipient id (rcp_…).`);
    const amount = o.amount;
    const percent = o.percent;
    if ((amount === undefined) === (percent === undefined)) throw new SplitError(`splits[${i}] needs exactly one of amount or percent.`);
    if (amount !== undefined && typeof amount !== "number") throw new SplitError(`splits[${i}].amount must be a number.`);
    if (percent !== undefined && typeof percent !== "number") throw new SplitError(`splits[${i}].percent must be a number.`);
    return { recipient, amount: amount as number | undefined, percent: percent as number | undefined };
  });
}

/**
 * Turn requested shares into exact minor-unit amounts.
 * `maxTotalMinor` is the most that may be shared out (the merchant's
 * expected net); the remainder stays with the merchant.
 */
export function resolveShares(inputs: SplitInput[], amountMinor: number, maxTotalMinor: number): ResolvedShare[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new SplitError("amount must be a positive integer.");
  const seen = new Set<string>();
  const out: ResolvedShare[] = [];
  for (const [i, s] of inputs.entries()) {
    if (seen.has(s.recipient)) throw new SplitError(`Recipient ${s.recipient} appears more than once in splits.`);
    seen.add(s.recipient);
    if (s.amount !== undefined) {
      if (!Number.isSafeInteger(s.amount) || s.amount <= 0) throw new SplitError(`splits[${i}].amount must be a positive integer of minor units.`);
      out.push({ recipient: s.recipient, amountMinor: s.amount });
    } else {
      const p = s.percent as number;
      const bps = Math.round(p * 100);
      if (!Number.isFinite(p) || p <= 0 || p > 100 || Math.abs(bps - p * 100) > 1e-6) {
        throw new SplitError(`splits[${i}].percent must be above 0 and at most 100, with up to two decimals.`);
      }
      const share = Math.floor((amountMinor * bps) / 10_000);
      if (share <= 0) throw new SplitError(`splits[${i}] works out to less than one minor unit.`);
      out.push({ recipient: s.recipient, amountMinor: share, percentBps: bps });
    }
  }
  const total = out.reduce((n, s) => n + s.amountMinor, 0);
  if (total > maxTotalMinor) {
    throw new SplitError(`Shares total ${total}, more than the ${maxTotalMinor} available after fees on this payment.`);
  }
  return out;
}

/**
 * Cap shares to what is actually available at capture (fees can differ
 * slightly from the estimate). Allocates in order; returns the shortfall.
 */
export function capShares<T extends { amountMinor: number }>(shares: T[], availableMinor: number): { shares: (T & { allocatedMinor: number })[]; shortfallMinor: number } {
  let left = Math.max(0, availableMinor);
  let shortfall = 0;
  const outShares = shares.map((s) => {
    const allocatedMinor = Math.min(s.amountMinor, left);
    left -= allocatedMinor;
    shortfall += s.amountMinor - allocatedMinor;
    return { ...s, allocatedMinor };
  });
  return { shares: outShares, shortfallMinor: shortfall };
}

/**
 * How much of each share to reverse for one refund.
 * `refundedBefore` is what had been refunded before this refund.
 */
export function refundReversals(
  shares: { allocatedMinor: number }[],
  paymentMinor: number,
  refundedBefore: number,
  refundMinor: number,
): number[] {
  const after = Math.min(paymentMinor, refundedBefore + refundMinor);
  const before = Math.min(paymentMinor, refundedBefore);
  const target = (refunded: number, share: number) => (refunded >= paymentMinor ? share : Math.floor((share * refunded) / paymentMinor));
  return shares.map((s) => target(after, s.allocatedMinor) - target(before, s.allocatedMinor));
}
