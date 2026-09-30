#!/usr/bin/env node
// Regression tests for the line-chart smoothing/axis-honesty fixes (Task A/B)
// and the Sankey redesign (Task C) driven by direct user feedback on
// fertility-rate/soybean-export line charts and the "who supplies China's
// soybeans" Sankey. Pure, deterministic: no browser, no network.
import assert from "node:assert/strict";
import {
  renderVizBundle,
  monotoneCubicPath,
  isRegularlySpaced,
  lineAxisDomain,
  lineAxisTicks,
} from "../runtime/pi/viz.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

const claimId = "claim-line-sankey-polish";
const baseLine = {
  schema_version: "0.9.0",
  reader_task: "change",
  takeaway: "Regression fixture for line-chart smoothing and axis honesty.",
  title: "Line polish regression fixture",
  subtitle: "Synthetic fixture",
  alt: "A synthetic multi-line chart used to test monotone interpolation and axis bracketing.",
  source_note: "Synthetic regression fixture",
  claim_id: claimId,
  sql: "SELECT 1",
  annotations: [],
  highlight_values: [],
};

// ---------------------------------------------------------------------------
// Task A.1: monotone interpolation passes exactly through every data point,
// and never overshoots past the local min/max of its two neighbours.
{
  const points = [
    { x: 0, y: 0 }, { x: 40, y: 10 }, { x: 80, y: 8 }, { x: 120, y: 30 }, { x: 160, y: 28 },
  ];
  const d = monotoneCubicPath(points);
  // Every input point must appear verbatim as a curve anchor (M or a C's end coordinate).
  for (const p of points) {
    const needle = `${p.x},${p.y}`;
    assert.ok(d.includes(needle), `monotoneCubicPath must pass through ${needle}: ${d}`);
  }
  // No-overshoot: sample the actual cubic Bezier at fine resolution per segment
  // and check every sampled y stays within [min(y_i,y_i+1), max(y_i,y_i+1)] of
  // its own segment's two endpoints (the Fritsch-Carlson monotonicity property).
  const segments = d.match(/C[^C]*/g) ?? [];
  let cursor = points[0];
  for (let i = 0; i < segments.length; i++) {
    const nums = segments[i].slice(1).trim().split(/[\s,]+/).map(Number);
    const [cp1x, cp1y, cp2x, cp2y, x1, y1] = nums;
    const p0 = cursor, p3 = { x: x1, y: y1 };
    const lo = Math.min(p0.y, p3.y), hi = Math.max(p0.y, p3.y);
    for (let t = 0; t <= 1; t += 0.02) {
      const mt = 1 - t;
      const y = mt ** 3 * p0.y + 3 * mt ** 2 * t * cp1y + 3 * mt * t ** 2 * cp2y + t ** 3 * p3.y;
      assert.ok(y >= lo - 1e-6 && y <= hi + 1e-6, `monotone segment ${i} overshoots at t=${t}: y=${y} not in [${lo},${hi}]`);
    }
    cursor = p3;
  }
  console.log("monotoneCubicPath: passes through every point and never overshoots - PASS");
}

