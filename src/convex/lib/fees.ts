// USOPGRID fee engine. Separate from payment logic.
// All arithmetic in integer minor units — never floats.

import type { Doc } from "../_generated/dataModel";

export interface FeeBreakdown {
  feeMinor: number;
  /** Always the transaction currency: every amount here is in its minor units. */
  currency: string;
  netMinor: number;
  /** Parts of the fee, for display / audit. */
  parts: { label: string; amountMinor: number }[];
  /** Set when a fixed fee priced in another currency could not be converted. */
  fixedFeeUnconverted?: { amountMinor: number; currency: string };
}

/**
 * fee = round_half_up(amount × feeBps / 10 000) + fixed
 *
 * The fixed component is charged only when it can be expressed exactly in the
 * transaction currency: either the merchant priced it in that currency, or the
 * caller passes `fixedFeeInTxnMinor` converted through the FX engine. A USD
 * fixed fee is NEVER reinterpreted as the same number of kobo or yen.
 */
export function computeFees(
  merchant: Doc<"merchants">,
  amountMinor: number,
  currency: string,
  opts: { fixedFeeInTxnMinor?: number } = {},
): FeeBreakdown {
  const feeCurrency = merchant.feeCurrency ?? currency;
  const parts: { label: string; amountMinor: number }[] = [];

  const pctMinor = Math.round((amountMinor * merchant.feeBps) / 10_000);
  if (pctMinor > 0) {
    parts.push({ label: `${(merchant.feeBps / 100).toFixed(2)}%`, amountMinor: pctMinor });
  }

  let fixedMinor = 0;
  let unconverted: FeeBreakdown["fixedFeeUnconverted"];
  if (merchant.feeFixedMinor > 0) {
    if (feeCurrency === currency) {
      fixedMinor = merchant.feeFixedMinor;
    } else if (opts.fixedFeeInTxnMinor !== undefined) {
      fixedMinor = opts.fixedFeeInTxnMinor;
    } else {
      unconverted = { amountMinor: merchant.feeFixedMinor, currency: feeCurrency };
    }
    if (fixedMinor > 0) parts.push({ label: "fixed", amountMinor: fixedMinor });
  }

  const feeMinor = pctMinor + fixedMinor;
  return {
    feeMinor,
    currency,
    netMinor: amountMinor - feeMinor,
    parts,
    ...(unconverted ? { fixedFeeUnconverted: unconverted } : {}),
  };
}

/** Fixed fee to convert through FX before calling computeFees, if any. */
export function fixedFeeNeedingConversion(merchant: Doc<"merchants">, currency: string): { amountMinor: number; currency: string } | null {
  const feeCurrency = merchant.feeCurrency ?? currency;
  return merchant.feeFixedMinor > 0 && feeCurrency !== currency ? { amountMinor: merchant.feeFixedMinor, currency: feeCurrency } : null;
}
