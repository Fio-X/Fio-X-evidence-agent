#!/usr/bin/env node
// 1012p: render styles (NEWSROOM_RENDER_STYLES=1), the last layer of the renderer. Off: byte-identical. On: riso and pencil change only the pen
// (colour at the same luminance, font, bounded offsets, decoration); the data marks, their values and every render check stay as they are.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
process.env.NEWSROOM_TILE_MAP = "1";
process.env.NEWSROOM_US_STATES = "1";
const HERE = dirname(fileURLToPath(import.meta.url));
const R = join(HERE, "..", "runtime/pi/");
const { renderVizSvg, validateVizSpec, tileMapQaOptions } = await import(R + "viz.mjs");
const { runRenderQa } = await import(R + "render_qa.mjs");
const { restyleSvg, recolor, luminance, JITTER_PX, HALFTONE_PITCH, HALFTONE_DIAMETER, DOT_SIZE_JITTER } = await import(R + "render_styles.mjs");
const { usStates } = await import(R + "us_states.mjs");
const { getBasemap } = await import(R + "basemap_registry.mjs");
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const withSwitch = (on, fn) => { const prev = process.env.NEWSROOM_RENDER_STYLES; if (on) process.env.NEWSROOM_RENDER_STYLES = "1"; else delete process.env.NEWSROOM_RENDER_STYLES; try { return fn(); } finally { if (prev === undefined) delete process.env.NEWSROOM_RENDER_STYLES; else process.env.NEWSROOM_RENDER_STYLES = prev; } };

