// Unit tests: money primitives must never lose precision or misformat.
import { describe, expect, test } from "bun:test";
import {
  CURRENCIES,
  currencyDecimals,
  formatMoney,
  formatMoneyCompact,
  formatMoneySigned,
  formatMoneyWithCode,
  isSupportedCurrency,
} from "../lib/money";

describe("currency registry", () => {
  test("supports ISO codes incl. zero-decimal XOF", () => {
    expect(isSupportedCurrency("NGN")).toBe(true);
    expect(isSupportedCurrency("XOF")).toBe(true);
    expect(isSupportedCurrency("XXX")).toBe(false);
    expect(currencyDecimals("XOF")).toBe(0);
    expect(currencyDecimals("NGN")).toBe(2);
  });

  test("every currency has an ISO 4217 exponent (0–4) and a symbol", () => {
    expect(currencyDecimals("KWD")).toBe(3);
    expect(currencyDecimals("JPY")).toBe(0);
    expect(Object.values(CURRENCIES).filter((c) => c.active).length).toBeGreaterThan(150);
    for (const info of Object.values(CURRENCIES)) {
      expect([0, 2, 3, 4]).toContain(info.decimals);
      expect(info.symbol.length).toBeGreaterThan(0);
      expect(/^[A-Z]{3}$/.test(info.code)).toBe(true);
    }
  });
});

describe("formatMoney", () => {
  test("formats two-decimal currencies", () => {
    expect(formatMoney(125000, "NGN")).toBe("₦1,250.00");
    expect(formatMoney(5, "USD")).toBe("$0.05");
    expect(formatMoney(0, "EUR")).toBe("€0.00");
  });

  test("formats zero-decimal currencies without fractions", () => {
    expect(formatMoney(1250, "XOF")).toBe("CFA1,250");
  });

  test("handles large values exactly (no float drift at display scale)", () => {
    // 999,999,999.99 NGN in kobo
    expect(formatMoney(999_999_999_99, "NGN")).toBe("₦999,999,999.99");
  });
});

describe("signed and coded variants", () => {
  test("formatMoneySigned credits and debits", () => {
    expect(formatMoneySigned(1500, "NGN")).toBe("+ ₦15.00");
    expect(formatMoneySigned(-1500, "NGN")).toBe("− ₦15.00");
  });

  test("formatMoneyWithCode includes ISO code", () => {
    expect(formatMoneyWithCode(100, "USD")).toBe("$1.00 USD");
  });
});

describe("formatMoneyCompact", () => {
  test("compacts thousands, millions and billions", () => {
    // 1_250_000 kobo = ₦12,500 -> "₦12.5k"
    expect(formatMoneyCompact(1_250_000, "NGN")).toBe("₦12.5k");
    // 1_250_000_00 kobo = ₦1,250,000 -> "₦1.3M"
    expect(formatMoneyCompact(1_250_000_00, "NGN")).toBe("₦1.3M");
    // 2_400_000_000_00 kobo = ₦2.4B
    expect(formatMoneyCompact(2_400_000_000_00, "NGN")).toBe("₦2.4B");
  });
});
