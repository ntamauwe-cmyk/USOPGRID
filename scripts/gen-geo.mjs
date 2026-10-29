// Generates src/lib/geo/currencies.ts and src/lib/geo/countries.ts.
// Names come from CLDR (Intl); exponents and country→currency mapping are
// curated from ISO 4217 / ISO 3166-1 (maintenance list as of 2025-2026).
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
const curNames = new Intl.DisplayNames(["en"], { type: "currency" });
const regNames = new Intl.DisplayNames(["en"], { type: "region" });

// ISO 4217 minor-unit exponents that differ from 2.
const EXP = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};
// Withdrawn / non-transactional codes we still recognise for historical data.
const DEPRECATED = new Set(["HRK", "SLL", "ZWL", "CUC", "ANG", "VEF", "MRO", "STD"]);
const EXCLUDE = new Set(["XDR", "XSU"]);

const SYMBOL_OVERRIDES = {
  NGN: "₦", GHS: "GH₵", KES: "KSh", ZAR: "R", XOF: "CFA", XAF: "FCFA", UGX: "USh",
  TZS: "TSh", RWF: "FRw", EGP: "E£", MAD: "DH", INR: "₹", BRL: "R$", MXN: "MX$",
  JPY: "¥", CNY: "CN¥", KRW: "₩", PHP: "₱", IDR: "Rp", THB: "฿", VND: "₫",
  TRY: "₺", UAH: "₴", PLN: "zł", CHF: "CHF", SEK: "kr", NOK: "kr", DKK: "kr",
  AED: "AED", SAR: "SAR", CAD: "CA$", AUD: "A$", NZD: "NZ$", HKD: "HK$", SGD: "S$",
  USD: "$", EUR: "€", GBP: "£", ILS: "₪", PKR: "Rs", BDT: "৳", LKR: "Rs", MYR: "RM",
  ZMW: "ZK", MWK: "MK", ETB: "Br", XCD: "EC$", COP: "COL$", ARS: "AR$", CLP: "CL$", PEN: "S/",
};

const codes = [...Intl.supportedValuesOf("currency"), "VEF", "MRO", "STD"]
  .filter((c, i, a) => a.indexOf(c) === i && !EXCLUDE.has(c)).sort();

const currencies = codes.map((code) => {
  let symbol = SYMBOL_OVERRIDES[code];
  if (!symbol) {
    try {
      const parts = new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(1);
      symbol = parts.find((p) => p.type === "currency")?.value ?? code;
    } catch { symbol = code; }
  }
  return { code, decimals: EXP[code] ?? 2, symbol, name: curNames.of(code) ?? code, active: !DEPRECATED.has(code) };
});

