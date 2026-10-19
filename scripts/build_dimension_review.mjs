#!/usr/bin/env node
// A blind page for a person to compare two renderings of the same story, one item at a time, and then as a whole. The two files are copied under
// neutral names (a.<ext>, b.<ext>) in the review folder, which side is "A" is drawn at random, and the key (which one is which) goes next to the
// folder, not in it. After all six answers are given, the page shows the `news review` commands to type in a terminal; the page writes no record
// itself (a record is only saved by a person, through the hash confirmation of `news review`).
// Known weakness, on purpose not hidden: the command text and the mapping sit in the page's script block, so a reader of the page source can see which
// side is which. The visible text, the file names, the image paths, alt text and HTML attributes carry no side-identifying word.
// usage: build_dimension_review.mjs OUT_DIR --baseline FILE --candidate FILE [--baseline-ref REL] [--candidate-ref REL] [--run RUN_DIR] [--seed TEXT]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DIMENSIONS = [
  ['informativeness', '信息量:谁让人学到的东西更多'],
  ['chart_choice', '图表选择:谁选的图表更合适'],
  ['gist_at_a_glance', '一眼看懂:谁让人更快抓住要点'],
  ['numbers_units_sources', '数字、单位、来源:谁交代得更清楚'],
  ['looks_vs_reference', '好看:谁更接近参考图的水准'],
];
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function buildDimensionReview({ outDir, baseline, candidate, baselineRef, candidateRef, run = '<run folder>', seed }) {
  const salt = seed ?? crypto.randomBytes(16).toString('hex');
  const rank = (label) => crypto.createHash('sha256').update(`${salt}:${label}`).digest('hex');
  const order = ['baseline', 'candidate'].sort((a, b) => rank(a).localeCompare(rank(b), 'en-US'));
  const source = { baseline, candidate };
  const refs = { baseline: baselineRef ?? baseline, candidate: candidateRef ?? candidate };
  const sideOf = {}; const files = {};
  order.forEach((which, i) => {
    const side = i === 0 ? 'A' : 'B';
    const ext = path.extname(source[which]).toLowerCase();
    sideOf[side] = which; files[side] = `${side.toLowerCase()}${ext}`;
  });
  fs.mkdirSync(outDir, { recursive: true });
  for (const side of ['A', 'B']) fs.copyFileSync(source[sideOf[side]], path.join(outDir, files[side]));
  const keyPath = `${path.resolve(outDir)}.key.json`;
  fs.writeFileSync(keyPath, JSON.stringify({ schema_version: '1.0.0', salt, sides: sideOf }, null, 2) + '\n');
  const items = [...DIMENSIONS.map(([id, text]) => [id, text]), ['', '总体:如果只能选一个,选哪个']];
  const rows = items.map(([id, text], i) => `<fieldset data-item="${i}"><legend>${esc(text)}</legend><label><input type="radio" name="q${i}" value="A"> A</label> <label><input type="radio" name="q${i}" value="B"> B</label> <label><input type="radio" name="q${i}" value="tie"> 差不多</label></fieldset>`).join('');
  const script = `
const SIDE = ${JSON.stringify(sideOf)}; const RUN = ${JSON.stringify(run)};
const REF = ${JSON.stringify(refs)}; const DIMS = ${JSON.stringify(items.map(([id]) => id))};
const pref = (v) => (v === 'tie' ? 'tie' : SIDE[v]);
const out = document.getElementById('commands'); const msg = document.getElementById('msg');
document.getElementById('show').addEventListener('click', () => {
  const answers = DIMS.map((_, i) => { const c = document.querySelector('input[name=q' + i + ']:checked'); return c ? c.value : null; });
  if (answers.some((a) => a === null)) { msg.textContent = '六项都要选。'; return; }
  msg.textContent = '在终端里逐条运行,把 <你的名字> 换成你自己的名字;每条都要你输入哈希确认才会保存。';
  out.textContent = answers.map((a, i) => 'news review ' + RUN + ' --baseline ' + REF.baseline + ' --candidate ' + REF.candidate + ' --reviewer <你的名字>' + (DIMS[i] ? ' --dimension ' + DIMS[i] : '') + ' --preference ' + pref(a)).join('\\n');
});`;
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>盲评</title><style>body{font-family:sans-serif;margin:24px;max-width:1500px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:24px}img{display:block;width:100%;height:auto}fieldset{margin:12px 0;padding:12px}pre{background:#f4f4f4;padding:12px;white-space:pre-wrap}</style><h1>盲评</h1><p>两张图讲的是同一件事,谁是谁不告诉你。先看图,再逐项选,最后一项是总体。</p><main><section><h2>A</h2><img src="${files.A}" alt="图 A"></section><section><h2>B</h2><img src="${files.B}" alt="图 B"></section></main><form onsubmit="return false">${rows}<button type="button" id="show">生成命令</button></form><p id="msg" aria-live="polite"></p><pre id="commands"></pre><script>${script}</script></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  return { indexPath: path.join(outDir, 'index.html'), keyPath, sideOf, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2); const outDir = a[0];
  const opt = (name) => { const i = a.indexOf(`--${name}`); return i > 0 ? a[i + 1] : undefined; };
  if (!outDir || !opt('baseline') || !opt('candidate')) { console.error('usage: build_dimension_review.mjs OUT_DIR --baseline FILE --candidate FILE [--baseline-ref REL] [--candidate-ref REL] [--run RUN_DIR] [--seed TEXT]'); process.exit(2); }
  const r = buildDimensionReview({ outDir, baseline: opt('baseline'), candidate: opt('candidate'), baselineRef: opt('baseline-ref'), candidateRef: opt('candidate-ref'), run: opt('run'), seed: opt('seed') });
  console.log(r.indexPath); console.log(`key (keep it out of the page's folder): ${r.keyPath}`);
}
