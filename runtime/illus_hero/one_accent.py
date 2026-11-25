"""One accent on the opening picture: the page's own judge (item 'single accent colour') counts every painted colour whose chroma
(max(r,g,b) - min(r,g,b)) / 255 is at least STRONG as an accent colour, and a page passes with one: the page accent. The old SVG
renderers (people, scene, line) mix their own skins, clothes, greens and blues, and shades of the accent; this pass, run on their reply,
leaves the page accent as the only strong colour of the picture:
  - the accent itself stays;
  - a strong colour of the accent's hue (within ACCENT_HUE degrees) at about the accent's lightness or lighter is the accent as drawn
    (a lifted or blended copy of it) and becomes the accent itself; a darker one is a shade of it and keeps its hue and lightness at
    SHADE_CHROMA, under the line;
  - every other colour above GREY_CHROMA (skin, green, blue, an olive hair, ...) keeps its luma and hue and is pulled to GREY_CHROMA: a
    grey tone, so no second hue reads on the picture even under the line.
Pale tints of the accent's hue under the line and greys are left as drawn. Every '#rrggbb' in the markup is read (fill, stroke, stop-color, inside gradients, masks and
style attributes alike), so nothing strong hides in a gradient either."""
import colorsys
import re

STRONG = 0.30          # the judge's line (works/pagegood measure.js: chroma(c) < 0.30 is not counted)
GREY_CHROMA = 0.06     # a non-accent colour becomes a grey tone of this chroma (a hint of its hue, no second hue)
SHADE_CHROMA = 0.26    # a darker shade of the accent keeps this chroma, under the line
ACCENT_HUE = 12.0      # degrees: a colour this close to the accent's hue is of the accent's family
SHADE_BELOW = 0.12     # HLS lightness under the accent's by more than this: a shade, not the accent
HEX = re.compile(r"#[0-9a-fA-F]{6}(?![0-9a-fA-F])")


def rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
def hex_of(c): return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(v)))) for v in c)
def chroma(h): c = rgb(h); return (max(c) - min(c)) / 255.0
def strong(h): return chroma(h) >= STRONG


def hls(h): r, g, b = (v / 255.0 for v in rgb(h)); hh, l, s = colorsys.rgb_to_hls(r, g, b); return hh * 360.0, l, s


def with_chroma(h, target):
    """h moved toward the grey of its own luma (Rec. 601) until its chroma is `target`: hue and luma kept."""
    c = rgb(h); y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; now = (max(c) - min(c)) / 255.0
    k = target / now if now > 0 else 0.0
    return hex_of(tuple(y + (v - y) * k for v in c))


def recolour(h, accent):
    """The colour `h` becomes on a picture whose only accent is `accent` (both '#rrggbb')."""
    h, accent = h.lower(), accent.lower()
    if h == accent or chroma(h) <= GREY_CHROMA: return h
    ha, la, _ = hls(accent); hh, lh, _ = hls(h)
    if abs((hh - ha + 180.0) % 360.0 - 180.0) <= ACCENT_HUE:
        if not strong(h): return h
        return accent if lh >= la - SHADE_BELOW else with_chroma(h, SHADE_CHROMA)
    return with_chroma(h, GREY_CHROMA)


def one_accent(svg, accent):
    """svg with every strong colour but `accent` recoloured (recolour)."""
    memo = {}
    def sub(m):
        k = m.group(0).lower()
        if k not in memo: memo[k] = recolour(k, accent)
        return memo[k]
    return HEX.sub(sub, svg)


def strong_colours(svg):
    """The distinct strong colours anywhere in the markup (lowercase '#rrggbb'), the stricter reading of the judge's rule."""
    return sorted({h.lower() for h in HEX.findall(svg) if strong(h)})
