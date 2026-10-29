#!/usr/bin/env python3
"""Generate every USOPGRID logo file from one geometry.

    python3 scripts/brand/generate.py

Outputs public/brand/*.svg, public/favicon.svg, public/logo.svg,
public/wordmark.svg, public/og-image.svg and src/components/brand-geometry.ts.
PNG app icons are rendered from these SVGs by scripts/brand/render-icons.mjs.

The emblem: a square geometric G frame enclosing a U. The G's inner bar
runs from the frame to the U's right stem and joins it at a single point:
two structures, one connection. Monoline, square ends, mitred corners, so it
holds up without gradients, shadows or metallic effects.

The wordmark is USOPGRID set in Marcellus (SIL OFL, see OFL-Marcellus.txt)
with +0.20 em tracking, converted to outlines in wordmark.json so it never
depends on an installed font.
"""
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "brand")

# Official palette
NAVY = "#142746"       # Primary Institutional Navy
MIDNIGHT = "#0B1930"   # Deep Midnight Navy
GOLD = "#C5A15D"       # Antique Gold
CHAMPAGNE = "#D6BC82"  # Champagne Gold
IVORY = "#F7F5EF"      # Ivory White
CHARCOAL = "#292D32"   # Charcoal
WARM_GREY = "#D8D5CD"  # Warm Grey

# Emblem geometry on a 64-unit grid (stroke-centred).
G_PATH = "M51 21V9H13V55H51V34H42"
U_PATH = "M22 21V46H42V21"
STROKE = 4.5
# Heavier stroke for the 16-32 px favicon so lines stay crisp.
FAVICON_STROKE = 6
# Bounding box of the stroked emblem.
EX0, EY0 = 13 - STROKE / 2, 9 - STROKE / 2
EW, EH = 38 + STROKE, 46 + STROKE

WM = json.load(open(os.path.join(os.path.dirname(__file__), "wordmark.json")))
WM_W = WM["maxx"] - WM["minx"]
WM_CAP = WM["cap"]  # cap height in font units (wordmark is all caps)


def emblem_strokes(color, stroke=STROKE):
    common = f'fill="none" stroke="{color}" stroke-width="{stroke}" stroke-linecap="butt" stroke-linejoin="miter"'
    return f'<path d="{G_PATH}" {common}/><path d="{U_PATH}" {common}/>'


def tile(fill, color, size=64, radius=6, scale=0.74, stroke=STROKE):
    """Emblem centred on a square tile. Emblem centre is (32,32)."""
    k = size / 64
    return (
        f'<rect width="{size}" height="{size}" rx="{radius * k:g}" fill="{fill}"/>'
        f'<g transform="translate({size / 2:g} {size / 2:g}) scale({scale * k:g}) translate(-32 -32)">'
        f"{emblem_strokes(color, stroke)}</g>"
    )


def wordmark(color, x, cap_y_top, cap_h):
    """Place the wordmark with its cap height spanning cap_y_top..cap_y_top+cap_h."""
    s = cap_h / WM_CAP
    # Font units: baseline at y=0, caps rise to -cap (paths already y-flipped).
    tx = x - WM["minx"] * s
    ty = cap_y_top + WM_CAP * s
    return f'<path transform="translate({tx:.3f} {ty:.3f}) scale({s:.6f})" d="{WM["d"]}" fill="{color}"/>', WM_W * s


def svg(w, h, body, title):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>\n"
    )


def horizontal(kind):
    """kind: dark (bare gold emblem, ivory word), light (navy tile, navy word), mono-<hex>."""
    if kind == "light":
        size = 64
        em = tile(NAVY, GOLD)
        cap = size * 0.40
        gap = size * 0.34
        word, ww = wordmark(NAVY, size + gap, (size - cap) / 2, cap)
        return svg(size + gap + ww, size, em + word, "USOPGRID")
    color_e, color_w = (GOLD, IVORY) if kind == "dark" else (kind.split("-", 1)[1],) * 2
    em = f'<g transform="translate({-EX0} {-EY0})">{emblem_strokes(color_e)}</g>'
    cap = EH * 0.42
    gap = EW * 0.48
    word, ww = wordmark(color_w, EW + gap, (EH - cap) / 2, cap)
    return svg(EW + gap + ww, EH, em + word, "USOPGRID")


def vertical(kind):
    if kind == "light":
        size = 64
        cap = size * 0.30
        _, ww = wordmark(NAVY, 0, 0, cap)
        w = max(ww, size)
        em = f'<g transform="translate({(w - size) / 2:.3f} 0)">{tile(NAVY, GOLD)}</g>'
        word, _ = wordmark(NAVY, (w - ww) / 2, size + size * 0.32, cap)
        return svg(w, size + size * 0.32 + cap, em + word, "USOPGRID")
    color_e, color_w = (GOLD, IVORY) if kind == "dark" else (kind.split("-", 1)[1],) * 2
    cap = EH * 0.34
    _, ww = wordmark(color_w, 0, 0, cap)
    w = max(ww, EW)
    em = f'<g transform="translate({(w - EW) / 2 - EX0:.3f} {-EY0})">{emblem_strokes(color_e)}</g>'
    word, _ = wordmark(color_w, (w - ww) / 2, EH + EH * 0.34, cap)
    return svg(w, EH + EH * 0.34 + cap, em + word, "USOPGRID")


