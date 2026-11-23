(pure) => { // page check: every visible text as laid out (html and svg alike), its size as rendered and its contrast with what is drawn under it; measured here, judged by layer 1
  // A text whose contrast cannot be read is counted unmeasured, never read against the page ground instead: a fill by url()
  // (a gradient or pattern), an image, embedded content, a background image or an svg image/use under it before an opaque
  // colour, no element at its point, a background image on the page ground itself (html's or body's) where nothing opaque
  // comes between, a text drawn as an outline only (fill none, a stroke), a text painted in a -webkit-text-fill-color other
  // than the colour read or clipped to a background (background-clip: text), and text a ::before or ::after prints; layer 1
  // fails text_contrast on any.
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
  // a value to two decimals rounded down, as reported: at or above a floor (each has two decimals) exactly when the value
  // itself is, so a 4.495 is never reported as a passing 4.5 (the 1e-9 only absorbs the float error of the * 100)
  const down = (x) => Math.floor(x * 100 + 1e-9) / 100;
  // what a ::before or ::after prints: a quoted string or a generated value (counter(), attr()); none, normal and "" print nothing
  const pseudoText = (content) => !!content && content !== 'none' && content !== 'normal' && !/^(""|'')$/.test(String(content).trim());
  // an element whose paint at a point is no one known colour: an html image or embedded content or a background image
  // (the svg root's too), an svg image, use (its shapes are not hit one by one) or foreignObject, a fill by url()
  const unreadable = (name, svg, fill, backgroundImage) => (svg && name !== 'svg')
    ? /^(image|use|foreignObject)$/.test(name) || String(fill).startsWith('url')
    : /^(img|canvas|video|iframe|object|embed)$/.test(name) || (!!backgroundImage && backgroundImage !== 'none');
  // an svg text with no fill that strokes its outline: seen, its contrast not read here
  const outlined = (fill, stroke, width) => fill === 'none' && !!stroke && stroke !== 'none' && parseFloat(width) > 0;
  // why a text's paint is not the colour read (its color in html, its fill in svg), '' when it is: clipped to a background
  // (background-clip: text on it or a box holding it, the background showing through the glyphs), or a
  // -webkit-text-fill-color set apart from that colour (html: other than its color; svg: other than both its color, which
  // the property takes by default, and its fill); the colours come as the same normalised form
  const apart = (svg, textFill, color, fill, clipped) => clipped ? 'background-clip: text'
    : (svg ? textFill !== color && textFill !== fill : textFill !== color) ? '-webkit-text-fill-color' : '';
  // whether the page ground itself (html's or body's own background, painted under everything) holds an image
  const groundImage = (htmlImage, bodyImage) => [htmlImage, bodyImage].some((v) => !!v && v !== 'none');
  if (pure === 'pure') return { FONT, BODY, LARGE, luminance, ratio, large, over, parse, down, pseudoText, unreadable, outlined, apart, groundImage };
  // a computed colour Chrome does not give as rgb() (color(), oklch()...) is read back from a one-pixel canvas
  let cv; const seen = new Map();
  const rgba = (s) => { if (!seen.has(s)) seen.set(s, parse(s) || (() => { cv = cv || document.createElement('canvas').getContext('2d', { willReadFrequently: true }); cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; })()); return seen.get(s); };
  const opa = (el) => { let o = 1; for (let a = el; a && a.nodeType === 1; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity); return o; };
  const doc = document.documentElement, rootBg = rgba(getComputedStyle(doc).backgroundColor);
  const bodyBg = document.body ? rgba(getComputedStyle(document.body).backgroundColor) : [0, 0, 0, 0];
  const canvas = over(rootBg[3] > 0 ? rootBg : bodyBg, [255, 255, 255]); // the page background: the root's, else the body's it takes, on white
  // html and body are read as the canvas's colour (paint skips them as the canvas), so an image either sets on itself is
  // known here: a text it shows under, nothing opaque between, is unmeasured
  const ground = groundImage(getComputedStyle(doc).backgroundImage, document.body && getComputedStyle(document.body).backgroundImage);
  const SHAPES = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline']);
  const SKIP = 'script, style, noscript, template, title, desc, defs, clipPath, mask, symbol, marker, pattern';
  // the colour one element paints at (x, y), alpha and opacity in; none when it paints nothing there, UNREAD when what it
  // paints there is no colour known (unreadable)
  const UNREAD = 'unread';
  const paint = (el, x, y) => {
    if (el === doc || (el === document.body && rootBg[3] === 0) || el instanceof SVGTextContentElement) return null; // the canvas, or another text
    const s = getComputedStyle(el), svg = el instanceof SVGElement; let c;
    if (svg && SHAPES.has(el.localName)) {
      if (s.fill === 'none') return null;
      const m = el.getScreenCTM();
      if (m && el.isPointInFill && !el.isPointInFill(new DOMPoint(x, y).matrixTransform(m.inverse()))) return null; // hit on its stroke only
    }
    if (unreadable(el.localName, svg, s.fill, s.backgroundImage)) return opa(el) > 0 ? UNREAD : null;
    if (svg && el.localName !== 'svg') {
      if (!SHAPES.has(el.localName)) return null; // a line, a group: no fill of its own at a point
      c = rgba(s.fill); c = [c[0], c[1], c[2], c[3] * parseFloat(s.fillOpacity)];
    } else c = rgba(s.backgroundColor);
    const a = c[3] * opa(el);
    return a > 0 ? [c[0], c[1], c[2], a] : null;
  };
  // what is drawn under a text at (x, y): every element there below the text in paint order (its own element first, so its
  // own background counts), composited down to the first opaque one or the page background; when the text's element is not
  // in the hit stack, the elements holding it or before it in the page stand in for the paint order; why it is unmeasured (a
  // string) when nothing is hit there, an unreadable paint comes before an opaque colour, or the composite reaches a page
  // ground that holds an image
  const under = (p, x, y) => {
    const stack = document.elementsFromPoint(x, y), own = p.closest('text') || p, i = stack.findIndex((e) => e === p || e === own);
    if (!stack.length) return 'no colour known under it';
    const below = i >= 0 ? stack.slice(i) : stack.filter((e) => e.contains(p) || e.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    const layers = [];
    let opaque = false;
    for (const e of below) { const c = paint(e, x, y); if (!c) continue; if (c === UNREAD) return 'no colour known under it'; layers.push(c); if (c[3] >= 1) { opaque = true; break; } }
    if (!opaque && ground) return 'image on the page ground';
    return layers.reduceRight((acc, c) => over(c, acc), canvas);
  };
  // whether a background is clipped to the text of an element: background-clip: text on it or on a box holding it
  const clippedToText = (el) => {
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) { const c = getComputedStyle(a); if (c.backgroundClip === 'text' || c.webkitBackgroundClip === 'text') return true; }
    return false;
  };
  const key = (v) => String(rgba(v));
  const out = { min_font_px: null, min_contrast_body: null, min_contrast_large: null, texts: 0, unmeasured: 0, below: [] };
  const least = (k, v) => { out[k] = out[k] === null ? v : Math.min(out[k], v); };
  const list = (t, px, k, el, why) => {
    if (out.below.length >= 8) return;
    const layer = el.closest('[data-layer]')?.getAttribute('data-layer') || '-';
    out.below.push(`${t.slice(0, 14)} ${down(px)}px ${why ? `unmeasured (${why})` : `${down(k)}:1`} ${layer}`);
  };
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
      const outline = svg && outlined(s.fill, s.stroke, s.strokeWidth);
      if (svg && s.fill === 'none' && !outline) continue;
      const o = opa(p), g = document.createRange(); g.selectNodeContents(n);
      const box = () => [...g.getClientRects()].find((b) => b.width > 0 && b.height > 0);
      let r = box(); if (!r || o === 0) continue;
      // a text clipped to a background or painted in its own text-fill colour is checked first: its color may be transparent
      const urlFill = svg && s.fill.startsWith('url');
      const off = outline || urlFill ? '' : apart(svg, key(s.webkitTextFillColor), key(s.color), svg ? key(s.fill) : '', clippedToText(p));
      const known = !outline && !urlFill && !off, c = known ? rgba(svg ? s.fill : s.color) : null;
      const a = known ? c[3] * (svg ? parseFloat(s.fillOpacity) : 1) * o : 1;
      if (a === 0) continue;
      // the size as rendered: an svg's user units scaled to its box (viewBox and transforms, getScreenCTM)
      const m = p instanceof SVGGraphicsElement ? p.getScreenCTM() : null;
      const px = parseFloat(s.fontSize) * (m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1), weight = parseFloat(s.fontWeight) || 400;
      out.texts += 1; least('min_font_px', px);
      let k = null, why = outline ? 'outline only' : off || (known ? '' : 'fill by url()');
      if (known) {
        let x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 2 || y < 2 || x >= innerWidth - 2 || y >= innerHeight - 2) { scrollTo(scrollX + x - innerWidth / 2, scrollY + y - innerHeight / 2); r = box(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
        let back = under(p, x, y);
        // an svg text drawn over its own stroke (paint-order: stroke, a halo) reads against the stroke
        if (Array.isArray(back) && svg && s.stroke !== 'none' && !s.stroke.startsWith('url') && parseFloat(s.strokeWidth) > 0 && /^stroke/.test(s.paintOrder)) {
          const h = rgba(s.stroke); back = over([h[0], h[1], h[2], h[3] * parseFloat(s.strokeOpacity) * o], back);
        }
        if (Array.isArray(back)) { k = ratio(over([c[0], c[1], c[2], a], back), back); least(large(px, weight) ? 'min_contrast_large' : 'min_contrast_body', k); }
        else why = back;
      }
      if (why) out.unmeasured += 1;
      if (why || px < FONT || (k !== null && k < (large(px, weight) ? LARGE : BODY))) list(t, px, k, p, why);
    }
    // text a ::before or ::after prints is in no text node: its size is measured, its contrast is not read here
    for (const el of (document.body || doc).querySelectorAll('*')) {
      if (el.closest(SKIP)) continue;
      const own = getComputedStyle(el);
      if (own.display === 'none' || own.visibility !== 'visible' || opa(el) === 0) continue;
      for (const at of ['::before', '::after']) {
        const s = getComputedStyle(el, at);
        if (s.display === 'none' || !pseudoText(s.content)) continue;
        const px = parseFloat(s.fontSize);
        out.texts += 1; out.unmeasured += 1; least('min_font_px', px);
        list(`${at} ${s.content}`, px, null, el, at + ' text');
      }
    }
  } finally { hit.remove(); scrollTo(sx, sy); }
  for (const k of ['min_font_px', 'min_contrast_body', 'min_contrast_large']) if (out[k] !== null) out[k] = down(out[k]);
  return JSON.stringify(out);
}
