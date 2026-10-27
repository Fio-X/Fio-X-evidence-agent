// New route whole-page layouts (NEWSROOM_NEXT): the registry of page layouts a page is composed in, each with a slot for the big
// number, an illustration, the charts with their legends and the short notes. A layout only places what the page already holds:
// the numbers come from the page plan's filled hero and the chart rows, the words from the page's own modules, the charts are the
// rendered chart SVGs as they are. The illustration is a line drawing picked from a registry by the page's topic words.
import { HOUSE_FONT_SANS, HOUSE_FONT_SANS_TABULAR, chartNameDisplay, chartValueFormatter } from "./viz.mjs";

const PAGE_W = 1440;
const MARGIN = 64;
const INNER_W = PAGE_W - 2 * MARGIN;
const INK = "#1A1A1A";
const MUTED = "#555555"; // notes and sources at page scale: 7:1 on white
const RULE = "#D9D6D0";
const PAPER = "#FFFFFF";
const WASH = "#F4F1EC";
const ACCENT = "#D0021B";
const LINE = "#3A3A3A";

const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isWide = (ch) => /[⺀-￯]/.test(ch);
const textWidth = (text, size) => [...String(text ?? "")].reduce((w, ch) => w + (isWide(ch) ? size : size * 0.56), 0);

// Lines of at most `width` px at `size`, broken between characters (Chinese) or at spaces (Latin runs stay whole).
function wrap(text, size, width) {
  const tokens = String(text ?? "").match(/[A-Za-z0-9.,%\-–()（）]+\s*|\s+|./gu) ?? [];
  const lines = [];
  let line = "";
  for (const token of tokens) {
    if (line && textWidth(line + token, size) > width) { lines.push(line.trimEnd()); line = token.trimStart(); }
    else line += token;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

function textBlock(parts, text, x, y, { size = 16, width = 400, weight = 400, fill = INK, lineH = Math.round(size * 1.55), role = "layout-text" } = {}) {
  const lines = wrap(text, size, width);
  lines.forEach((line, i) => parts.push(`<text data-role="${role}" x="${x}" y="${y + i * lineH}" font-family="${HOUSE_FONT_SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(line)}</text>`));
  return y + Math.max(0, lines.length - 1) * lineH;
}

// ---- line drawings: a hand-drawn stroke is a polyline with a small seeded wobble, drawn twice (pencil over pencil) ----
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
}
function sketchPath(points, rand, wobble = 1.2) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const steps = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 18));
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const t = k / steps;
      out.push([x1 + (x2 - x1) * t + rand() * wobble, y1 + (y2 - y1) * t + rand() * wobble]);
    }
  }
  return `M${out.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L")}`;
}
function stroke(parts, points, rand, { width = 1.6, color = LINE } = {}) {
  parts.push(`<path d="${sketchPath(points, rand)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`);
  parts.push(`<path d="${sketchPath(points, rand, 1.8)}" fill="none" stroke="${color}" stroke-width="${(width * 0.45).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`);
}
const circlePts = (cx, cy, r, n = 28) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
function hills(parts, rand, w, base) {
  stroke(parts, [[0, base], [w * 0.18, base - 26], [w * 0.36, base - 8], [w * 0.55, base - 34], [w * 0.78, base - 12], [w, base - 22]], rand, { width: 1.4 });
  stroke(parts, [[0, base + 22], [w, base + 22]], rand, { width: 1 });
}

