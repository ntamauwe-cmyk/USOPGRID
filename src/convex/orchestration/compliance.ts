// USOPGRID compliance screening — jurisdiction policy + watchlist screening.
//
// USOPGRID is built to operate in every market, and that is exactly why the
// platform screens. Moving money for sanctioned jurisdictions or listed
// persons exposes the operator, its banks and its providers to criminal
// liability, and providers terminate merchants who do it. The policy below is
// a conservative DEFAULT that operators tune with counsel for their licences
// (OFAC, EU, UK OFSI, UN, and local regulators). It is data, not code.

export type ComplianceDecision = "ALLOW" | "REVIEW" | "BLOCK";

export interface JurisdictionPolicy {
  /** Comprehensively embargoed — no processing at all. */
  blockedCountries: string[];
  /** Heavily sanctioned or high-risk — allowed only after manual review. */
  reviewCountries: string[];
  blockedCurrencies: string[];
}

// Review the list whenever regimes change. As of 2026: CU, IR, KP remain
// under comprehensive US/EU/UN-aligned restrictions; RU and BY are under broad
// financial-sector sanctions; SY restrictions were substantially eased in 2025
// but residual listings remain; MM, AF, VE and others carry targeted regimes.
export const DEFAULT_JURISDICTION_POLICY: JurisdictionPolicy = {
  blockedCountries: ["CU", "IR", "KP"],
  reviewCountries: ["RU", "BY", "SY", "VE", "MM", "AF", "SD", "SS", "YE", "LY", "SO", "CF", "CD", "ML", "NI", "IQ", "LB", "ZW"],
  blockedCurrencies: ["IRR", "KPW", "CUP"],
};

export interface ScreeningInput {
  payerCountry?: string;
  merchantCountry?: string;
  currency: string;
  customerName?: string;
  amountMinor: number;
}

export interface ComplianceResult {
  decision: ComplianceDecision;
  reasons: string[];
  watchlist?: { provider: string; checked: boolean; topScore?: number; matches?: { name: string; datasets: string[]; score: number }[] };
}

export function evaluateJurisdiction(input: ScreeningInput, policy: JurisdictionPolicy = DEFAULT_JURISDICTION_POLICY): ComplianceResult {
  const reasons: string[] = [];
  let decision: ComplianceDecision = "ALLOW";
  const bump = (d: ComplianceDecision) => {
    if (d === "BLOCK" || (d === "REVIEW" && decision === "ALLOW")) decision = d;
  };
  for (const [label, c] of [["payer", input.payerCountry], ["merchant", input.merchantCountry]] as const) {
    if (!c) continue;
    if (policy.blockedCountries.includes(c)) {
      bump("BLOCK");
      reasons.push(`${label}_country_embargoed:${c}`);
    } else if (policy.reviewCountries.includes(c)) {
      bump("REVIEW");
      reasons.push(`${label}_country_high_risk:${c}`);
    }
  }
  if (policy.blockedCurrencies.includes(input.currency)) {
    bump("BLOCK");
    reasons.push(`currency_restricted:${input.currency}`);
  }
  return { decision, reasons };
}

/**
 * Watchlist screening via OpenSanctions (consolidated OFAC SDN, EU, UK, UN and
 * 200+ other lists). https://www.opensanctions.org/docs/api/matching/
 * Requires OPENSANCTIONS_API_KEY; without it the check is reported as not run.
 */
export async function screenWatchlist(
  name: string,
  country: string | undefined,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  threshold = 0.7,
): Promise<ComplianceResult["watchlist"] & { decision: ComplianceDecision }> {
  if (!apiKey) return { provider: "opensanctions", checked: false, decision: "ALLOW" };
  const res = await fetchImpl("https://api.opensanctions.org/match/default?algorithm=logic-v1", {
    method: "POST",
    headers: { Authorization: `ApiKey ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      queries: { q: { schema: "LegalEntity", properties: { name: [name], ...(country ? { country: [country.toLowerCase()] } : {}) } } },
    }),
  });
  if (!res.ok) throw new Error(`OpenSanctions HTTP ${res.status}`);
  const j = (await res.json()) as { responses?: { q?: { results?: { caption: string; score: number; match: boolean; datasets: string[] }[] } } };
  const results = j.responses?.q?.results ?? [];
  const top = results[0]?.score ?? 0;
  const matches = results.filter((r) => r.score >= threshold).map((r) => ({ name: r.caption, datasets: r.datasets, score: r.score }));
  const decision: ComplianceDecision = results.some((r) => r.match) ? "BLOCK" : matches.length ? "REVIEW" : "ALLOW";
  return { provider: "opensanctions", checked: true, topScore: top, matches, decision };
}
