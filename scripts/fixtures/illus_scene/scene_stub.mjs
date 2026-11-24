// A stand-in for runtime/illus_hero/scene/scene.mjs with the same one-line contract, for scripts/test_illus_scene_wiring.py:
//   in : {scene, style, seed, figures: [{lit} | {gap: true}], box: {w, h}, palette: {ink, paper, accent}, order?: "given"}
//   out: {svg, w, h, lit, total, gaps, dropped: []} | {refused}
// (a gap marker only with order "given"; lit and total count the real figures)
// One rounded block per figure, the lit ones filled in the accent, the others outlined in the ink; only <g> and <path>, hex colours.
// seed 666 makes it misreport its lit count (the caller must refuse that reply).
import { createInterface } from 'node:readline';

const HEX = /^#[0-9a-fA-F]{6}$/;
const rl = createInterface({ input: process.stdin });
rl.once('line', (line) => {
  let out;
  try {
    const r = JSON.parse(line);
    const why = [];
    if (r.scene !== 'queue') why.push(`scene ${r.scene}`);
    if (!['ink', 'iso', 'geo'].includes(r.style)) why.push(`style ${r.style}`);
    if (!Number.isInteger(r.seed)) why.push('seed');
    const real = Array.isArray(r.figures) ? r.figures.filter((f) => !f.gap) : [];
    if (r.order !== undefined && r.order !== 'given') why.push(`order ${r.order}`);
    if (!Array.isArray(r.figures) || real.length < 1 || real.length > 60 || !real.every((f) => typeof f.lit === 'boolean') || (r.order !== 'given' && real.length !== r.figures.length)) why.push('figures');
    if (!(r.box && r.box.w > 0 && r.box.h > 0)) why.push('box');
    for (const k of ['ink', 'paper', 'accent']) if (!HEX.test((r.palette || {})[k] || '')) why.push(`palette.${k}`);
    if (why.length) out = { refused: why.join('; ') };
    else {
      const n = r.figures.length, step = r.box.w / (n + 1), hh = r.box.h * 0.5, ww = Math.min(step * 0.6, 40);
      const parts = r.figures.map((f, i) => {
        const x = (step * (i + 1) - ww / 2).toFixed(2), y = (r.box.h * 0.3).toFixed(2);
        const d = `M${x} ${y} L${(+x + ww).toFixed(2)} ${y} L${(+x + ww).toFixed(2)} ${(+y + hh).toFixed(2)} L${x} ${(+y + hh).toFixed(2)} Z`;
        if (f.gap) return `<path d="M${x} ${(+y + hh).toFixed(2)} L${(+x + ww).toFixed(2)} ${(+y + hh).toFixed(2)}" stroke="${r.palette.ink}" stroke-width="1"/>`;
        return f.lit ? `<path d="${d}" fill="${r.palette.accent}"/>` : `<path d="${d}" fill="none" stroke="${r.palette.ink}" stroke-width="1.5"/>`;
      });
      const lit = real.filter((f) => f.lit).length;
      out = { svg: `<g transform="translate(0,0)">${parts.join('')}</g>`, w: r.box.w, h: r.box.h, lit: r.seed === 666 ? lit + 1 : lit, total: real.length, gaps: r.figures.length - real.length, dropped: [] };
    }
  } catch (e) { out = { refused: `not JSON: ${e.message}` }; }
  process.stdout.write(JSON.stringify(out) + '\n');
  rl.close();
});