function turbine(parts, rand, x, base, h) {
  const top = base - h;
  stroke(parts, [[x - 5, base], [x - 2, top], [x + 2, top], [x + 5, base]], rand);
  stroke(parts, circlePts(x, top, 5, 12), rand, { width: 1.2 });
  for (const a of [-90, 30, 150]) {
    const r = (a * Math.PI) / 180, len = h * 0.55;
    const tip = [x + len * Math.cos(r), top + len * Math.sin(r)];
    const side = [x + 9 * Math.cos(r + 0.35) + (len * 0.35) * Math.cos(r), top + 9 * Math.sin(r + 0.35) + (len * 0.35) * Math.sin(r)];
    stroke(parts, [[x, top], side, tip, [x, top]], rand, { width: 1.3 });
  }
}
function solarRow(parts, rand, x, base, n) {
  for (let i = 0; i < n; i++) {
    const x0 = x + i * 62;
    stroke(parts, [[x0, base - 30], [x0 + 52, base - 44], [x0 + 60, base - 22], [x0 + 8, base - 8], [x0, base - 30]], rand, { width: 1.3 });
    for (let k = 1; k < 4; k++) stroke(parts, [[x0 + k * 13, base - 33 - k * 3.4], [x0 + 8 + k * 13, base - 11 - k * 3.4]], rand, { width: 0.7 });
    stroke(parts, [[x0 + 30, base - 15], [x0 + 30, base]], rand, { width: 1.1 });
  }
}
function pylon(parts, rand, x, base, h) {
  const top = base - h;
  stroke(parts, [[x - 18, base], [x - 4, top], [x + 4, top], [x + 18, base]], rand);
  stroke(parts, [[x - 26, top + 18], [x + 26, top + 18]], rand);
  stroke(parts, [[x - 20, top + 38], [x + 20, top + 38]], rand);
  for (let k = 0; k < 4; k++) stroke(parts, [[x - 16 + k * 3, base - k * h * 0.22], [x + 16 - k * 3, base - (k + 1) * h * 0.22]], rand, { width: 0.8 });
}
function ship(parts, rand, x, base, w) {
  stroke(parts, [[x, base - 30], [x + w, base - 30], [x + w - 30, base], [x + 26, base], [x, base - 30]], rand);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 7; c++) {
    const bx = x + 40 + c * ((w - 120) / 7), by = base - 52 - r * 20;
    stroke(parts, [[bx, by], [bx + (w - 130) / 7, by], [bx + (w - 130) / 7, by + 18], [bx, by + 18], [bx, by]], rand, { width: 1 });
  }
  stroke(parts, [[x + w - 70, base - 30], [x + w - 70, base - 96], [x + w - 34, base - 96], [x + w - 34, base - 30]], rand);
  stroke(parts, [[x - 30, base + 6], [x + w + 40, base + 6]], rand, { width: 0.9 });
}
function crane(parts, rand, x, base, h) {
  stroke(parts, [[x, base], [x, base - h], [x + 120, base - h], [x - 30, base - h]], rand);
  stroke(parts, [[x, base - h + 20], [x + 110, base - h]], rand, { width: 0.9 });
  stroke(parts, [[x + 90, base - h], [x + 90, base - h + 60]], rand, { width: 0.9 });
}
function factory(parts, rand, x, base) {
  stroke(parts, [[x, base], [x, base - 60], [x + 50, base - 90], [x + 50, base - 60], [x + 100, base - 90], [x + 100, base - 60], [x + 150, base - 90], [x + 150, base], [x, base]], rand);
  for (const cx of [x + 175, x + 205]) {
    stroke(parts, [[cx, base], [cx + 4, base - 150], [cx + 16, base - 150], [cx + 20, base]], rand);
    stroke(parts, [[cx + 10, base - 158], [cx + 24, base - 182], [cx + 8, base - 204], [cx + 30, base - 232]], rand, { width: 1.1 });
  }
}
function houses(parts, rand, x, base, n) {
  for (let i = 0; i < n; i++) {
    const x0 = x + i * 70, h = 46 + ((i * 37) % 30);
    stroke(parts, [[x0, base], [x0, base - h], [x0 + 28, base - h - 24], [x0 + 56, base - h], [x0 + 56, base], [x0, base]], rand);
    stroke(parts, [[x0 + 20, base], [x0 + 20, base - 22], [x0 + 36, base - 22], [x0 + 36, base]], rand, { width: 1 });
  }
}

