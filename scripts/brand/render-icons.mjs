// Renders PNG app icons and the social sharing image from the generated SVGs.
// Requires Playwright with Chromium (dev machine or CI): node scripts/brand/render-icons.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pub = (p) => resolve(root, "public", p);
const serif = readFileSync(pub("fonts/source-serif-4.woff")).toString("base64");
const plex = readFileSync(pub("fonts/plex-sans.woff")).toString("base64");
const fonts = `<style>@font-face{font-family:"Source Serif 4";src:url(data:font/woff;base64,${serif})}@font-face{font-family:"IBM Plex Sans";src:url(data:font/woff;base64,${plex})}html,body{margin:0;background:transparent}svg{display:block}</style>`;

const jobs = [
  ["brand/usopgrid-app-icon.svg", "apple-touch-icon.png", 180],
  ["brand/usopgrid-app-icon.svg", "brand/usopgrid-icon-192.png", 192],
  ["brand/usopgrid-app-icon.svg", "brand/usopgrid-icon-512.png", 512],
  ["brand/usopgrid-app-icon-maskable.svg", "brand/usopgrid-icon-maskable-512.png", 512],
  ["favicon.svg", "favicon-32.png", 32],
  ["og-image.svg", "og-image.png", 1200, 630],
  ["brand/usopgrid-horizontal-light.svg", "brand/usopgrid-horizontal-light.png", 1200, null],
  ["brand/usopgrid-horizontal-dark.svg", "brand/usopgrid-horizontal-dark.png", 1200, null],
];

const browser = await chromium.launch();
for (const [src, out, w, hIn] of jobs) {
  const svg = readFileSync(pub(src), "utf8");
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const h = hIn === undefined ? w : hIn ?? Math.round((w * +m[2]) / +m[1]);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const sized = svg.replace(/width="[\d.]+" height="[\d.]+"/, `width="${w}" height="${h}"`);
  await page.setContent(`<!doctype html><html><head>${fonts}</head><body>${sized}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: pub(out), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  console.log("wrote", out, `${w}x${h}`);
}
await browser.close();