def emblem_only(color):
    return svg(EW, EH, f'<g transform="translate({-EX0} {-EY0})">{emblem_strokes(color)}</g>', "USOPGRID emblem")


def og_image():
    W, H = 1200, 630
    body = [f'<rect width="{W}" height="{H}" fill="{NAVY}"/>',
            f'<rect x="0" y="{H - 10}" width="{W}" height="10" fill="{GOLD}"/>']
    size = 150
    body.append(f'<g transform="translate(96 150)">{tile(MIDNIGHT, GOLD, size=size, radius=6)}</g>')
    word, _ = wordmark(IVORY, 96 + size + 52, 150 + (size - 58) / 2, 58)
    body.append(word)
    body.append(f'<rect x="96" y="372" width="72" height="3" fill="{GOLD}"/>')
    font = "font-family=\"'Source Serif 4', Georgia, 'Times New Roman', serif\""
    body.append(f'<text x="96" y="440" {font} font-size="52" font-weight="600" fill="{IVORY}">Powering Every Payment Connection.</text>')
    body.append(f'<text x="96" y="500" font-family="\'IBM Plex Sans\', Arial, sans-serif" font-size="26" fill="{CHAMPAGNE}" letter-spacing="3">ENTERPRISE PAYMENT INFRASTRUCTURE</text>')
    return svg(W, H, "".join(body), "USOPGRID — Powering Every Payment Connection.")


def main():
    os.makedirs(OUT, exist_ok=True)
    files = {
        "usopgrid-horizontal-dark.svg": horizontal("dark"),
        "usopgrid-horizontal-light.svg": horizontal("light"),
        "usopgrid-vertical-dark.svg": vertical("dark"),
        "usopgrid-vertical-light.svg": vertical("light"),
        "usopgrid-mono-navy.svg": horizontal("mono-" + NAVY),
        "usopgrid-mono-black.svg": horizontal("mono-#000000"),
        "usopgrid-mono-white.svg": horizontal("mono-#FFFFFF"),
        "usopgrid-vertical-mono-navy.svg": vertical("mono-" + NAVY),
        "usopgrid-emblem-gold.svg": emblem_only(GOLD),
        "usopgrid-emblem-navy.svg": emblem_only(NAVY),
        "usopgrid-emblem-black.svg": emblem_only("#000000"),
        "usopgrid-app-icon.svg": svg(512, 512, tile(NAVY, GOLD, size=512, radius=0, scale=0.70), "USOPGRID"),
        # Maskable: emblem inside the 80% safe zone, full-bleed navy.
        "usopgrid-app-icon-maskable.svg": svg(512, 512, tile(NAVY, GOLD, size=512, radius=0, scale=0.56), "USOPGRID"),
    }
    for name, content in files.items():
        open(os.path.join(OUT, name), "w").write(content)

    pub = os.path.join(ROOT, "public")
    open(os.path.join(pub, "favicon.svg"), "w").write(
        svg(64, 64, tile(NAVY, GOLD, size=64, radius=8, scale=0.80, stroke=FAVICON_STROKE), "USOPGRID"))
    open(os.path.join(pub, "logo.svg"), "w").write(svg(64, 64, tile(NAVY, GOLD), "USOPGRID"))
    open(os.path.join(pub, "wordmark.svg"), "w").write(horizontal("light"))
    open(os.path.join(pub, "og-image.svg"), "w").write(og_image())

    ts = os.path.join(ROOT, "src", "components", "brand-geometry.ts")
    s = WM_CAP and 1 / WM_CAP
    open(ts, "w").write(
        "// Generated by scripts/brand/generate.py. Do not edit by hand.\n"
        f"export const EMBLEM_G_PATH = {json.dumps(G_PATH)};\n"
        f"export const EMBLEM_U_PATH = {json.dumps(U_PATH)};\n"
        f"export const EMBLEM_STROKE = {STROKE};\n"
        f"export const EMBLEM_BOX = {{ x: {EX0}, y: {EY0}, w: {EW}, h: {EH} }} as const;\n"
        "/** Wordmark outlines (Marcellus, +0.20em tracking), normalised so cap height = 1. */\n"
        f"export const WORDMARK = {{ d: {json.dumps(WM['d'])}, minX: {WM['minx']}, width: {WM_W}, cap: {WM_CAP} }} as const;\n"
    )
    print("wrote", len(files) + 5, "files")


if __name__ == "__main__":
    main()