// The registry of drawings: topic words (matched in the page title, dek and the charts' measure names) and the scene, drawn in a
// 640 x 360 box.
export const ILLUSTRATIONS = [
  { id: "energy", words: ["能源", "可再生", "电力", "发电", "风电", "光伏", "太阳能", "电"], subject: "风电机组、光伏板和输电塔的线描",
    draw(parts, rand) { hills(parts, rand, 640, 318); turbine(parts, rand, 110, 300, 190); turbine(parts, rand, 200, 292, 150); turbine(parts, rand, 290, 306, 120); solarRow(parts, rand, 340, 330, 4); pylon(parts, rand, 560, 300, 170); stroke(parts, [[586, 148], [640, 160]], rand, { width: 0.9 }); stroke(parts, [[534, 148], [470, 176]], rand, { width: 0.9 }); } },
  { id: "trade", words: ["贸易", "出口", "进口", "顺差", "逆差", "货物", "港口"], subject: "集装箱船和港口吊机的线描",
    draw(parts, rand) { ship(parts, rand, 120, 300, 420); crane(parts, rand, 60, 300, 210); crane(parts, rand, 560, 300, 180); } },
  { id: "emissions", words: ["排放", "温室", "碳", "气体", "污染"], subject: "工厂和烟囱的线描",
    draw(parts, rand) { hills(parts, rand, 640, 320); factory(parts, rand, 150, 318); houses(parts, rand, 420, 318, 3); } },
  { id: "town", words: [], subject: "街区房屋的线描",
    draw(parts, rand) { hills(parts, rand, 640, 320); houses(parts, rand, 90, 318, 7); } },
];

export function pickIllustration(words) {
  const text = words.filter(Boolean).join(" ");
  let best = ILLUSTRATIONS[ILLUSTRATIONS.length - 1], bestHits = 0;
  for (const entry of ILLUSTRATIONS) {
    const hits = entry.words.filter((w) => text.includes(w)).length;
    if (hits > bestHits) { best = entry; bestHits = hits; }
  }
  return best;
}

// The drawing at (x, y), scaled to width w; returns its height.
function drawIllustration(parts, entry, x, y, w, { frame = true } = {}) {
  const k = w / 640, h = 360 * k;
  const inner = [];
  entry.draw(inner, seeded(entry.id.length * 7919 + 17));
  if (frame) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" fill="${WASH}"/>`);
  parts.push(`<g data-role="layout-illustration" data-illustration="${entry.id}" transform="translate(${x} ${y}) scale(${k.toFixed(4)})">${inner.join("")}</g>`);
  return { h };
}

// ---- the page's content, read from the page plan and its charts ----
// visuals: [{ module, manifest, spec, rows, svg }] in page order (module = the plan's visual module, spec = the chart plan).
// Precondition: the plan has passed the page checks (the hero number among them); a layout draws its hero as given.
export function layoutContent(plan, visuals) {
  const modules = Array.isArray(plan.modules) ? plan.modules : [];
  const hero = modules.find((m) => m.type === "hero_stat") ?? null;
  const notes = modules.filter((m) => m.type === "text" && m.body).map((m) => m.body);
  const noteIds = modules.filter((m) => m.type === "text" && m.body).map((m) => String(m.id));
  const charts = visuals.map((v, i) => {
    const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(v.svg);
    return { id: v.module.id, slot: i, svg: v.svg, w: viewBox ? Number(viewBox[1]) : 1040, h: viewBox ? Number(viewBox[2]) : 600, body: v.module.body ?? "", spec: v.spec, rows: v.rows ?? [] };
  });
  const lead = charts[0];
  let ledger = [];
  // The ledger ranks one row per category: rows that span more than one series or period (or name a category twice) get no ledger.
  const spec = lead?.spec;
  const single = (f) => !f || new Set(lead.rows.map((r) => String(r[f]))).size <= 1;
  if (spec?.value_field && spec?.category_field && single(spec.series_field) && single(spec.x_field) && single(spec.reference_period_field)
    && new Set(lead.rows.map((r) => String(r[spec.category_field]))).size === lead.rows.length) {
    const names = chartNameDisplay(spec, lead.rows);
    const field = spec.value_field, cat = spec.category_field;
    const sorted = lead.rows.filter((r) => Number.isFinite(Number(r[field]))).sort((a, b) => Number(b[field]) - Number(a[field]));
    const format = chartValueFormatter(spec, sorted.map((r) => Number(r[field]))); // the chart's own shared decimals
    const pick = sorted.length > 8 ? [...sorted.slice(0, 5), null, ...sorted.slice(-3)] : sorted;
    ledger = pick.map((r) => r && { name: (names && names.display(cat, r[cat])) ?? String(r[cat]), value: format(Number(r[field])), rank: sorted.indexOf(r) + 1 });
  }
  const measure = lead?.spec?.measure_semantics?.[0]?.phenomenon ?? "";
  // The plate's lettered notes: facts read off the ledger rows (the highest and the lowest), each lettered on its ledger row too.
  // With no ledger there are no notes: a note is never free text.
  const ranked = ledger.filter(Boolean);
  const facts = ranked.length >= 2 ? [{ rank: ranked[0].rank, text: `${measure ? `${measure}最高：` : "最高："}${ranked[0].name} ${ranked[0].value}` },
    { rank: ranked.at(-1).rank, text: `${measure ? `${measure}最低：` : "最低："}${ranked.at(-1).name} ${ranked.at(-1).value}` }] : [];
  const illustration = pickIllustration([plan.title, plan.dek, ...charts.map((c) => c.spec?.measure_semantics?.[0]?.phenomenon)]);
  const sources = [...new Set(visuals.map((v) => v.manifest?.source_note).filter(Boolean))];
  return { title: plan.title ?? "", dek: plan.dek ?? "", hero: hero && { value: String(hero.value ?? ""), unit: hero.unit ?? "", label: hero.label ?? "" },
    notes, noteIds, heroId: hero ? String(hero.id) : null, facts, charts, ledger, measure, illustration, sources, total: lead?.rows?.length ?? 0 };
}

