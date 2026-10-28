() => { // text-on-line check (the qa.js companion): a text box crossed by a stroke, or straddling the edge of a filled rect. One result per svg.
  const lum = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); if (m) return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255; const h = /^#([0-9a-f]{3,6})$/i.exec(c); if (!h) return 0.5; let x = h[1]; if (x.length === 3) x = [...x].map((d) => d + d).join(''); return (0.299 * parseInt(x.slice(0, 2), 16) + 0.587 * parseInt(x.slice(2, 4), 16) + 0.114 * parseInt(x.slice(4, 6), 16)) / 255; };
  const res = [];
  document.querySelectorAll('svg').forEach((svg, si) => {
    if (svg.closest('defs,clipPath,mask')) return;
    const sb = svg.getBoundingClientRect(), texts = [...svg.querySelectorAll('text')].map((t) => [t, t.getBoundingClientRect()]).filter(([, r]) => r.width > 0);
    const strokes = [], rects = [];
    svg.querySelectorAll('line,polyline,path,rect,circle').forEach((e) => {
      if (e.closest('defs,clipPath,mask,text')) return;
      const cs = getComputedStyle(e), stroke = cs.stroke, sw = parseFloat(cs.strokeWidth) || 0, op = parseFloat(cs.strokeOpacity) * parseFloat(cs.opacity);
      if (e.tagName === 'rect' && cs.fill !== 'none') { const r = e.getBoundingClientRect(); if (r.width * r.height < sb.width * sb.height * 0.5 && r.width > 0) rects.push(r); }
      if (stroke === 'none' || sw === 0 || !(e.getTotalLength)) return;
      const l = lum(stroke); if (l > 0.97) return;                       // white borders and background hairlines
      const kind = l > 0.88 || op < 0.2 ? 'grid' : 'data';
      let len; try { len = e.getTotalLength(); } catch { return; } if (!(len > 0) || len > 20000) return;
      const m = e.getScreenCTM(); if (!m) return; const pts = []; const step = Math.max(1.5, len / 800);
      for (let d = 0; d <= len; d += step) { const p = e.getPointAtLength(d); pts.push([m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f]); }
      strokes.push({ kind, pts, half: sw * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) / 2, id: e.tagName + (e.getAttribute('data-role') ? ':' + e.getAttribute('data-role') : '') });
    });
    let data = 0, grid = 0, edge = 0; const ex = [];
    for (const [t, r] of texts) {
      const x0 = r.left + 2, x1 = r.right - 2, y0 = r.top + 2, y1 = r.bottom - 2; if (x1 <= x0 || y1 <= y0) continue;
      let hit = null;
      for (const s of strokes) { if (s.pts.some(([x, y]) => x > x0 - s.half && x < x1 + s.half && y > y0 - s.half && y < y1 + s.half)) { if (!hit || (s.kind === 'data' && hit.kind !== 'data')) hit = s; if (hit.kind === 'data') break; } }
      if (hit) { if (hit.kind === 'data') { data++; if (ex.length < 6) ex.push('line: ' + t.textContent.slice(0, 14) + ' x ' + hit.id); } else grid++; }
      const ta = r.width * r.height;
      for (const q of rects) { const ox = Math.min(r.right, q.right) - Math.max(r.left, q.left), oy = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top); if (ox > 2 && oy > 2 && ox * oy < ta * 0.9 && !(q.left <= r.left && q.right >= r.right && q.top <= r.top && q.bottom >= r.bottom)) { edge++; if (ex.length < 6) ex.push('edge: ' + t.textContent.slice(0, 14)); break; } }
    }
    res.push({ svg: si, texts: texts.length, strokes: strokes.length, text_on_data_line: data, text_on_grid: grid, text_straddles_rect_edge: edge, examples: ex });
  });
  return JSON.stringify(res);
}
