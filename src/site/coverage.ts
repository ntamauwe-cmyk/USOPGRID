// Coverage derived from the live provider registry — the website never
// claims more than the adapters actually declare.
import { listDescriptors, METHOD_LABELS, type PaymentMethod, type ProviderDescriptor } from "@/convex/providers/index";
import { COUNTRIES, REGION_NAMES, ACTIVE_CURRENCY_CODES, type RegionCode } from "@/lib/geo";

export const LIVE_PROVIDERS: ProviderDescriptor[] = listDescriptors().filter((d) => d.category !== "sandbox");

export const CATEGORY_LABELS: Record<ProviderDescriptor["category"], string> = {
  global_acquirer: "Global acquirer",
  regional_psp: "Regional processor",
  emerging_markets: "Emerging-markets specialist",
  mobile_money: "Mobile money",
  open_banking: "Open banking",
  sandbox: "Simulation",
};

export function servesCountry(d: ProviderDescriptor, country: string): boolean {
  return d.countries === "global" || d.countries.includes(country);
}

export interface RegionCoverage {
  region: RegionCode;
  name: string;
  countries: number;
  providers: ProviderDescriptor[];
  localProviders: ProviderDescriptor[];
  methods: PaymentMethod[];
}

export function regionCoverage(): RegionCoverage[] {
  const regions = Object.keys(REGION_NAMES).filter((r) => r !== "AN") as RegionCode[];
  return regions.map((region) => {
    const cs = Object.values(COUNTRIES).filter((c) => c.region === region).map((c) => c.code);
    const providers = LIVE_PROVIDERS.filter((d) => cs.some((c) => servesCountry(d, c)));
    const local = providers.filter((d) => d.countries !== "global");
    const methods = [...new Set(providers.flatMap((d) => [...d.methods]))] as PaymentMethod[];
    return { region, name: REGION_NAMES[region], countries: cs.length, providers, localProviders: local, methods };
  });
}

export const STATS = {
  providers: LIVE_PROVIDERS.length,
  currencies: ACTIVE_CURRENCY_CODES.length,
  countries: Object.keys(COUNTRIES).length,
  methods: Object.keys(METHOD_LABELS).length,
};

export { METHOD_LABELS };