function embedChart(parts, chart, x, y, w) {
  const k = w / chart.w, h = chart.h * k;
  // Each chart keeps its own ids; prefixing them keeps two charts' gradients and clips apart on one page.
  const pre = `${String(chart.id).replace(/[^A-Za-z0-9_-]/g, "") || `chart${chart.slot}`}-`;
  const body = chart.svg.replace(/^<\?xml[^>]*>\s*/, "").replace(/^<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "")
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${pre}${id}"`).replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${pre}${id})`)
    .replace(/href="#([^"]+)"/g, (_, id) => `href="#${pre}${id}"`);
  parts.push(`<svg data-role="layout-chart" data-module="${esc(chart.id)}" x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" viewBox="0 0 ${chart.w} ${chart.h}">${body}</svg>`);
  return h;
}
function masthead(parts, c, y) {
  parts.push(`<rect x="${MARGIN}" y="${y}" width="${INNER_W}" height="6" fill="${INK}"/>`);
  parts.push(`<text x="${MARGIN}" y="${y + 30}" font-family="${HOUSE_FONT_SANS}" font-size="14" font-weight="700" fill="${ACCENT}">数据专题</text>`);
  let bottom = textBlock(parts, c.title, MARGIN, y + 92, { size: 52, width: INNER_W, weight: 800, lineH: 66, role: "layout-title" });
  if (c.dek) bottom = textBlock(parts, c.dek, MARGIN, bottom + 46, { size: 22, width: INNER_W * 0.7, fill: MUTED, role: "layout-dek" });
  return bottom;
}
function footer(parts, c, y) {
  if (!c.sources.length) return y;
  parts.push(`<rect x="${MARGIN}" y="${y}" width="${INNER_W}" height="1.5" fill="${INK}"/>`);
  parts.push(`<text x="${MARGIN}" y="${y + 28}" font-family="${HOUSE_FONT_SANS}" font-size="14" font-weight="700" fill="${INK}">资料来源</text>`);
  let bottom = y + 28;
  for (const s of c.sources) bottom = textBlock(parts, s, MARGIN + 80, bottom, { size: 14, width: INNER_W - 80, fill: MUTED, role: "layout-source" }) + 22;
  return bottom + 10;
}
function page(parts, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_W} ${Math.ceil(height)}" width="${PAGE_W}" height="${Math.ceil(height)}"><rect width="${PAGE_W}" height="${Math.ceil(height)}" fill="${PAPER}"/>${parts.join("")}</svg>`;
}
// The big number in a column `width` px wide, measured with textWidth less an 8px slack. The value and its unit share one line when
// both fit; otherwise the unit drops to its own line under the number (wrapped between characters if it is still too wide), and a
// value too wide by itself is set smaller, down to HERO_MIN. The value is never cut or reformatted. Returns how far the hero grew
// below today's one-line hero, so a caller places its label that much lower (0 when the hero fits on one line).
const HERO_MIN = 56;
const HERO_SLACK = 8;
function bigNumber(parts, hero, x, y, size, width) {
  const room = width - HERO_SLACK;
  const valueW = textWidth(hero.value, 1);
  if (valueW * size > room) size = Math.max(HERO_MIN, Math.floor(room / valueW));
  const unitSize = Math.round(size * 0.36);
  const oneLine = !hero.unit || valueW * size + 6 + textWidth(hero.unit, unitSize) <= room;
  const unit = hero.unit && oneLine ? `<tspan dx="6" font-family="${HOUSE_FONT_SANS}" font-size="${unitSize}" font-weight="700">${esc(hero.unit)}</tspan>` : "";
  parts.push(`<text data-role="layout-hero-value" x="${x}" y="${y}" font-family="${HOUSE_FONT_SANS_TABULAR}" font-size="${size}" font-weight="800" fill="${ACCENT}">${esc(hero.value)}${unit}</text>`);
  if (oneLine) return 0;
  // The unit's first line sits below the value's descent (about 0.25 of its size) with a full unit line of room: a CJK unit's box
  // rises about its whole size above its baseline (e8 q4: at 0.5 of the size the two boxes overlapped by 4px).
  const unitY = y + Math.round(size * 0.3 + unitSize * 1.1);
  return textBlock(parts, hero.unit, x, unitY, { size: unitSize, width: room, weight: 700, fill: ACCENT, role: "layout-hero-unit" }) - y;
}

