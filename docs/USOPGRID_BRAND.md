# USOPGRID Brand Identity

Owner: RAE Horizon Technologies Limited · Tagline: **Powering Every Payment Connection.** · Descriptor: **Enterprise Payment Infrastructure**

The identity is institutional: navy foundation, antique gold used sparingly, ivory content surfaces. It avoids the visual language of technology start-ups (neon blue, cyan, purple gradients, glows, glass effects).

## Emblem

A square geometric **G** frame encloses a **U**. The G's inner bar runs from the frame to the U's right stem and joins it at a single point: two structures, one dependable connection. Monoline, square ends, mitred corners. It holds up in one colour with no gradients, shadows or metallic effects.

- Geometry (64-unit grid): `G = M51 21V9H13V55H51V34H42`, `U = M22 21V46H42V21`, stroke 4.5 (6 for favicons).
- Gold emblem appears only on navy: bare on navy or midnight surfaces, inside the navy tile on light surfaces.
- Clear space: at least the width of the U's stroke gap (9 units) on every side; for lockups, the height of the wordmark's cap height.
- Minimum size: tile 16 px (favicon variant), bare emblem 20 px, horizontal lockup 24 px tall.

## Wordmark

USOPGRID in uppercase, set in Marcellus (SIL Open Font License) with +0.20 em tracking, drawn as outlines so it never depends on an installed font. Do not retype it in another face, condense it, or change the tracking.

## Logo files (`public/brand/`)

| Use | File |
|---|---|
| Primary horizontal, dark backgrounds | `usopgrid-horizontal-dark.svg` (+ `.png`) |
| Primary horizontal, light backgrounds | `usopgrid-horizontal-light.svg` (+ `.png`) |
| Centred vertical | `usopgrid-vertical-dark.svg`, `usopgrid-vertical-light.svg` |
| Monochrome for formal documents | `usopgrid-mono-navy.svg`, `usopgrid-mono-black.svg`, `usopgrid-mono-white.svg`, `usopgrid-vertical-mono-navy.svg` |
| Emblem alone | `usopgrid-emblem-gold.svg`, `-navy.svg`, `-black.svg` |
| App icon / favicon | `usopgrid-app-icon.svg`, `usopgrid-app-icon-maskable.svg`, `usopgrid-icon-192.png`, `usopgrid-icon-512.png`, `usopgrid-icon-maskable-512.png`, `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png` |
| Social sharing | `/og-image.png` (1200 × 630) |

All files are generated: `python3 scripts/brand/generate.py`, then `node scripts/brand/render-icons.mjs` for the PNGs. In React use `UsopgridLogo`, `UsopgridMark` and `UsopgridWordmark` from `src/components/brand.tsx`. `src/tests/brand.test.ts` fails if a logo file gains a gradient, shadow, filter or off-palette colour.

## Colour

| Token | Hex | Role |
|---|---|---|
| Primary Institutional Navy | `#142746` | Brand foundation, primary buttons, headings, brand bands |
| Deep Midnight Navy | `#0B1930` | Site header and footer, dashboard sidebar, code blocks |
| Antique Gold | `#C5A15D` | Emblem, active-navigation marker, rules, gold buttons on navy |
| Champagne Gold | `#D6BC82` | Gold text and labels on navy; gold button hover |
| Ivory White | `#F7F5EF` | Page and content surfaces; text on navy |
| Charcoal | `#292D32` | Running text |
| Warm Grey | `#D8D5CD` | Borders and dividers |
| Gold ink (derived) | `#7F6128` | Gold-toned text and focus rings on light surfaces (5.3:1 on ivory) |

Rules: gold is a highlight, never a fill for large areas. Never set Antique Gold text on ivory or white (2.2:1, fails WCAG). Every text pairing in the product meets WCAG AA (4.5:1).

### Status colours (separate from the brand)

| Meaning | Text / tint | Used for |
|---|---|---|
| Success | `#146C43` / `#E2F2E8` | Successful, settled, delivered, won |
| Pending | `#9A4205` / `#FDEBDC` | Pending, in flight, unconfirmed |
| Processing | `#1D4FA8` / `#E3EBF8` | Accepted, processing, under review |
| Failed | `#B42318` / `#FBE4E1` | Failed, declined, lost, dead letters |
| Money returned | `#5B3FA8` / `#ECE7F8` | Refunded, reversed |
| Needs a person | `#9D1C5A` / `#F9E2ED` | Disputes, reconciliation exceptions |

Status pills also carry a dot, so meaning never depends on colour alone. Do not use gold or navy to signal transaction state.

## Typography

| Role | Face | Notes |
|---|---|---|
| Wordmark | Marcellus (outlined) | Logo only |
| Headings, key figures | Source Serif 4, semibold | Navy on light, ivory on navy |
| Interface and body | IBM Plex Sans | 15–17 px body, 1.6 line height |
| Code, references, IDs | IBM Plex Mono | |
| Labels and eyebrows | IBM Plex Sans 600, uppercase, +0.14–0.18 em | Gold ink on light, champagne on navy |

All fonts are self-hosted under SIL OFL (`public/fonts/`); no third-party font requests.

## Application

- **Website:** midnight header with gold underline on the active page; navy hero; ivory sections; gold primary button on navy, navy primary button on ivory.
- **Dashboard:** midnight sidebar with gold marker on the active page; ivory canvas, white bordered panels, serif navy titles and figures; no drop shadows on panels.
- **Sign-in:** navy brand panel with the lockup and tagline beside an ivory form; navy band above the form on phones.
- **Payment page:** navy header band with gold rule, white panel, navy pay button.
- **Email:** navy header band with gold rule, ivory surround, code in navy monospace.
- **Presentations:** navy title and section slides with the horizontal dark lockup, ivory content slides with navy serif titles, a single gold rule under titles, status colours only for status.

## Do not

- Recolour the emblem outside the palette, add gradients, bevels, shadows or metallic effects.
- Place the gold emblem directly on ivory or white (use the navy tile).
- Rearrange the emblem and wordmark, or use the emblem as a pattern or watermark at low opacity.
- Use neon blue, cyan, purple gradients, glows or glass effects anywhere in the product.
