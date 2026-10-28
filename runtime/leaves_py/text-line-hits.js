() => { // text-line-clash.js's hit test, its thresholds unchanged, kept per hit: every data stroke and box edge each text meets, with
  // the element's layer and data-line and the text's data-on, so the bake can tell the base map and a text's own line from the rest.
  // Then qa-layers.js's line test, its texts, paths and 3 px sampling unchanged, kept per path: each route or flow path a text meets.
  const lum = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); if (m) return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255; const h = /^#([0-9a-f]{3,6})$/i.exec(c); if (!h) return 0.5; let x = h[1]; if (x.length === 3) x = [...x].map((d) => d + d).join(''); return (0.299 * parseInt(x.slice(0, 2), 16) + 0.587 * parseInt(x.slice(2, 4), 16) + 0.114 * parseInt(x.slice(4, 6), 16)) / 255; };
  const lay = (e) => (e.closest('[data-layer]') || { dataset: { layer: '?' } }).dataset.layer, res = [];
  document.querySelectorAll('svg').forEach((svg, si) => {
    if (svg.closest('defs,clipPath,mask')) return;
    const sb = svg.getBoundingClientRect(), texts = [...svg.querySelectorAll('text')].map((t) => [t, t.getBoundingClientRect()]).filter(([, r]) => r.width > 0);
    const strokes = [], rects = [];
    svg.querySelectorAll('line,polyline,path,rect,circle').forEach((e) => {
      if (e.closest('defs,clipPath,mask,text')) return;
      const cs = getComputedStyle(e), stroke = cs.stroke, sw = parseFloat(cs.strokeWidth) || 0, op = parseFloat(cs.strokeOpacity) * parseFloat(cs.opacity);
      if (e.tagName === 'rect' && cs.fill !== 'none') { const r = e.getBoundingClientRect(); if (r.width * r.height < sb.width * sb.height * 0.5 && r.width > 0) rects.push([e, r]); }
      if (stroke === 'none' || sw === 0 || !(e.getTotalLength)) return;
      const l = lum(stroke); if (l > 0.97) return;
      const kind = l > 0.88 || op < 0.2 ? 'grid' : 'data';
      let len; try { len = e.getTotalLength(); } catch { return; } if (!(len > 0) || len > 20000) return;
      const m = e.getScreenCTM(); if (!m) return; const pts = []; const step = Math.max(1.5, len / 800);
      for (let d = 0; d <= len; d += step) { const p = e.getPointAtLength(d); pts.push([m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f]); }
      if (kind === 'data') strokes.push({ e, pts, half: sw * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) / 2 });
    });
    let data = 0, edge = 0; const hits = [];
    const hit = (t, kind, e) => hits.push({ kind, text: t.textContent.slice(0, 30), text_layer: lay(t), on: t.getAttribute('data-on') || '', el: e.tagName, el_layer: lay(e), line: e.getAttribute('data-line') || '' });
    for (const [t, r] of texts) {
      const x0 = r.left + 2, x1 = r.right - 2, y0 = r.top + 2, y1 = r.bottom - 2; if (x1 <= x0 || y1 <= y0) continue;
      const on = strokes.filter((s) => s.pts.some(([x, y]) => x > x0 - s.half && x < x1 + s.half && y > y0 - s.half && y < y1 + s.half));
      if (on.length) { data++; on.forEach((s) => hit(t, 'line', s.e)); }
      const ta = r.width * r.height;
      const at = rects.filter(([, q]) => { const ox = Math.min(r.right, q.right) - Math.max(r.left, q.left), oy = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top); return ox > 2 && oy > 2 && ox * oy < ta * 0.9 && !(q.left <= r.left && q.right >= r.right && q.top <= r.top && q.bottom >= r.bottom); });
      if (at.length) { edge++; at.forEach(([e]) => hit(t, 'edge', e)); }
    }
    res.push({ svg: si, text_on_data_line: data, text_straddles_rect_edge: edge, hits });
  });
  const T = [...document.querySelectorAll('[data-layer] text, [data-layer] .rc, [data-layer].hu, [data-layer] .hu')]
    .map(e => [e, e.getBoundingClientRect(), lay(e)]).filter(t => t[1].width && getComputedStyle(t[0]).display != 'none');
  const L = [...document.querySelectorAll('[data-layer="map.routes"] path, [data-layer="map.flows"] path')].filter(p => p.getAttribute('stroke') && p.getAttribute('stroke') != 'none');
  const paths = [];
  for (const p of L) {
    const m = p.getScreenCTM(), n = p.getTotalLength(), pl = lay(p), met = new Set();
    for (let s = 0; s < n; s += 3) {
      const q = p.getPointAtLength(s), x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
      for (const [e, b, tl] of T) {
        if (x > b.left + 2 && x < b.right - 2 && y > b.top + 2 && y < b.bottom - 2 && !met.has(e)) {
          met.add(e); paths.push({ text: e.textContent, text_layer: tl, on: e.getAttribute('data-on') || '', el_layer: pl, line: p.getAttribute('data-line') || '' });
        }
      }
    }
  }
  return JSON.stringify({ svgs: res, paths });
}