// A, magazine spread: the big number and its answer at top left, the drawing at top right, the lead chart across the page, then
// the next chart beside a column of short notes.
function magazine(c) {
  const parts = [];
  let y = masthead(parts, c, 40) + 40;
  const leftW = 560, rightX = MARGIN + leftW + 48, rightW = INNER_W - leftW - 48;
  const top = y;
  let leftBottom = top;
  if (c.hero) {
    const drop = bigNumber(parts, c.hero, MARGIN, top + 120, 136, leftW);
    leftBottom = textBlock(parts, c.hero.label, MARGIN, top + 176 + drop, { size: 26, width: leftW, weight: 700, role: "layout-hero-label" });
  }
  const firstBody = c.charts[0]?.body;
  if (firstBody && !/[A-Za-z]{3,}/.test(firstBody)) leftBottom = textBlock(parts, firstBody, MARGIN, leftBottom + 44, { size: 18, width: leftW, fill: MUTED });
  const art = drawIllustration(parts, c.illustration, rightX, top, rightW);
  parts.push(`<text x="${rightX}" y="${(top + art.h + 22).toFixed(1)}" font-family="${HOUSE_FONT_SANS}" font-size="12" fill="${MUTED}">插画：${esc(c.illustration.subject)}（示意，不表示数据）</text>`);
  y = Math.max(leftBottom, top + art.h + 22) + 40;
  parts.push(`<rect x="${MARGIN}" y="${y}" width="${INNER_W}" height="1" fill="${RULE}"/>`);
  y += 24;
  if (c.charts[0]) y += embedChart(parts, c.charts[0], MARGIN, y, INNER_W) + 32;
  if (c.charts[1]) {
    parts.push(`<rect x="${MARGIN}" y="${y}" width="${INNER_W}" height="1" fill="${RULE}"/>`);
    y += 24;
    // The chart keeps at least its own width (its text keeps the 12px floor); the notes sit beside it when 200px are left, else below.
    const beside = c.charts[1].w <= INNER_W - 248;
    const chartW = beside ? c.charts[1].w : INNER_W, noteX = beside ? MARGIN + chartW + 48 : MARGIN, noteW = beside ? INNER_W - chartW - 48 : 640;
    const h = embedChart(parts, c.charts[1], MARGIN, y, chartW);
    let ny = beside ? y + 60 : y + h + 40;
    const notes = [c.charts[1].body, ...c.notes].filter((t) => t && !/[A-Za-z]{3,}/.test(t));
    notes.forEach((note, i) => {
      parts.push(`<text x="${noteX}" y="${ny}" font-family="${HOUSE_FONT_SANS_TABULAR}" font-size="15" font-weight="800" fill="${ACCENT}">${String(i + 1).padStart(2, "0")}</text>`);
      parts.push(`<rect x="${noteX}" y="${ny + 10}" width="${noteW}" height="1" fill="${RULE}"/>`);
      ny = textBlock(parts, note, noteX, ny + 38, { size: 17, width: noteW }) + 44;
    });
    y += Math.max(h, ny - y) + 32;
  }
  return page(parts, footer(parts, c, y));
}

