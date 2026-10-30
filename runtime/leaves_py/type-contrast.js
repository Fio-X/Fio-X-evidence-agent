(pure) => { // page check: every visible text as laid out (html and svg alike), its size as rendered and its contrast with what is drawn under it; measured here, judged by layer 1
  // The floors layer 1 holds the numbers to (next_run.rs page_checks), here only to list the first texts below them:
  //   contrast 4.5:1 for body text, 3:1 for large text, large = at least 18pt (24px) or 14pt (18.66px) bold (700 and up):
  //     WCAG 2.x SC 1.4.3 Contrast (Minimum), its relative luminance and contrast ratio as WCAG 2.x defines them;
  //   size 11px: our counted reference pages put the median smallest text at 11-12px at 1440 wide, measured as glyph height
  //     from screenshots; a glyph is shorter than its font size, so a CSS font-size floor of 11 is the looser reading.
  const FONT = 11, BODY = 4.5, LARGE = 3;
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const large = (px, weight) => px >= 24 || (weight >= 700 && px >= 18.66);
  const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)]; // a colour with its alpha over an opaque one
  const parse = (s) => { const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(String(s).trim()); return m && [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[5] ? m[4] / 100 : +m[4]]; };
  const round = (x) => Math.round(x * 100) / 100;
  if (pure === 'pure') return { FONT, BODY, LARGE, luminance, ratio, large, over, parse, round };
  // a computed colour Chrome does not give as rgb() (color(), oklch()...) is read back from a one-pixel canvas
  let cv; const seen = new Map();
  const rgba = (s) => { if (!seen.has(s)) seen.set(s, parse(s) || (() => { cv = cv || document.createElement('canvas').getContext('2d', { willReadFrequently: true }); cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; })()); return seen.get(s); };
  const opa = (el) => { let o = 1; for (let a = el; a && a.nodeType === 1; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity); return o; };
  const doc = document.documentElement, rootBg = rgba(getComputedStyle(doc).backgroundColor);
  const bodyBg = document.body ? rgba(getComputedStyle(document.body).backgroundColor) : [0, 0, 0, 0];
  const canvas = over(rootBg[3] > 0 ? rootBg : bodyBg, [255, 255, 255]); // the page background: the root's, else the body's it takes, on white
  const SHAPES = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline']);
  const SKIP = 'script, style, noscript, template, title, desc, defs, clipPath, mask, symbol, marker, pattern';
  // the colour one element paints at (x, y), alpha and opacity in; none when it paints nothing known there
  const paint = (el, x, y) => {
    if (el === doc || (el === document.body && rootBg[3] === 0) || el instanceof SVGTextContentElement) return null; // the canvas, or another text
    const s = getComputedStyle(el); let c;
    if (el instanceof SVGElement) {
      if (el.localName === 'svg') c = rgba(s.backgroundColor);
      else {
        if (!SHAPES.has(el.localName) || s.fill === 'none' || s.fill.startsWith('url')) return null;
        const m = el.getScreenCTM();
        if (m && el.isPointInFill && !el.isPointInFill(new DOMPoint(x, y).matrixTransform(m.inverse()))) return null; // hit on its stroke only
        c = rgba(s.fill); c = [c[0], c[1], c[2], c[3] * parseFloat(s.fillOpacity)];
      }
    } else if (/^(img|canvas|video|iframe|object|embed)$/.test(el.localName) || s.backgroundImage !== 'none') return null; // nothing known to read
    else c = rgba(s.backgroundColor);
    const a = c[3] * opa(el);
    return a > 0 ? [c[0], c[1], c[2], a] : null;
  };
  // what is drawn under a text at (x, y): every element there below the text in paint order (its own element first, so its
  // own background counts), composited down to the first opaque one or the page background; when the text's element is not
  // in the hit stack, the elements holding it or before it in the page stand in for the paint order
  const under = (p, x, y) => {
    const stack = document.elementsFromPoint(x, y), own = p.closest('text') || p, i = stack.findIndex((e) => e === p || e === own);
    const below = i >= 0 ? stack.slice(i) : stack.filter((e) => e.contains(p) || e.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    const layers = [];
    for (const e of below) { const c = paint(e, x, y); if (!c) continue; layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((acc, c) => over(c, acc), canvas);
  };
  const out = { min_font_px: null, min_contrast_body: null, min_contrast_large: null, texts: 0, below: [] };
  const least = (k, v) => { out[k] = out[k] === null ? round(v) : Math.min(out[k], round(v)); };
  // every element is hit-tested while measuring (a label layer may be pointer-events: none), the page put back after
  const hit = document.createElement('style'); hit.textContent = '*{pointer-events:auto!important}'; doc.appendChild(hit);
  const sx = scrollX, sy = scrollY;
  try {
    const w = document.createTreeWalker(document.body || doc, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const t = n.textContent.trim(), p = n.parentElement;
      if (!t || !p || p.closest(SKIP)) continue;
      const s = getComputedStyle(p), svg = p instanceof SVGElement;
      if (s.visibility !== 'visible' || (p.checkVisibility && !p.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
      if (svg && s.fill === 'none') continue;
      const o = opa(p), g = document.createRange(); g.selectNodeContents(n);
      const box = () => [...g.getClientRects()].find((b) => b.width > 0 && b.height > 0);
      let r = box(); if (!r || o === 0) continue;
      const known = !(svg && s.fill.startsWith('url')), c = known ? rgba(svg ? s.fill : s.color) : null;
      const a = known ? c[3] * (svg ? parseFloat(s.fillOpacity) : 1) * o : 1;
      if (a === 0) continue;
      // the size as rendered: an svg's user units scaled to its box (viewBox and transforms, getScreenCTM)
      const m = p instanceof SVGGraphicsElement ? p.getScreenCTM() : null;
      const px = parseFloat(s.fontSize) * (m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1), weight = parseFloat(s.fontWeight) || 400;
      out.texts += 1; least('min_font_px', px);
      let k = null;
      if (known) {
        let x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) { scrollTo(scrollX + x - innerWidth / 2, scrollY + y - innerHeight / 2); r = box(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
        let back = under(p, x, y);
        // an svg text drawn over its own stroke (paint-order: stroke, a halo) reads against the stroke
        if (svg && s.stroke !== 'none' && !s.stroke.startsWith('url') && parseFloat(s.strokeWidth) > 0 && /^stroke/.test(s.paintOrder)) {
          const h = rgba(s.stroke); back = over([h[0], h[1], h[2], h[3] * parseFloat(s.strokeOpacity) * o], back);
        }
        k = ratio(over([c[0], c[1], c[2], a], back), back);
        least(large(px, weight) ? 'min_contrast_large' : 'min_contrast_body', k);
      }
      if ((round(px) < FONT || (k !== null && round(k) < (large(px, weight) ? LARGE : BODY))) && out.below.length < 8) {
        const layer = p.closest('[data-layer]')?.getAttribute('data-layer') || '-';
        out.below.push(`${t.slice(0, 14)} ${round(px)}px ${k === null ? '?' : round(k)}:1 ${layer}`);
      }
    }
  } finally { hit.remove(); scrollTo(sx, sy); }
  return JSON.stringify(out);
}