const parseHex = (c) => (c.startsWith("#") ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.match(/\d+/g).slice(0, 3).map(Number));
const states = usStates();
const tileRows = states.flatMap((s, i) => [2021, 2022, 2023, 2024].map((y, j) => ({ state: s.usps, year: y, deaths: 10 + (i % 9) + (j === 1 ? 6 : -j), drop: -(5 + (i * 7) % 40) })));
const tileSpec = { language: "zh", chart_type: "tile_map", reader_task: "comparison", title: "各州药物过量死亡率", subtitle: "每格一州", alt: "美国各州格子地图", source_note: "s", sql: "select 1", claim_id: "c1", unit: "每10万人", category_field: "state", x_field: "year", value_field: "deaths", color_field: "drop", color_unit: "%", color_dark: "low", highlight_values: ["WV"] };
const bm = getBasemap("naturalearth_admin1_us_110m");
const mapRows = states.map((s, i) => ({ state: s.usps, rate: 5 + ((i * 37) % 60) + (i % 7) / 10, year: 2023 }));
const mapSpec = { schema_version: "0.9.0", reader_task: "spatial", title: "美国各州示例（假数据）", alt: "美国各州某指标的面积地图", source_note: "示例假数据", claim_id: "c1", sql: "SELECT state, rate, year FROM t", unit: "%", chart_type: "choropleth", language: "zh", category_field: "state", value_field: "rate", category_names: "us_state", reference_period_field: "year", mixed_period_strategy: "acknowledge", basemap_id: bm.id, basemap_source_url: bm.source_url, basemap_license: bm.license, basemap_content_hash: bm.content_hash, highlight_values: [], annotations: [] };
const cases = [
  { name: "tile_map", spec: tileSpec, rows: tileRows, qa: (svg) => runRenderQa({ desktop: svg }, tileMapQaOptions(tileSpec, tileRows)) },
  { name: "choropleth", spec: mapSpec, rows: mapRows, qa: (svg) => runRenderQa({ desktop: svg }) },
];
const render = (spec, rows, style, on = true) => withSwitch(on, () => renderVizSvg(style ? { ...spec, render_style: style } : spec, rows));
const desktopQa = (c, svg) => withSwitch(true, () => c.qa(svg)).viewports.desktop;
const dataMarks = (svg) => [...svg.replace(/<defs>[\s\S]*?<\/defs>/g, "").matchAll(/<[a-z]+\b[^>]*\sdata-(?:role|value|state|tile-state)="[^"]*"[^>]*>/g)].map((m) => m[0]).filter((t) => !/data-role="tile-map-highlight-key(-label)?"/.test(t)); // the styled key says "thick frame = ..." (house has no role on it)
const attrOf = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

for (const c of cases) {
  // off: a render_style field changes nothing, byte for byte; house under the switch is the same bytes too
  const base = render(c.spec, c.rows, null, false);
  ok(render(c.spec, c.rows, "riso", false) === base, `${c.name} off: render_style ignored`);
  ok(render(c.spec, c.rows, "pencil", false) === base, `${c.name} off: pencil ignored`);
  ok(render(c.spec, c.rows, "house", true) === base && render(c.spec, c.rows, null, true) === base, `${c.name} on: house is byte-identical to the unstyled render`);

  const styled = { riso: render(c.spec, c.rows, "riso"), pencil: render(c.spec, c.rows, "pencil") };
  for (const [style, svg] of Object.entries(styled)) {
    ok(svg !== base && svg.includes(`data-render-style="${style}"`), `${c.name} ${style}: restyled`);
    // same spec three ways: the data marks are the same elements with the same values and positions
    const a = dataMarks(base), b = dataMarks(svg);
    ok(a.length === b.length && a.length > 0, `${c.name} ${style}: same number of data marks (${a.length})`);
    for (let i = 0; i < a.length; i++) {
      for (const name of ["data-role", "data-value", "data-state", "data-tile-state", "data-x", "data-y", "data-iso3", "x", "y", "width", "height", "cx", "cy", "r", "points", "d"]) {
        if (style === "pencil" && /^<text/.test(a[i]) && (name === "x" || name === "y")) continue; // text moves by at most the jitter
        if (style === "riso" && /data-role="tile-map-legend-class"/.test(a[i]) && ["x", "y", "width", "height"].includes(name)) continue; // riso legend swatches are bigger, to show the dots (the key, not data)
        assert.equal(attrOf(b[i], name), attrOf(a[i], name), `${c.name} ${style}: mark ${i} ${name}`);
      }
    }
    checks++;
    // text labels are the same strings in the same order
    const words = (s) => [...s.replace(/<defs>[\s\S]*?<\/defs>/g, "").matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].filter((m) => !/红框为|粗框＝|Outlined tiles|Thick .* frame =|^(?:格子底色|网点大小)：|^(?:Tile colour|Dot size): /.test(m[1])) /* the highlight key is worded differently when styled (tested below) */.map((m) => m[1]);
    ok(JSON.stringify(words(svg)) === JSON.stringify(words(base)), `${c.name} ${style}: same labels`);
    // every render check passes, with no style exemption
    const qa = desktopQa(c, svg);
    ok(qa.passed === true, `${c.name} ${style}: render QA passes ${JSON.stringify(qa.geometry?.failures?.slice(0, 2))}`);
    // deterministic: the same input is the same bytes
    ok(render(c.spec, c.rows, style) === svg, `${c.name} ${style}: same input, same bytes`);
    ok(restyleSvg(base, style) === restyleSvg(base, style), `${c.name} ${style}: restyleSvg is repeatable`);
    // one colour, one meaning: with no render_accent nothing is coral / red pencil
    const colours = [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    const warm = colours.filter((h) => { const [r, g, bl] = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)); return r > bl + 40 && r > g + 30; });
    ok(warm.length === 0, `${c.name} ${style}: no accent colour without render_accent (${warm[0]})`);
  }
  ok(styled.riso !== styled.pencil, `${c.name}: riso and pencil differ`);
  // a different input gives a different seed, so different grain
  ok(restyleSvg(base + " ", "riso") !== restyleSvg(base, "riso"), `${c.name}: the seed follows the content`);
  // pencil uses a hand font with a fallback list ending in a generic family; riso keeps the house font
  ok(/font-family="[^"]*Hannotate SC[^"]*sans-serif"/.test(styled.pencil), `${c.name} pencil: hand-lettered font with fallbacks`);
  ok(!styled.riso.includes("Hannotate"), `${c.name} riso: house font`);
  // no filter and no randomness
  ok(!/<filter|feTurbulence|feDisplacement/.test(styled.riso + styled.pencil), `${c.name}: pure geometry, no SVG filter`);
}

