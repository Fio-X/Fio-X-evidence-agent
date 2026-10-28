() => { // layer check: every text and callout knows its layer (nearest data-layer); reports text×text overlaps and text sitting on a line,
  // each as "layerA × layerB: what | what", so the layer at fault is named. Run on page.layers.html.
  const lay = e => (e.closest('[data-layer]') || {dataset: {layer: '?'}}).dataset.layer, out = [];
  const T = [...document.querySelectorAll('[data-layer] text, [data-layer] .rc, [data-layer].hu, [data-layer] .hu')]
    .map(e => [e, e.getBoundingClientRect(), lay(e)]).filter(t => t[1].width && getComputedStyle(t[0]).display != 'none');
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
    const a = T[i][1], b = T[j][1];
    if (T[i][0].contains(T[j][0]) || T[j][0].contains(T[i][0])) continue;
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3)
      out.push(`${T[i][2]} × ${T[j][2]}: ${T[i][0].textContent.slice(0, 14)} | ${T[j][0].textContent.slice(0, 14)}`);
  }
  // lines: sample each stroked path of the route and flow layers; a sample inside a text box (shrunk by 2px) is a hit
  const L = [...document.querySelectorAll('[data-layer="map.routes"] path, [data-layer="map.flows"] path')].filter(p => p.getAttribute('stroke') && p.getAttribute('stroke') != 'none');
  const seen = new Set();
  for (const p of L) {
    const m = p.getScreenCTM(), n = p.getTotalLength(), pl = lay(p);
    for (let s = 0; s < n; s += 3) {
      const q = p.getPointAtLength(s), x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
      for (const [e, b, tl] of T) {
        if (x > b.left + 2 && x < b.right - 2 && y > b.top + 2 && y < b.bottom - 2) {
          const k = tl + e.textContent + pl; if (!seen.has(k)) { seen.add(k); out.push(`${tl} × ${pl} line: ${e.textContent.slice(0, 14)}`); }
        }
      }
    }
  }
  for (const g of document.querySelectorAll('[data-left]')) out.push(`${lay(g)} does not fit: ${g.dataset.left.split('|').join(', ')}`);
  return out.join('\n') || 'clean';
}
