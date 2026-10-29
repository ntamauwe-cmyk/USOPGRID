// USOPGRID global reference data — ISO 4217 currencies and ISO 3166-1 countries.
// Pure data + lookups; safe to import from the frontend and the Convex runtime.

import { CURRENCY_ROWS } from "./currencies.data";
import { COUNTRY_ROWS } from "./countries.data";

export interface CurrencyInfo {
  code: string;
  decimals: number;
  symbol: string;
  name: string;
  /** false for withdrawn codes kept only so historical records still render. */
  active: boolean;
}

export type RegionCode = "AF" | "EU" | "NA" | "LA" | "AP" | "ME" | "CA" | "AN";

export interface CountryInfo {
  code: string;
  name: string;
  currency: string;
  region: RegionCode;
}

export const REGION_NAMES: Record<RegionCode, string> = {
  AF: "Africa",
  EU: "Europe",
  NA: "North America",
  LA: "Latin America & Caribbean",
  AP: "Asia-Pacific",
  ME: "Middle East",
  CA: "Central Asia & Caucasus",
  AN: "Antarctic & sub-Antarctic territories",
};

export const CURRENCIES: Record<string, CurrencyInfo> = Object.fromEntries(
  CURRENCY_ROWS.map(([code, decimals, symbol, name, active]) => [code, { code, decimals, symbol, name, active }]),
);

export const COUNTRIES: Record<string, CountryInfo> = Object.fromEntries(
  COUNTRY_ROWS.map(([code, name, currency, region]) => [code, { code, name, currency, region: region as RegionCode }]),
);

export const ACTIVE_CURRENCY_CODES = Object.values(CURRENCIES)
  .filter((c) => c.active)
  .map((c) => c.code);

export const COUNTRY_CODES = Object.keys(COUNTRIES);

export function getCurrency(code: string): CurrencyInfo | undefined {
  return CURRENCIES[code?.toUpperCase?.() ?? ""];
}

export function getCountry(code: string): CountryInfo | undefined {
  return COUNTRIES[code?.toUpperCase?.() ?? ""];
}

export function isActiveCurrency(code: string): boolean {
  return getCurrency(code)?.active === true;
}

export function isKnownCountry(code: string): boolean {
  return getCountry(code) !== undefined;
}

export function countriesInRegion(region: RegionCode): CountryInfo[] {
  return Object.values(COUNTRIES).filter((c) => c.region === region);
}