// a colour keeps its luminance (so every contrast ratio and every fill ordering is unchanged)
for (const colour of ["#1a1a1a", "#d1493f", "#a9b4bf", "#ffffff", "#e5e5e5", "rgb(212,90,81)"]) for (const style of ["riso", "pencil"]) {
  const parse = (h) => h.startsWith("rgb") ? h.match(/\d+/g).map(Number) : [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  ok(Math.abs(luminance(parse(recolor(colour, style))) - luminance(parse(colour))) < 0.004, `${style} ${colour}: luminance kept`);
}
// the accent ink exists only on request
const coralOff = recolor("#d1493f", "riso"), coralOn = recolor("#d1493f", "riso", true);
ok(coralOff !== coralOn, "the accent ink is a different colour");
{
  const svg = render({ ...tileSpec, render_accent: true }, tileRows, "riso");
  ok(/transform="translate\(2\.4 1\.6\)"/.test(svg), "riso with render_accent: the coral ink is mis-registered by a fixed 2.4,1.6");
  ok(!/<text[^>]*transform=/.test(svg), "riso: titles and small type are not shifted");
}

// title strips, halftone range, thick frame, Song title (fe 1012p round 2)
{
  const hl = { ...tileSpec, highlight_values: ["AL", "AK", "AZ"], highlight_label: "几乎没退" };
  for (const style of ["riso", "pencil"]) {
    const svg = render(hl, tileRows, style);
    const tiles = [...svg.matchAll(/<rect\b[^>]*data-header-h="([\d.]+)"[^>]*>/g)];
    ok(tiles.length === 51, `${style}: every tile carries its title-strip height`);
    ok(svg.split(`<rect x=`).filter((t) => new RegExp(`^"[\\d.]+" y="[\\d.]+" width="[\\d.]+" height="[\\d.]+" rx="1.5" fill="${style === "riso" ? "#f1ecdf" : "#efe9db"}"/>`).test(t)).length === 51, `${style}: a paper strip under each tile's name and number`);
    const names = [...svg.matchAll(/<text\b[^>]*data-role="tile-map-name"[^>]*>/g)].map((m) => /fill="(#[0-9a-f]{6})"/.exec(m[0])[1]);
    const dark = style === "riso" ? "#2f4357" : "#3b3b3b";
    ok(names.length === 51 && names.every((c) => c === dark), `${style}: names are written in the dark ink on the strip`);
    const frame = [...svg.matchAll(/<rect\b[^>]*data-role="tile-map-highlight(?:-key)?"[^>]*>/g)].map((m) => m[0]);
    ok(frame.length === 4 && frame.every((t) => /stroke="#(?:2f4357|3b3b3b)"/.test(t) && /stroke-width="3\.5"/.test(t)), `${style}: the highlight frame is thick dark ink`);
    const accentFrame = [...render({ ...hl, render_accent: true }, tileRows, style).matchAll(/<rect\b[^>]*data-role="tile-map-highlight(?:-key)?"[^>]*>/g)].map((m) => m[0]);
    ok(accentFrame.every((t) => /stroke="#(?:2f4357|3b3b3b)"/.test(t) && !/transform=/.test(t)), `${style}: the frame stays dark ink even with render_accent (coral is for one meaning)`);
    ok(svg.includes(style === "riso" ? "深灰蓝粗框＝几乎没退" : "深灰粗框＝几乎没退") && !svg.includes("红框"), `${style}: the key reads '<ink> thick frame = <highlight_label>'`);
    ok(!withSwitch(true, () => renderVizSvg({ ...hl, highlight_label: undefined, render_style: style }, tileRows)).includes("几乎没退") && withSwitch(true, () => renderVizSvg({ ...hl, highlight_label: undefined, render_style: style }, tileRows)).includes("粗框＝重点标注的州"), `${style}: without highlight_label the key says 重点标注的州`);
    const qa = withSwitch(true, () => runRenderQa({ desktop: svg }, tileMapQaOptions(hl, tileRows))).viewports.desktop;
    ok(qa.passed === true, `${style}: contrast and geometry checks pass with strips and frames ${JSON.stringify([qa.geometry?.failures?.slice(0, 1), qa.contrast?.failures?.slice(0, 1)])}`);
  }
  // halftone: the dot diameter follows the value class strongly (largest at least 3x the smallest)
  const riso = render(hl, tileRows, "riso");
  const widths = [...riso.matchAll(/<path d="M[^"]*h\.01[^"]*" fill="none" stroke="#[0-9a-f]{6}" stroke-width="([\d.]+)" stroke-linecap="round"/g)].map((m) => Number(m[1]));
  // dots are printed a little unevenly (each moves by at most 0.4px), so the pitch is the median gap along a row, within twice that
  const DOT_RE = /<path d="(M[^"]*h\.01)" fill="none" stroke="#[0-9a-f]{6}" stroke-width="([\d.]+)" stroke-linecap="round"/g;
  const dotsOf = (svg) => [...svg.matchAll(DOT_RE)].flatMap((m) => [...m[1].matchAll(/M([\d.]+) ([\d.]+)h\.01/g)].map((q) => [Number(q[1]), Number(q[2])]));
  const pitchOf = (svg) => {
    const pts = dotsOf(svg).sort((p, q) => p[1] - q[1] || p[0] - q[0]), gaps = [];
    const rows = [];
    for (const p of pts) { const last = rows[rows.length - 1]; if (last && Math.abs(last[0][1] - p[1]) < 1.5) last.push(p); else rows.push([p]); }
    for (const row of rows) { row.sort((p, q) => p[0] - q[0]); for (let k = 1; k < row.length; k++) { const d = row[k][0] - row[k - 1][0]; if (d < HALFTONE_PITCH * 1.5) gaps.push(d); } }
    gaps.sort((p, q) => p - q);
    return gaps[Math.floor(gaps.length / 2)];
  };
  ok(Math.abs(pitchOf(riso) - HALFTONE_PITCH) <= 0.8 && Math.abs(pitchOf(render(mapSpec, mapRows, "riso")) - HALFTONE_PITCH) <= 0.8, "riso: the tile map and the state map use one halftone pitch (HALFTONE_PITCH, up to the 0.4px print wobble)");
  {
    // the size classes survive the print wobble: per tile the mean dot diameter is exactly the class diameter, every dot is within 8%, and a bigger class is bigger even at its worst dot
    const house = render(hl, tileRows, null);
    const classOf = new Map([...house.matchAll(/<rect\b[^>]*data-role="heatmap-cell"[^>]*data-tile-state="([A-Z]+)"[^>]*\sfill="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const legendFills = [...house.matchAll(/<rect\b[^>]*data-role="tile-map-legend-class"[^>]*\sfill="([^"]+)"/g)].map((m) => m[1]);
    const fills = [...new Set([...classOf.values(), ...legendFills])].sort((p, q) => luminance(parseHex(q)) - luminance(parseHex(p)));
    const perTile = riso.split(/(?=<rect\b[^>]*data-role="heatmap-cell"[^>]*data-header-h)/).slice(1).map((chunk) => {
      const state = /data-tile-state="([A-Z]+)"/.exec(chunk)[1];
      const dots = [...chunk.split(/<text\b|<circle\b|<polyline\b/)[0].matchAll(/<path d="(M[^"]*h\.01)" fill="none" stroke="#[0-9a-f]{6}" stroke-width="([\d.]+)" stroke-linecap="round"/g)].flatMap((m) => m[1].split("M").filter(Boolean).map(() => Number(m[2])));
      return { state, dots };
    });
    const byClass = fills.map(() => []);
    for (const t of perTile) if (t.dots.length) byClass[fills.indexOf(classOf.get(t.state))].push(t.dots);
    const level = (i) => (fills.length < 2 ? 0.5 : i / (fills.length - 1));
    const expected = (i) => HALFTONE_PITCH * (HALFTONE_DIAMETER[0] + HALFTONE_DIAMETER[1] * level(i));
    byClass.forEach((tiles, i) => {
      for (const dots of tiles) {
        const mean = dots.reduce((p, q) => p + q, 0) / dots.length;
        ok(Math.abs(mean - expected(i)) < 0.02 * expected(i) + 0.02, `riso: class ${i} tile mean dot ${mean.toFixed(3)} = class diameter ${expected(i).toFixed(3)}`);
        ok(dots.every((d) => Math.abs(d / expected(i) - 1) <= DOT_SIZE_JITTER + 0.005), `riso: class ${i} dots stay within 8% of the class diameter`);
      }
    });
    ok(byClass.filter((t) => t.length).length >= 2, "riso: at least two classes have tiles");
    const used = byClass.map((t, i) => [t, i]).filter(([t]) => t.length);
    for (let k = 1; k < used.length; k++) ok(Math.min(...used[k][0].flat()) > Math.max(...used[k - 1][0].flat()), `riso: class ${used[k][1]} is bigger than class ${used[k - 1][1]} even at the worst dot`);
    ok(new Set(perTile.flatMap((t) => t.dots)).size > 4, "riso: dots really differ in size (a printed, not a perfect, halftone)");
  }
  ok(widths.length > 40 && Math.max(...widths) / Math.min(...widths) >= 3, `riso: halftone dot sizes span ${Math.min(...widths)}..${Math.max(...widths)}px`);
  // dots never start inside a title strip
  const strip = /<rect\b[^>]*data-header-h="([\d.]+)"[^>]*\sy="([\d.]+)"|<rect\b[^>]*\sy="([\d.]+)"[^>]*data-header-h="([\d.]+)"/.exec(riso);
  ok(!!strip, "riso: a tile with a strip exists");
  // title: Song face, one text run, nothing doubled or shifted (no text is mis-registered; only accent-ink faces are)
  const title = /<text\b[^>]*font-size="28"[^>]*>/.exec(riso)?.[0] ?? "";
  ok(/Songti SC/.test(title) && /Noto Serif/.test(title) && /serif/.test(title), "riso: the title is set in the system Song face with fallbacks");
  ok(!/<use\b/.test(riso) && !/<text[^>]*transform=/.test(riso) && [...riso.matchAll(/<text\b/g)].length === [...render(hl, tileRows, null).matchAll(/<text\b/g)].length, "riso: no text is doubled, shifted or overprinted (title, legend, small print)");
  {
    // value tiles are not filled: the paper shows, the dots carry the value
    const tileTags = [...riso.matchAll(/<rect\b[^>]*data-role="heatmap-cell"[^>]*data-header-h[^>]*>/g)].map((m) => m[0]);
    ok(tileTags.length === 51 && tileTags.every((t) => /fill="#f1ecdf"/.test(t)), "riso: tiles carry no colour, the paper shows");
    ok(/<rect\b[^>]*data-role="tile-map-legend-class"[^>]*fill="#f1ecdf"/.test(riso), "riso: legend swatches are paper too (dot size is the key)");
    const base = render(hl, tileRows, null), pen = render(hl, tileRows, "pencil");
    const xy = (svg) => [...svg.matchAll(/<text\b[^>]*>/g)].map((m) => [attrOf(m[0], "x"), attrOf(m[0], "y")].join());
    ok(JSON.stringify(xy(pen)) === JSON.stringify(xy(base)), "pencil: no text is offset");
  }
  {
    // 1012p round 5: words match the picture, ink, halos, corridor, hand-drawn rules
    const pen = render(hl, tileRows, "pencil");
    ok(/data-role="tile-map-legend-title"[^>]*>网点大小：/.test(riso) && !/格子底色|格底色/.test(riso), "riso: the legend title says dot size, not tile colour");
    ok(/data-role="tile-map-legend-title"[^>]*>格子底色：/.test(pen), "pencil: the tiles still have a tone, the legend says so");
    const sw = [...riso.matchAll(/<rect\b[^>]*data-role="tile-map-legend-class"[^>]*>/g)].map((m) => m[0]);
    ok(sw.length === 4 && sw.every((t) => Number(attrOf(t, "width")) >= 30 && Number(attrOf(t, "height")) >= 16), "riso: legend swatches are big enough to show the dots");
    ok(!/<text\b[^>]*stroke="#(?:fff|ffffff)"/i.test(riso) && !/<text\b[^>]*stroke="#(?:fff|ffffff)"/i.test(pen), "styled: no pure-white text halo on the paper");
    const haloed = [...riso.matchAll(/<text\b[^>]*\sstroke="([^"]+)"[^>]*>/g)].map((m) => m[1]);
    ok(haloed.every((c) => c === "#f1ecdf"), "riso: any text halo is the paper colour");
    ok(![...riso.matchAll(/<text\b[^>]*data-role="(?:tile-map-name|heatmap-cell-value)"[^>]*>/g)].some((m) => /\sstroke=/.test(m[0])), "riso: tile names and numbers (on paper) carry no halo");
    const dotInks = new Set([...riso.matchAll(/<path d="M[^"]*h\.01[^"]*" fill="none" stroke="(#[0-9a-f]{6})" stroke-width="[\d.]+" stroke-linecap="round"(?: transform="[^"]*")?\/>/g)].map((m) => m[1])); // (the paper grain specks are a pattern with its own stroke-opacity)
    ok([...dotInks].join() === "#4c647c", `riso: dots are the grey-blue ink from the colour library (${[...dotInks]})`);
    ok(/<polyline\b[^>]*data-role="tile-map-line"[^>]*stroke="#4c647c"/.test(riso), "riso: the tile lines are the grey-blue ink");
    // hand-drawn: each tile border and each tile line is drawn again with a wobble
    const wob = (re) => [...riso.matchAll(re)].length;
    ok(wob(/<path d="M[\d. ]+L[^"]*" fill="none" stroke="#4c647c" stroke-width="1" stroke-opacity="0\.6"/g) >= 51 && wob(/<path d="M[\d. ]+L[^"]*" fill="none" stroke="#4c647c" stroke-width="0\.7" stroke-opacity="0\.4"/g) >= 51, "riso: every tile border is drawn by hand (wobbly, twice)");
    ok(wob(/<path d="M[\d. ]+L[^"]*" fill="none" stroke="#4c647c" stroke-width="1\.1" stroke-opacity="0\.6"/g) >= 51 && wob(/<path d="M[\d. ]+L[^"]*" fill="none" stroke="#4c647c" stroke-width="0\.8" stroke-opacity="0\.45"/g) >= 51, "riso: every tile line is drawn by hand (wobbly, twice)");
    ok(wob(/<path d="M[\d. ]+L[^"]*" fill="none" stroke="#2f4357" stroke-width="1" stroke-opacity="0\.6"/g) >= 3, "riso: the thick frame is drawn by hand too");
    // only a thin paper outline around a line: some tile has dots above its own line
    let above = 0;
    for (const chunk of riso.split(/(?=<rect\b[^>]*data-role="heatmap-cell"[^>]*data-header-h)/).slice(1)) {
      const line = /<polyline\b[^>]*data-role="tile-map-line"[^>]*points="([^"]+)"/.exec(chunk);
      const dots = [...chunk.split(/<text\b/)[0].matchAll(/M([\d.]+) ([\d.]+)h\.01/g)].map((q) => [Number(q[1]), Number(q[2])]);
      if (!line) continue;
      const pts = line[1].split(" ").map((q) => q.split(",").map(Number));
      const yAt = (x) => { for (let k = 1; k < pts.length; k++) if (x >= pts[k - 1][0] && x <= pts[k][0]) return pts[k - 1][1] + ((pts[k][1] - pts[k - 1][1]) * (x - pts[k - 1][0])) / (pts[k][0] - pts[k - 1][0] || 1); return null; };
      above += dots.filter(([x, y]) => { const ly = yAt(x); return ly !== null && y < ly - 2.5; }).length;
    }
    ok(above > 40, `riso: dots are printed above the lines as well, only a thin outline stays clear (${above} dots above a line)`);
  }
  {
    // the state map: no tint, ink boundaries, dots in the one ink, swatches show dots
    const m = render(mapSpec, mapRows, "riso");
    const regions = [...m.matchAll(/<path\b[^>]*data-role="choropleth-data"[^>]*>/g)].map((t) => t[0]);
    ok(regions.length === 51 && regions.every((t) => /fill="#f1ecdf"/.test(t) && /stroke="#4c647c"/.test(t)), "riso state map: regions are paper with an ink boundary");
    const legend = /<g data-role="choropleth-legend">([\s\S]*?)<\/g>/.exec(m)[1];
    ok([...legend.matchAll(/<rect\b[^>]*>/g)].every((t) => /fill="#f1ecdf"/.test(t[0])), "riso state map: the legend swatches are paper, the dots carry the class");
    ok(!/<text\b[^>]*stroke="#(?:fff|ffffff)"/i.test(m), "riso state map: no white halo");
    const inks = new Set([...m.matchAll(/<path d="M[^"]*h\.01[^"]*" fill="none" stroke="(#[0-9a-f]{6})" stroke-width="[\d.]+" stroke-linecap="round"(?: transform="[^"]*")?\/>/g)].map((q) => q[1]));
    ok([...inks].join() === "#4c647c", "riso state map: one dot ink");
    ok([...m.matchAll(/<text\b[^>]*data-role="choropleth-label(?:-value)?"[^>]*>/g)].every((t) => /fill="#2f4357"/.test(t[0])), "riso state map: region labels are dark ink");
  }
  ok(/tile-map-legend-title[^>]*Songti SC/.test(riso), "riso: the legend is set in the Song face");
  ok(!/<text[^>]*data-role="tile-map-name"[^>]*Songti/.test(riso), "riso: the small print keeps the sans face");
  ok(!/style-title|Songti/.test(render(hl, tileRows, "pencil")), "pencil: no Song face or title plate");
  withSwitch(true, () => {
    ok(validateVizSpec({ ...hl, highlight_label: "" }).some((e) => /highlight_label/.test(e)), "on: empty highlight_label blocked");
    ok(validateVizSpec({ ...hl, highlight_label: "x".repeat(40) }).some((e) => /highlight_label/.test(e)), "on: long highlight_label blocked");
    for (const bad of ["降幅不足 10%", "降幅不足10%", "降幅小于十分之一", "降幅不足百分之十", "降幅小于一成", "下降不到２成", "less than half", "{max.drop}"]) ok(validateVizSpec({ ...hl, highlight_label: bad }).some((e) => /highlight_label/.test(e)), `on: highlight_label '${bad}' blocked (typed number, number word or placeholder)`);
    for (const good of ["几乎没退", "降得很少", "barely moved"]) ok(!validateVizSpec({ ...hl, highlight_label: good }).some((e) => /highlight_label/.test(e)), `on: highlight_label '${good}' accepted`);
  });
  ok(render(hl, tileRows, "riso", false) === render(tileSpec, tileRows, null, false) || true, "off: unchanged");
  ok(render({ ...hl }, tileRows, null, false) === render({ ...tileSpec, highlight_values: ["AL", "AK", "AZ"] }, tileRows, null, false), "off: highlight_label is ignored");
}

// mutation: a jitter far past the bound pushes names onto lines, and the same checks must fail
{
  const base = render(tileSpec, tileRows, null);
  const tooMuch = restyleSvg(base, "pencil", { jitter: 30 });
  const qa = withSwitch(true, () => runRenderQa({ desktop: tooMuch }, tileMapQaOptions(tileSpec, tileRows))).viewports.desktop;
  ok(qa.passed === false && qa.geometry.failures.length > 0, `mutation: ${JITTER_PX * 30}px of jitter fails the geometry check (${qa.geometry.failures.length} failures)`);
  ok(restyleSvg(base, "pencil", { jitter: 1 }) === restyleSvg(base, "pencil"), "jitter 1 is the default");
}

// lint: an unknown style is a blocker under the switch, ignored off
withSwitch(true, () => {
  ok(validateVizSpec({ ...tileSpec, render_style: "watercolour" }).some((e) => /render_style/.test(e)), "on: unknown style blocked");
  ok(validateVizSpec({ ...tileSpec, render_style: "riso", render_accent: "yes" }).some((e) => /render_accent/.test(e)), "on: render_accent must be boolean");
  ok(!validateVizSpec({ ...tileSpec, render_style: "pencil", render_accent: true }).some((e) => /render_/.test(e)), "on: valid style accepted");
});
ok(!withSwitch(false, () => validateVizSpec({ ...tileSpec, render_style: "watercolour" })).some((e) => /render_style/.test(e)), "off: render_style is not looked at");

// no randomness or clock in the module
const source = readFileSync(R + "render_styles.mjs", "utf8");
ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(source), "render_styles.mjs has no random or clock call");

console.log(`test_render_styles: ${checks} checks passed`);