// ISO 3166-1 alpha-2 → [primary currency, region]
// Regions: AF Africa, EU Europe, NA North America, LA Latin America & Caribbean,
// AP Asia-Pacific, ME Middle East, CA Central Asia, AN Antarctica
const C = `
AD EUR EU|AE AED ME|AF AFN AP|AG XCD LA|AI XCD LA|AL ALL EU|AM AMD CA|AO AOA AF|AQ USD AN|AR ARS LA|AS USD AP|AT EUR EU|AU AUD AP|AW AWG LA|AX EUR EU|AZ AZN CA|
BA BAM EU|BB BBD LA|BD BDT AP|BE EUR EU|BF XOF AF|BG BGN EU|BH BHD ME|BI BIF AF|BJ XOF AF|BL EUR LA|BM BMD NA|BN BND AP|BO BOB LA|BQ USD LA|BR BRL LA|BS BSD LA|BT BTN AP|BV NOK AN|BW BWP AF|BY BYN EU|BZ BZD LA|
CA CAD NA|CC AUD AP|CD CDF AF|CF XAF AF|CG XAF AF|CH CHF EU|CI XOF AF|CK NZD AP|CL CLP LA|CM XAF AF|CN CNY AP|CO COP LA|CR CRC LA|CU CUP LA|CV CVE AF|CW XCG LA|CX AUD AP|CY EUR EU|CZ CZK EU|
DE EUR EU|DJ DJF AF|DK DKK EU|DM XCD LA|DO DOP LA|DZ DZD AF|EC USD LA|EE EUR EU|EG EGP AF|EH MAD AF|ER ERN AF|ES EUR EU|ET ETB AF|FI EUR EU|FJ FJD AP|FK FKP LA|FM USD AP|FO DKK EU|FR EUR EU|
GA XAF AF|GB GBP EU|GD XCD LA|GE GEL CA|GF EUR LA|GG GBP EU|GH GHS AF|GI GIP EU|GL DKK NA|GM GMD AF|GN GNF AF|GP EUR LA|GQ XAF AF|GR EUR EU|GS GBP AN|GT GTQ LA|GU USD AP|GW XOF AF|GY GYD LA|
HK HKD AP|HM AUD AN|HN HNL LA|HR EUR EU|HT HTG LA|HU HUF EU|ID IDR AP|IE EUR EU|IL ILS ME|IM GBP EU|IN INR AP|IO USD AP|IQ IQD ME|IR IRR ME|IS ISK EU|IT EUR EU|JE GBP EU|JM JMD LA|JO JOD ME|JP JPY AP|
KE KES AF|KG KGS CA|KH KHR AP|KI AUD AP|KM KMF AF|KN XCD LA|KP KPW AP|KR KRW AP|KW KWD ME|KY KYD LA|KZ KZT CA|LA LAK AP|LB LBP ME|LC XCD LA|LI CHF EU|LK LKR AP|LR LRD AF|LS LSL AF|LT EUR EU|LU EUR EU|LV EUR EU|LY LYD AF|
MA MAD AF|MC EUR EU|MD MDL EU|ME EUR EU|MF EUR LA|MG MGA AF|MH USD AP|MK MKD EU|ML XOF AF|MM MMK AP|MN MNT AP|MO MOP AP|MP USD AP|MQ EUR LA|MR MRU AF|MS XCD LA|MT EUR EU|MU MUR AF|MV MVR AP|MW MWK AF|MX MXN LA|MY MYR AP|MZ MZN AF|
NA NAD AF|NC XPF AP|NE XOF AF|NF AUD AP|NG NGN AF|NI NIO LA|NL EUR EU|NO NOK EU|NP NPR AP|NR AUD AP|NU NZD AP|NZ NZD AP|OM OMR ME|PA PAB LA|PE PEN LA|PF XPF AP|PG PGK AP|PH PHP AP|PK PKR AP|PL PLN EU|PM EUR NA|PN NZD AP|PR USD LA|PS ILS ME|PT EUR EU|PW USD AP|PY PYG LA|
QA QAR ME|RE EUR AF|RO RON EU|RS RSD EU|RU RUB EU|RW RWF AF|SA SAR ME|SB SBD AP|SC SCR AF|SD SDG AF|SE SEK EU|SG SGD AP|SH SHP AF|SI EUR EU|SJ NOK EU|SK EUR EU|SL SLE AF|SM EUR EU|SN XOF AF|SO SOS AF|SR SRD LA|SS SSP AF|ST STN AF|SV USD LA|SX XCG LA|SY SYP ME|SZ SZL AF|
TC USD LA|TD XAF AF|TF EUR AN|TG XOF AF|TH THB AP|TJ TJS CA|TK NZD AP|TL USD AP|TM TMT CA|TN TND AF|TO TOP AP|TR TRY ME|TT TTD LA|TV AUD AP|TW TWD AP|TZ TZS AF|UA UAH EU|UG UGX AF|UM USD AP|US USD NA|UY UYU LA|UZ UZS CA|
VA EUR EU|VC XCD LA|VE VES LA|VG USD LA|VI USD LA|VN VND AP|VU VUV AP|WF XPF AP|WS WST AP|XK EUR EU|YE YER ME|YT EUR AF|ZA ZAR AF|ZM ZMW AF|ZW ZWG AF`;

const countries = C.split("|").map((s) => s.trim()).filter(Boolean).map((row) => {
  const [code, currency, region] = row.split(/\s+/);
  if (!currencies.find((c) => c.code === currency)) throw new Error(`unknown currency ${currency} for ${code}`);
  return { code, name: regNames.of(code) ?? code, currency, region };
}).sort((a, b) => a.code.localeCompare(b.code));

const header = "// AUTO-GENERATED by scripts/gen-geo.mjs — do not edit by hand.\n// Source: ISO 4217 (minor units) and ISO 3166-1 alpha-2, names from CLDR.\n";
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "currencies.data.ts"),
  header + "export const CURRENCY_ROWS: ReadonlyArray<readonly [code: string, decimals: number, symbol: string, name: string, active: boolean]> = [\n" +
  currencies.map((c) => `  [${JSON.stringify(c.code)}, ${c.decimals}, ${JSON.stringify(c.symbol)}, ${JSON.stringify(c.name)}, ${c.active}],`).join("\n") + "\n];\n");
fs.writeFileSync(path.join(out, "countries.data.ts"),
  header + "export const COUNTRY_ROWS: ReadonlyArray<readonly [code: string, name: string, currency: string, region: string]> = [\n" +
  countries.map((c) => `  [${JSON.stringify(c.code)}, ${JSON.stringify(c.name)}, ${JSON.stringify(c.currency)}, ${JSON.stringify(c.region)}],`).join("\n") + "\n];\n");
console.log(`currencies=${currencies.length} (active ${currencies.filter(c=>c.active).length}) countries=${countries.length}`);