// B, Japanese infographic / Bazil: the drawing as the base plate with numbered notes on short leaders, a ledger column of the lead
// chart's numbers in account-book form beside it, one accent colour; the charts follow at full width.
// hooks (optional): embed(parts, chart, x, y, w) -> height, footer(parts, y) -> bottom, so the page pipeline embeds charts and
// prints sources its own way; regions: where the hero and the text modules were drawn, for the page's module boxes.
function ledgerParts(c, hooks = {}) {
  const embed = hooks.embed ?? embedChart;
  const parts = [];
  const regions = {};
  let y = masthead(parts, c, 40) + 40;
  const plateW = 860, sideX = MARGIN + plateW + 40, sideW = INNER_W - plateW - 40;
  const top = y;
  const art = drawIllustration(parts, c.illustration, MARGIN, top, plateW);
  // The lettered facts sit in a band under the drawing, not on leaders into it: the drawing is a plate, not data, so a note
  // points at its ledger row (lettered there too), never at a turbine or a ship.
  const callouts = c.facts;
  let plateBottom = top + art.h;
  if (callouts.length) {
    const colW = (plateW - 24 * (callouts.length - 1)) / callouts.length;
    const bandTop = plateBottom + 18;
    let bandBottom = bandTop;
    callouts.forEach((fact, i) => {
      const bx = MARGIN + i * (colW + 24);
      parts.push(noteMarker(bx + 12, bandTop + 12, i));
      bandBottom = Math.max(bandBottom, textBlock(parts, fact.text, bx + 34, bandTop + 18, { size: 16, width: colW - 34, lineH: 24, role: "layout-fact" }));
    });
    plateBottom = bandBottom + 8;
  }
  plateBottom += 22;
  parts.push(`<text x="${MARGIN}" y="${plateBottom.toFixed(1)}" font-family="${HOUSE_FONT_SANS}" font-size="14" fill="${MUTED}">插画：${esc(c.illustration.subject)}（示意，不表示数据）</text>`);
  // The page's text modules (a reading note) set under the plate.
  if (c.notes.length) {
    const noteTop = plateBottom + 16;
    let ny = noteTop + 22;
    regions.texts = c.notes.map((note) => {
      const from = ny - 20;
      ny = textBlock(parts, note, MARGIN, ny, { size: 16, width: plateW, fill: INK }) + 30;
      return { x: MARGIN, y: from, w: plateW, h: ny - 30 + 8 - from };
    });
    plateBottom = ny - 30 + 8;
  }
  // The ledger column: the big number, then the lead chart's top and bottom rows in ruled account-book rows.
  let sy = top;
  if (c.hero) {
    const drop = bigNumber(parts, c.hero, sideX, sy + 92, 96, sideW);
    sy = textBlock(parts, c.hero.label, sideX, sy + 134 + drop, { size: 18, width: sideW, weight: 700 }) + 30;
  }
  if (c.ledger.length) {
    parts.push(`<rect x="${sideX}" y="${sy}" width="${sideW}" height="2" fill="${INK}"/>`);
    parts.push(`<text x="${sideX}" y="${sy + 26}" font-family="${HOUSE_FONT_SANS}" font-size="14" font-weight="700" fill="${INK}">${esc(c.measure || "数值")}</text>`);
    sy += 40;
    for (const row of c.ledger) {
      if (!row) { parts.push(`<text x="${sideX + sideW / 2}" y="${sy + 18}" text-anchor="middle" font-family="${HOUSE_FONT_SANS}" font-size="16" fill="${MUTED}">⋯</text>`); sy += 28; continue; }
      const top1 = row.rank === 1;
      const letter = callouts.findIndex((f) => f.rank === row.rank);
      parts.push(`<text x="${sideX}" y="${sy + 20}" font-family="${HOUSE_FONT_SANS_TABULAR}" font-size="14" fill="${MUTED}">${String(row.rank).padStart(2, "0")}</text>`);
      parts.push(`<text data-role="layout-ledger-name" x="${sideX + 36}" y="${sy + 20}" font-family="${HOUSE_FONT_SANS}" font-size="17" font-weight="${top1 ? 800 : 400}" fill="${INK}">${esc(row.name)}</text>`);
      if (letter >= 0) parts.push(noteMarker(sideX + 36 + textWidth(row.name, 17) + 22, sy + 14, letter, 0.75));
      parts.push(`<text data-role="layout-ledger-value" x="${sideX + sideW}" y="${sy + 20}" text-anchor="end" font-family="${HOUSE_FONT_SANS_TABULAR}" font-size="17" font-weight="700" fill="${top1 ? ACCENT : INK}">${esc(row.value)}</text>`);
      parts.push(`<path d="M${sideX} ${sy + 30} H${sideX + sideW}" stroke="${RULE}" stroke-width="1" stroke-dasharray="2 3"/>`);
      sy += 34;
    }
    parts.push(`<text x="${sideX}" y="${sy + 18}" font-family="${HOUSE_FONT_SANS}" font-size="14" fill="${MUTED}">共 ${c.total} 项，按数值由高到低</text>`);
    sy += 30;
  }
  regions.hero = { x: sideX, y: top, w: sideW, h: sy - top };
  y = Math.max(plateBottom, sy) + 40;
  for (const chart of c.charts) {
    parts.push(`<rect x="${MARGIN}" y="${y}" width="${INNER_W}" height="1" fill="${RULE}"/>`);
    y += 24;
    y += embed(parts, chart, MARGIN, y, INNER_W) + 32;
  }
  const bottom = hooks.footer ? hooks.footer(parts, y) : footer(parts, c, y);
  return { parts, height: bottom, regions };
}
// A white square ruled in the accent with a letter, unlike the charts' filled round data numbers.
function noteMarker(x, y, i, k = 1) {
  const r = 12 * k;
  return `<rect data-role="layout-note-marker" x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" fill="${PAPER}" stroke="${ACCENT}" stroke-width="2"/><text x="${x.toFixed(1)}" y="${(y + 5 * k).toFixed(1)}" text-anchor="middle" font-family="${HOUSE_FONT_SANS_TABULAR}" font-size="${Math.max(12, Math.round(14 * k))}" font-weight="800" fill="${ACCENT}">${String.fromCharCode(65 + i)}</text>`;
}
function ledgerPage(c) {
  const { parts, height } = ledgerParts(c);
  return page(parts, height);
}

