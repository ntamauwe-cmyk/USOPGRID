// Brand guardrails: logo files exist, use only the official palette, and never
// rely on gradients, shadows, filters or bitmap effects.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { BRAND } from "../components/brand";

const root = new URL("../../public/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const brandFiles = readdirSync(new URL("brand/", root)).filter((f) => f.endsWith(".svg"));
const OFFICIAL = new Set(["#142746", "#0B1930", "#C5A15D", "#D6BC82", "#F7F5EF", "#292D32", "#D8D5CD", "#000000", "#FFFFFF"]);

describe("logo system", () => {
  test("every required variation is present", () => {
    for (const f of [
      "usopgrid-horizontal-dark.svg", "usopgrid-horizontal-light.svg",
      "usopgrid-vertical-dark.svg", "usopgrid-vertical-light.svg",
      "usopgrid-mono-navy.svg", "usopgrid-mono-black.svg", "usopgrid-mono-white.svg",
      "usopgrid-app-icon.svg", "usopgrid-app-icon-maskable.svg",
    ]) expect(brandFiles).toContain(f);
  });
  test("flat artwork only: no gradients, shadows, filters or embedded images", () => {
    for (const f of [...brandFiles.map((f) => `brand/${f}`), "favicon.svg", "logo.svg", "wordmark.svg"]) {
      const svg = read(f);
      expect(svg).not.toMatch(/Gradient|<filter|drop-shadow|<image|opacity=/i);
    }
  });
  test("only official palette colours are used", () => {
    for (const f of [...brandFiles.map((f) => `brand/${f}`), "favicon.svg", "logo.svg"]) {
      for (const c of read(f).match(/#[0-9A-Fa-f]{6}\b/g) ?? []) expect(OFFICIAL.has(c.toUpperCase())).toBe(true);
    }
  });
  test("app palette constants match the official palette", () => {
    expect(BRAND.navy).toBe("#142746");
    expect(BRAND.gold).toBe("#C5A15D");
    expect(BRAND.ivory).toBe("#F7F5EF");
  });
});
