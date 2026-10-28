() => { // publication check: SVG text that leaves its svg box, and text boxes that overlap inside one svg
  const out = [];
  document.querySelectorAll('svg').forEach((svg, si) => {
    const r = svg.getBoundingClientRect(); const ts = [...svg.querySelectorAll('text')].map(t => [t, t.getBoundingClientRect()]);
    ts.forEach(([t, b]) => { if (b.width && (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1)) out.push(`clip svg${si}: ${t.textContent}`); });
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i][1], b = ts[j][1];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 3) out.push(`overlap svg${si}: ${ts[i][0].textContent} | ${ts[j][0].textContent}`);
    }
  });
  const cs = [...document.querySelectorAll('.co, .inote')].map(e => [e, e.getBoundingClientRect()]);  // HTML notes: callouts beside a hero, notes over line art
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i][1], b = cs[j][1];
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) out.push(`overlap callout: ${cs[i][0].textContent.slice(0, 12)} | ${cs[j][0].textContent.slice(0, 12)}`);
  }
  return out.join('\n') || 'clean';
}