// ---------------------------------------------------------------------------
// Task A.2: regular vs irregular x spacing detection, and the renderer's
// consequence - a sparse/irregular series always stays straight (a
// <polyline>, never a monotone <path>), regardless of spec.interpolation.
{
  assert.equal(isRegularlySpaced([1990, 1991, 1992, 1993]), true, "annual, no gaps: regular");
  assert.equal(isRegularlySpaced([2016, 2018, 2020, 2023]), false, "2016/2018/2020/2023: irregular (gaps 2,2,3)");
  assert.equal(isRegularlySpaced([2020, 2021]), false, "fewer than 3 points: never regular");

  const rows = [2016, 2018, 2020, 2023].flatMap((yr) => [
    { yr, country: "巴西", share_pct: yr === 2018 ? 89.3 : 70 },
    { yr, country: "美国", share_pct: yr === 2018 ? 10.7 : 20 },
  ]);
  const spec = {
    ...baseLine,
    chart_type: "multi_line",
    x_field: "yr",
    value_field: "share_pct",
    series_field: "country",
    unit: "%",
    direct_labels: true,
    interpolation: "monotone",
    highlight_values: ["巴西"],
  };
  const bundle = renderVizBundle(spec, rows);
  assert.ok(!/data-role="line-path"[^>]*\bd="M/.test(bundle.desktop), "an irregular series must never render as a monotone <path>");
  assert.ok(/<polyline data-role="line-path"/.test(bundle.desktop), "an irregular series stays a straight-segment <polyline>");
  console.log("isRegularlySpaced + sparse series stays straight - PASS");
}

// ---------------------------------------------------------------------------
// Task A.3: a dense, regular series with interpolation:"monotone" renders as
// a smoothed <path>, not a <polyline>.
{
  const rows = [1990, 1991, 1992, 1993, 1994].map((year) => ({ year, value: 1 + (year - 1990) * 0.2 }));
  const spec = { ...baseLine, chart_type: "line", x_field: "year", value_field: "value", unit: "births/woman", direct_labels: true, interpolation: "monotone" };
  const bundle = renderVizBundle(spec, rows);
  assert.ok(/<path data-role="line-path"/.test(bundle.desktop), "a dense regular series with interpolation:monotone renders as a <path>");
  console.log("dense regular series + interpolation:monotone renders as a smoothed <path> - PASS");
}

// ---------------------------------------------------------------------------
// Task B.1: the y-axis domain/ticks literally bracket every plotted value -
// reproduces the exact reported bug (US 2018 at 10.7% sitting below a
// lowest-tick of 20% with no 0 baseline).
{
  const values = [10.7, 20, 30, 40, 50, 60, 70, 89.3];
  const domain = lineAxisDomain(values, true, 4);
  assert.equal(domain[0], 0, "a %-share series always gets a 0 baseline");
  assert.ok(domain[1] >= Math.max(...values), "domain max must bracket the true max");
  const ticks = lineAxisTicks(domain, 4);
  assert.ok(ticks[0] <= Math.min(...values), `lowest tick ${ticks[0]} must be <= min value ${Math.min(...values)}`);
  assert.ok(ticks.at(-1) >= Math.max(...values), `highest tick ${ticks.at(-1)} must be >= max value ${Math.max(...values)}`);
  console.log("lineAxisDomain/lineAxisTicks bracket the data (0-baseline %-share) - PASS");
}

// ---------------------------------------------------------------------------
// Task B.2: render-QA's new value_axis_domain_bracket rule actually rejects
// a chart whose data exceed the tick range - constructed directly, since a
// correct renderer should never produce this, but the QA rule must still
// catch it if a future change ever regresses it.
{
  const badSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img"><desc>t</desc>
    <line data-role="value-axis-tick" x1="10" y1="50" x2="190" y2="50" stroke="#ccc"/>
    <line data-role="value-axis-tick" x1="10" y1="150" x2="190" y2="150" stroke="#ccc"/>
    <polyline data-role="line-path" fill="none" stroke="#000" points="10,150 100,10 190,50"/>
  </svg>`;
  const result = checkSvgGeometry(badSvg);
  assert.equal(result.passed, false, "a point outside the tick-bracketed range must fail");
  assert.ok(result.failures.some((f) => f.rule === "value_axis_domain_bracket"), JSON.stringify(result.failures));

  const goodSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img"><desc>t</desc>
    <line data-role="value-axis-tick" x1="10" y1="10" x2="190" y2="10" stroke="#ccc"/>
    <line data-role="value-axis-tick" x1="10" y1="150" x2="190" y2="150" stroke="#ccc"/>
    <polyline data-role="line-path" fill="none" stroke="#000" points="10,150 100,50 190,50"/>
  </svg>`;
  assert.equal(checkSvgGeometry(goodSvg).passed, true, "points within the bracketed range must pass");
  console.log("render-QA value_axis_domain_bracket rejects out-of-bracket points, passes in-bracket ones - PASS");
}

// ---------------------------------------------------------------------------
// Task B.3: a point annotation targeting one (series, x) pair renders
// exactly once (previously duplicated once per series sharing that x).
{
  const rows = [2016, 2018, 2020, 2023].flatMap((yr) => [
    { yr, country: "巴西", share_pct: yr === 2018 ? 89.3 : 70 },
    { yr, country: "美国", share_pct: yr === 2018 ? 10.7 : 20 },
  ]);
  const spec = {
    ...baseLine,
    chart_type: "multi_line",
    x_field: "yr",
    value_field: "share_pct",
    series_field: "country",
    unit: "%",
    direct_labels: true,
    highlight_values: ["巴西"],
    annotations: [
      { type: "point", text: "2018年，巴西反超美国：89.3% 对 10.7%", value: 89.3, claim_id: claimId, match_field: "yr", match_value: 2018, tone: "accent" },
    ],
  };
  const bundle = renderVizBundle(spec, rows);
  const occurrences = (bundle.desktop.match(/89\.3% 对 10\.7%/g) ?? []).length;
  assert.equal(occurrences, 1, `annotation must render exactly once, saw ${occurrences}`);
  console.log("multi-line point annotation renders exactly once (dedup by series value) - PASS");
}

// ---------------------------------------------------------------------------
// Task B.4: every series - including a grey context series - gets a direct
// end label carrying its exact value.
{
  const rows = ["A", "B"].flatMap((series) => [2020, 2021].map((year) => ({ series, year, value: series === "A" ? 26.3 : 12.0 })));
  const spec = { ...baseLine, chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "series", unit: "%", direct_labels: true, highlight_values: ["A"] };
  const bundle = renderVizBundle(spec, rows);
  assert.match(bundle.desktop, /data-role="direct-label"[^>]*>A 26\.3%</);
  assert.match(bundle.desktop, /data-role="direct-label"[^>]*>B 12%</);
  console.log("every series (including context) gets an exact-value end label - PASS");
}

// ---------------------------------------------------------------------------
// Task C: Sankey redesign - no internal prefixes, link colour == source
// node colour, widths strictly proportional to value, labels outside the
// node bars.
{
  const rows = [
    { source: "origin:巴西", target: "destination:中国", value: 71.5 },
    { source: "origin:美国", target: "destination:中国", value: 18.2 },
    { source: "origin:阿根廷", target: "destination:中国", value: 6.1 },
    { source: "origin:其他来源", target: "destination:其他市场", value: 4.2 },
  ];
  const spec = {
    ...baseLine,
    chart_type: "sankey",
    reader_task: "flow",
    source_field: "source",
    target_field: "target",
    value_field: "value",
    unit: "Mt",
    highlight_values: ["巴西"],
    annotations: [],
  };
  const bundle = renderVizBundle(spec, rows);

  // No internal origin:/destination: prefixes ever reach the reader - checked
  // against actual reader-visible text content. data-flow-key is an internal
  // hit-testing/lookup attribute (never rendered as text), so it legitimately
  // keeps the raw, prefixed id and is intentionally excluded from this check.
  const visibleText = [...bundle.desktop.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join("\n");
  assert.ok(!/origin:|destination:/.test(visibleText), `no internal node-type prefix may appear in reader-visible text: ${visibleText}`);
  assert.match(bundle.desktop, />巴西</, "source display name (prefix stripped) must appear");
  assert.match(bundle.desktop, />中国</, "target display name (prefix stripped) must appear");

  // Node bars are thin (16-24px, per the user-approved redesign's ~20px
  // spec) rects tagged flow-node.
  const nodeWidths = [...bundle.desktop.matchAll(/<rect data-role="flow-node"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(nodeWidths.length > 0, "must render flow-node rects");
  for (const w of nodeWidths) assert.ok(w >= 16 && w <= 24, `node bar width ${w} must be in [16,24]`);

  // Only the highlighted flow (Brazil -> China) carries the accent colour;
  // every other link (including US -> China) is neutral grey. data-flow-key
  // carries the raw (prefixed) source/target ids joined by an arrow.
  const linkAttrs = (key) => {
    const m = bundle.desktop.match(new RegExp(`<path data-role="flow-link" data-flow-key="${key}"([^/]*)/>`));
    assert.ok(m, `flow-link with data-flow-key="${key}" must be present`);
    const attrs = m[1];
    return {
      stroke: attrs.match(/stroke="(#[0-9a-fA-F]{3,8})"/)[1],
      opacity: Number(attrs.match(/stroke-opacity="([\d.]+)"/)[1]),
      width: Number(attrs.match(/stroke-width="([\d.]+)"/)[1]),
    };
  };
  const brazilLink = linkAttrs("origin:巴西→destination:中国");
  const usLink = linkAttrs("origin:美国→destination:中国");
  assert.notEqual(brazilLink.stroke, usLink.stroke, "links from different source nodes must render in different colours");

  // Highlighted (Brazil) link renders at higher opacity than a non-highlighted one.
  assert.ok(brazilLink.opacity > usLink.opacity, `highlighted link opacity ${brazilLink.opacity} must exceed non-highlighted ${usLink.opacity}`);
  assert.ok(usLink.opacity <= 0.4, `non-highlighted link opacity ${usLink.opacity} should read as ~35%`);

  // Link widths strictly proportional to value: ratio of stroke-widths must
  // match the ratio of the underlying values (within rounding tolerance).
  const expectedRatio = 71.5 / 18.2, actualRatio = brazilLink.width / usLink.width;
  assert.ok(Math.abs(expectedRatio - actualRatio) / expectedRatio < 0.05, `width ratio ${actualRatio} should track value ratio ${expectedRatio}`);

  // Node labels sit outside the bars: a flow-node-label's x must not fall
  // strictly between any node bar's own [x, x+width] span.
  const bars = [...bundle.desktop.matchAll(/<rect data-role="flow-node" x="([\d.]+)"[^>]*width="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
  const labelXs = [...bundle.desktop.matchAll(/<text data-role="flow-node-label" x="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(labelXs.length > 0, "must render flow-node-label text");
  for (const lx of labelXs) {
    for (const bar of bars) assert.ok(!(lx > bar.x + 1 && lx < bar.x + bar.w - 1), `label x=${lx} falls inside a node bar [${bar.x},${bar.x + bar.w}]`);
  }

  // Render QA must still pass (no text overlap, no viewbox overflow, no
  // sub-floor font) on both viewports.
  const qaDesktop = checkSvgGeometry(bundle.desktop);
  const qaMobile = checkSvgGeometry(bundle.mobile);
  assert.equal(qaDesktop.passed, true, JSON.stringify(qaDesktop.failures));
  assert.equal(qaMobile.passed, true, JSON.stringify(qaMobile.failures));

  console.log("sankey: no prefixes, link colour = source, proportional widths, labels outside bars, render-QA clean - PASS");
}

// ---------------------------------------------------------------------------
// Follow-up fix (1): flow-link uses butt caps, not round - no semicircle
// blob may protrude past a link's own endpoint into the node bar behind it.
{
  const rows = [
    { source: "origin:巴西", target: "destination:中国", value: 71.5 },
    { source: "origin:美国", target: "destination:中国", value: 18.2 },
  ];
  const spec = { ...baseLine, chart_type: "sankey", reader_task: "flow", source_field: "source", target_field: "target", value_field: "value", unit: "Mt", annotations: [] };
  const bundle = renderVizBundle(spec, rows);
  const linkTags = [...bundle.desktop.matchAll(/<path data-role="flow-link"[^>]*\/>/g)].map((m) => m[0]);
  assert.ok(linkTags.length > 0, "must render flow-link paths");
  for (const tag of linkTags) assert.ok(/stroke-linecap="butt"/.test(tag), `flow-link must use butt caps (no round-cap blob): ${tag}`);
  console.log("sankey follow-up fix 1: flow-link uses butt caps - PASS");
}

// ---------------------------------------------------------------------------
// Follow-up fix (2): only a highlighted source's own largest outgoing link
// is full-strength; another link from the same highlighted source (e.g.
// Brazil -> other markets) stays dim, same as any non-highlighted link.
{
  const rows = [
    { source: "origin:巴西", target: "destination:中国", value: 71.5 },
    { source: "origin:巴西", target: "destination:其他市场", value: 9.4 },
    { source: "origin:美国", target: "destination:中国", value: 18.2 },
  ];
  const spec = { ...baseLine, chart_type: "sankey", reader_task: "flow", source_field: "source", target_field: "target", value_field: "value", unit: "Mt", highlight_values: ["巴西"], annotations: [] };
  const bundle = renderVizBundle(spec, rows);
  const linkAttrs = (key) => {
    const m = bundle.desktop.match(new RegExp(`<path data-role="flow-link" data-flow-key="${key}"([^/]*)/>`));
    assert.ok(m, `flow-link with data-flow-key="${key}" must be present`);
    return { opacity: Number(m[1].match(/stroke-opacity="([\d.]+)"/)[1]) };
  };
  const brazilToChina = linkAttrs("origin:巴西→destination:中国");
  const brazilToOther = linkAttrs("origin:巴西→destination:其他市场");
  const usToChina = linkAttrs("origin:美国→destination:中国");
  assert.ok(brazilToChina.opacity > brazilToOther.opacity, `Brazil's own largest link (${brazilToChina.opacity}) must outrank its smaller sibling (${brazilToOther.opacity})`);
  assert.ok(brazilToOther.opacity <= 0.4, `a highlighted source's non-max link (${brazilToOther.opacity}) must read as dim, not full-strength`);
  assert.equal(brazilToOther.opacity, usToChina.opacity, "a highlighted source's non-max link must match ordinary non-highlighted opacity");
  console.log("sankey follow-up fix 2: only a highlighted source's single largest link is full-strength - PASS");
}

// ---------------------------------------------------------------------------
// Follow-up fix (3): each link's inline value label sits on its own link's
// centreline (within the link band), not floating free at a fixed midpoint
// shared ambiguously with other links.
{
  function sankeyPointAtForTest(x1, y1, x2, y2, t) {
    const c = (x2 - x1) * 0.45;
    const p0x = x1, p0y = y1, p1x = x1 + c, p1y = y1, p2x = x2 - c, p2y = y2, p3x = x2, p3y = y2;
    const mt = 1 - t;
    return {
      x: mt ** 3 * p0x + 3 * mt ** 2 * t * p1x + 3 * mt * t ** 2 * p2x + t ** 3 * p3x,
      y: mt ** 3 * p0y + 3 * mt ** 2 * t * p1y + 3 * mt * t ** 2 * p2y + t ** 3 * p3y,
    };
  }
  function distanceToLink(px, py, d) {
    const m = d.match(/M([\d.-]+),([\d.-]+) C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/);
    assert.ok(m, `flow-link d must be a single M/C bezier: ${d}`);
    const [, x1, y1] = m.map(Number);
    const x2 = Number(m[7]), y2 = Number(m[8]);
    let min = Infinity;
    for (let i = 0; i <= 200; i++) {
      const pt = sankeyPointAtForTest(x1, y1, x2, y2, i / 200);
      min = Math.min(min, Math.hypot(px - pt.x, py - pt.y));
    }
    return min;
  }

  const rows = [
    { source: "origin:巴西", target: "destination:中国", value: 71.5 },
    { source: "origin:美国", target: "destination:中国", value: 18.2 },
    { source: "origin:阿根廷", target: "destination:中国", value: 6.1 },
  ];
  const spec = { ...baseLine, chart_type: "sankey", reader_task: "flow", source_field: "source", target_field: "target", value_field: "value", unit: "Mt", highlight_values: ["巴西"], annotations: [] };
  const bundle = renderVizBundle(spec, rows);
  const links = new Map([...bundle.desktop.matchAll(/<path data-role="flow-link" data-flow-key="([^"]+)"[^>]*d="([^"]+)"[^>]*stroke-width="([\d.]+)"/g)].map((m) => [m[1], { d: m[2], width: Number(m[3]) }]));
  const labels = [...bundle.desktop.matchAll(/<text data-role="flow-value-label" data-flow-key="([^"]+)" x="([\d.]+)" y="([\d.]+)"/g)];
  assert.ok(labels.length > 0, "must render at least one flow-value-label");
  for (const [, key, xs, ys] of labels) {
    const link = links.get(key);
    assert.ok(link, `flow-value-label's data-flow-key="${key}" must match a rendered flow-link`);
    const dist = distanceToLink(Number(xs), Number(ys), link.d);
    const band = link.width / 2 + 20; // link half-width plus the label's own above/below nudge + collision slack
    assert.ok(dist <= band, `label for ${key} at distance ${dist.toFixed(1)}px must sit within its own link band (${band.toFixed(1)}px)`);
  }
  console.log("sankey follow-up fix 3: each link-value label's anchor sits inside its own link band - PASS");
}

// ---------------------------------------------------------------------------
// Follow-up fix (4): a zh-language page never prints the raw "Mt" unit code;
// it uses an exact x100 conversion into 万吨 with thousands separators.
{
  const rows = [{ source: "origin:巴西", target: "destination:中国", value: 74.5 }];
  const spec = { ...baseLine, chart_type: "sankey", reader_task: "flow", source_field: "source", target_field: "target", value_field: "value", unit: "Mt", language: "zh", annotations: [] };
  const bundle = renderVizBundle(spec, rows);
  assert.ok(!/\bMt\b/.test(bundle.desktop), `a zh page must never print the raw unit code "Mt": ${bundle.desktop.match(/[^>]*Mt[^<]*/)?.[0]}`);
  assert.ok(bundle.desktop.includes("7,450万吨"), "74.5 Mt must render as an exact x100 conversion: 7,450万吨");
  console.log("sankey follow-up fix 4: zh page uses an exact 万吨 conversion, never raw 'Mt' - PASS");
}

// ---------------------------------------------------------------------------
// Follow-up fix (5): a sparse/irregular multi-line series shows a marker at
// every observation on every series, including a grey, non-highlighted
// context series - not just the highlighted one.
{
  const rows = [
    { year: "2016", series: "巴西", share: 34 }, { year: "2018", series: "巴西", share: 42 }, { year: "2020", series: "巴西", share: 55 }, { year: "2023", series: "巴西", share: 60 },
    { year: "2016", series: "美国", share: 40 }, { year: "2018", series: "美国", share: 32 }, { year: "2020", series: "美国", share: 22 }, { year: "2023", series: "美国", share: 18 },
  ];
  const spec = { ...baseLine, chart_type: "multi_line", x_field: "year", y_field: "share", value_field: "share", series_field: "series", unit: "%", highlight_values: ["巴西"], annotations: [] };
  const bundle = renderVizBundle(spec, rows);
  const markerCount = [...bundle.desktop.matchAll(/<circle data-role="line-point"/g)].length;
  assert.equal(markerCount, rows.length, `a sparse series must mark every observation on every series (including context): expected ${rows.length}, got ${markerCount}`);
  console.log("multi_line follow-up fix 5: sparse series marks every observation, context series included - PASS");
}

// ---------------------------------------------------------------------------
// Round-2 Sankey redesign: small (<3% share) nodes in the same column merge
// into a single grey "其他" node, exactly (no value dropped), the members
// are recoverable from the rendered SVG, only the highlighted flow uses the
// accent colour, node/value labels never overlap a bar or each other, and
// every label clears the 12px CJK floor.
{
  const rows = [
    { source: "origin:巴西", target: "destination:中国", value: 71.5 },
    { source: "origin:美国", target: "destination:中国", value: 18.2 },
    { source: "origin:阿根廷", target: "destination:中国", value: 2.0 },
    { source: "origin:乌拉圭", target: "destination:中国", value: 1.1 },
    { source: "origin:巴拉圭", target: "destination:中国", value: 0.8 },
  ];
  const spec = { ...baseLine, chart_type: "sankey", reader_task: "flow", source_field: "source", target_field: "target", value_field: "value", unit: "Mt", language: "zh", highlight_values: ["巴西"], annotations: [] };
  const bundle = renderVizBundle(spec, rows);
  const grandTotal = rows.reduce((sum, r) => sum + r.value, 0);

  // Merge exactness: 阿根廷(2.0)/乌拉圭(1.1)/巴拉圭(0.8) are each under 3% of
  // grandTotal (~93.6) and must merge into one grey "其他" node whose total
  // exactly equals their sum, with members recoverable from <metadata>.
  const merges = [...bundle.desktop.matchAll(/<metadata data-role="flow-merge" data-node="([^"]+)" data-total="([\d.]+)">([^<]*)<\/metadata>/g)];
  assert.equal(merges.length, 1, `expected exactly one merged "other" node, got ${merges.length}`);
  const [, , total, membersJson] = merges[0];
  const members = JSON.parse(membersJson.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  const memberSum = members.reduce((sum, m) => sum + m.value, 0);
  assert.ok(Math.abs(memberSum - Number(total)) < 1e-9, `merged total ${total} must exactly equal the sum of its members ${memberSum}`);
  assert.ok(Math.abs(memberSum - (2.0 + 1.1 + 0.8)) < 1e-9, `merge must not drop or alter any source value: ${memberSum}`);
  assert.equal(members.length, 3, "all three small sources must be recorded as members");
  assert.ok(/>其他</.test(bundle.desktop), "the merged node's display label must read 其他");

  // Only the highlighted flow (Brazil -> China) uses the accent colour;
  // every other rendered link - including the merged "其他" flow - is grey.
  const linkTags = [...bundle.desktop.matchAll(/<path data-role="flow-link"[^>]*stroke="(#[0-9a-fA-F]{3,8})"[^>]*stroke-opacity="([\d.]+)"[^>]*\/>/g)];
  assert.ok(linkTags.length >= 2, "must render at least two flow-link paths (Brazil, US/other)");
  const accentLinks = linkTags.filter((m) => Number(m[2]) >= 0.8);
  assert.equal(accentLinks.length, 1, `exactly one link may render at accent strength, found ${accentLinks.length}`);
  for (const m of linkTags) {
    const isAccent = Number(m[2]) >= 0.8;
    assert.ok(isAccent ? Number(m[2]) === 0.85 : Number(m[2]) === 0.35, `link opacity ${m[2]} must be exactly 0.85 (highlighted) or 0.35 (grey)`);
  }

  // Font floor: every on-chart label (node name/value, flow value) is
  // >=12px, CJK included.
  const fontSizes = [...bundle.desktop.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(fontSizes.length > 0, "must render sized text");
  for (const size of fontSizes) assert.ok(size >= 12, `on-chart text must clear the 12px floor, found ${size}`);

  // Labels never overlap a bar or each other (render-QA geometry gate).
  const qaDesktop = checkSvgGeometry(bundle.desktop);
  const qaMobile = checkSvgGeometry(bundle.mobile);
  assert.equal(qaDesktop.passed, true, JSON.stringify(qaDesktop.failures));
  assert.equal(qaMobile.passed, true, JSON.stringify(qaMobile.failures));

  console.log("sankey round-2 redesign: exact merge, single accent flow, label/bar/label clearance, 12px floor - PASS");
}

// ---------------------------------------------------------------------------
// Follow-up fix (6): the renderer must strip a leading "来源：", "资料来源：",
// "数据来源：" or "Source(s):" the source_note already carries before adding
// its own prefix, so the footer never doubles up as "数据来源：来源：..." or
// "Source: Source: ...".
{
  const rows = [
    { year: "2020", value: 1 }, { year: "2021", value: 2 },
  ];
  const cases = [
    { note: "来源：UN Comtrade（HS 1201，镜像数据，2023年）", language: "zh", expect: "数据来源：UN Comtrade（HS 1201，镜像数据，2023年）" },
    { note: "资料来源：UN Comtrade", language: "zh", expect: "数据来源：UN Comtrade" },
    { note: "数据来源：UN Comtrade", language: "zh", expect: "数据来源：UN Comtrade" },
    { note: "Source: UN Comtrade", language: "en", expect: "Source: UN Comtrade" },
    { note: "Sources: UN Comtrade", language: "en", expect: "Source: UN Comtrade" },
  ];
  for (const c of cases) {
    const spec = { ...baseLine, chart_type: "multi_line", x_field: "year", y_field: "value", value_field: "value", series_field: "year", unit: "%", language: c.language, source_note: c.note, highlight_values: [] };
    const bundle = renderVizBundle(spec, rows);
    assert.ok(bundle.desktop.includes(c.expect), `source_note "${c.note}" must render exactly once as "${c.expect}"`);
  }
  console.log("sankey/footer follow-up fix 6: source_note's own prefix is never doubled - PASS");
}

// ---------------------------------------------------------------------------
// Follow-up fix (7): the spec's explicit (source, target) highlight always
// wins over "largest outgoing row" - the fallback only applies when a
// highlighted source names no specific target flow.
{
  const rows = [
    { source: "origin:巴西", target: "destination:中国", value: 71.5 },
    { source: "origin:巴西", target: "destination:其他市场", value: 9.4 },
    { source: "origin:美国", target: "destination:中国", value: 18.2 },
  ];
  const spec = { ...baseLine, chart_type: "sankey", reader_task: "flow", source_field: "source", target_field: "target", value_field: "value", unit: "Mt", highlight_values: ["巴西", "其他市场"], annotations: [] };
  const bundle = renderVizBundle(spec, rows);
  const linkTags = [...bundle.desktop.matchAll(/<path data-role="flow-link" data-flow-key="([^"]+)"[^>]*stroke-opacity="([\d.]+)"/g)];
  assert.equal(linkTags.length, 3, `expected all three flow-link paths, got ${linkTags.length}`);
  const opacityByKey = new Map(linkTags.map((m) => [m[1], Number(m[2])]));
  const brazilOther = [...opacityByKey].find(([key]) => key.includes("其他市场"))?.[1];
  const brazilChina = [...opacityByKey].find(([key]) => key.includes("origin:巴西") && key.includes("destination:中国"))?.[1];
  assert.ok(brazilOther !== undefined && brazilChina !== undefined, "must find both Brazil outgoing links");
  assert.ok(brazilOther > brazilChina, `explicit highlight_values:["巴西","其他市场"] must highlight 巴西→其他市场 (opacity ${brazilOther}), not the larger 巴西→中国 (opacity ${brazilChina})`);
  assert.equal(brazilOther, 0.85, "the explicitly-named flow must render at full accent opacity");
  assert.equal(brazilChina, 0.35, "巴西→中国 must NOT be highlighted just because it is Brazil's largest flow, once an explicit target is named");
  console.log("sankey follow-up fix 7: explicit (source,target) highlight overrides largest-outgoing-row fallback - PASS");
}

console.log("line + sankey polish regression: ALL PASS");