// The registry: a page is composed in one of these; the user picks one once and it is sealed.
export const PAGE_LAYOUTS = [
  { id: "magazine", name: "杂志跨页", slots: ["hero", "illustration", "lead_chart", "chart_with_notes", "sources"], render: magazine },
  { id: "ledger", name: "图解账本", slots: ["illustration_plate", "numbered_notes", "ledger", "hero", "charts", "sources"], render: ledgerPage },
];

// New route: the page layout the user picked (10-26) and sealed; every new-route desktop page is composed in it.
export const SEALED_PAGE_LAYOUT = "ledger";

// For the page pipeline: the sealed layout's drawing parts, its height and the hero / text regions.
export function composeLayoutParts(content, hooks) {
  return ledgerParts(content, hooks);
}

export function renderPageLayout(id, content) {
  const layout = PAGE_LAYOUTS.find((l) => l.id === id);
  if (!layout) throw new Error(`unknown page layout '${id}': ${PAGE_LAYOUTS.map((l) => l.id).join(", ")}`);
  return layout.render(content);
}

/**
 * New route: every text in a page or publication spec that still holds a placeholder ({first.country_iso2}, {min.value.name}, {label}), as
 * "path: {placeholder}". A filled page has none: the words go on the page as they are. A key that holds a placeholder by design (value_from)
 * a template kept beside its filled text (a *_template key) and a JSON string (a *_json key) are not page text and are skipped.
 */
export function unfilledPlaceholders(value, path = "") {
  if (typeof value === "string") return [...value.matchAll(/\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\}/g)].map((m) => `${path || "(root)"}: ${m[0]}`);
  if (Array.isArray(value)) return value.flatMap((item, i) => unfilledPlaceholders(item, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).filter(([key]) => key !== "value_from" && !key.endsWith("_template") && !key.endsWith("_json")).flatMap(([key, item]) => unfilledPlaceholders(item, path ? `${path}.${key}` : key));
}
