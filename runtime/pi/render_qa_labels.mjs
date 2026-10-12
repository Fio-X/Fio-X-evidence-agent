// Deterministic, browser-free "value labels complete" check over a rendered
// choropleth SVG string.
//
// The problem this closes: infographic lint's visual_channel_owner_validator
// blocks any visual whose only channel carrying a quantitative value is
// low-precision (color) - color_only_quantity - because a reader normally
// cannot recover an exact value from hue alone. A choropleth that prints
// every region's own value as text right on the map is a real exception to
// that rule, but only if the printed text is genuinely complete, exact, and
// legible - never because the plan *says* so. This module is the
// independent, from-the-rendered-artifact proof: given the rendered SVG text
// and the same rows/spec fields the chart was built from, it re-derives, via
// the renderer's own deterministic join (choropleth.mjs's
// joinChoroplethRows) and its own value formatter (viz.mjs's fmt, imported
// back rather than re-implemented so the two can never drift), exactly what
// every plotted region's label ought to say, and compares that against what
// the SVG actually shows.
//
// Pure: no file I/O, no network, no model or provider call, no browser.
// Bound into runtime/pi/render_qa.mjs's per-viewport report next to
// checkSvgGeometry/checkSvgContrast, so it inherits that report's existing
// svg_sha256 binding - src/verify.rs and scripts/verify_artifact.py re-hash
// the actual rendered SVG bytes and refuse to trust a report that does not
// match, exactly as they already do for geometry/contrast. A tampered SVG
// (a label deleted, a digit changed) therefore fails re-verification the
// same way any other render_qa mismatch does; this module only has to get
// the *first* pass right, not defend the report against tampering itself.
//
// Renderer contract this reads (runtime/pi/viz.mjs's renderChoropleth):
//   - every plotted (data-bearing) region is a <path data-role="choropleth-data"
//     data-iso3="..." data-value="...">
//   - every region with no data for this chart is a
//     <path data-role="choropleth-context"> painted the shared no-data fill
//   - every plotted region's name/value get one <text data-role=
//     "choropleth-label" data-iso3="...."> and one <text data-role=
//     "choropleth-label-value" data-iso3="...">, on-map or in the side
//     margin, in either case carrying the same data-iso3 - UNLESS the plan
//     opted into a zoom inset (spec.inset) and this region is one of the
//     inset's own regions, in which case it carries no main-map label at all
//     and instead gets exactly one <text data-role="choropleth-inset-label"
//     data-iso3="..."> and one <text data-role="choropleth-inset-label-value"
//     data-iso3="..."> inside the inset panel. Either way, every plotted
//     region must show its name+value label exactly once - in the main map
//     or in the inset, never both, never neither, never twice in the same
//     place.
export const RENDER_QA_LABELS_VERSION = "1.5.0"; // + leadered-label box-overlaps-polygon and minimum-leader-length checks (v7); + marker_displaced_without_tether (1.4.0); + markers_list_only_exceed_quarter and list_only_markers (1.5.0)

function walk(node, out) {
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

// The value text is either wrapped in its own leading <tspan> (on-map
// layout, where a second <tspan> may carry the reference period) or is the
// text node's own bare text (margin/overflow layout, where truncation - the
// exact defect this check exists to catch - shows up as a literal "…").
function labelText(node) {
  const tspan = node.children.find((child) => child.tag === "tspan");
  return String(tspan ? tspan.text : node.text).trim();
}

// Straight-line-only path parser (review fix: leader length / border
// straddle). Every choropleth `d` attribute this reads (choropleth-data,
// choropleth-leader) is emitted by runtime/pi/choropleth.mjs's ringPath,
// which only ever writes M/L/Z commands (no curves/arcs) - see that
// function's own doc comment - so a plain M/L/Z tokenizer is exact, not an
// approximation, and needs no access to the renderer's own projection
// state: it works purely from the rendered SVG on disk.
function parsePathRings(d) {
  const rings = [];
  let current = null;
  const re = /([ML])(-?[\d.]+),(-?[\d.]+)|Z/g;
  let m;
  while ((m = re.exec(String(d ?? "")))) {
    if (m[0] === "Z") {
      if (current) rings.push(current);
      current = null;
      continue;
    }
    const [x, y] = [Number(m[2]), Number(m[3])];
    if (m[1] === "M") {
      if (current) rings.push(current);
      current = [[x, y]];
    } else if (current) {
      current.push([x, y]);
    }
  }
  if (current) rings.push(current);
  return rings;
}

// Nonzero-winding point-in-polygon over a parsed ring set, mirroring
// viz.mjs's own pointOnFeature but reading the ALREADY-RENDERED pixel-space
// polygon straight off the SVG rather than the renderer's internal
// lon/lat projection - the independence the border-straddle check needs.
function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

function pathLength(d) {
  const pts = [];
  const re = /[ML](-?[\d.]+),(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(String(d ?? "")))) pts.push([Number(m[1]), Number(m[2])]);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

// Review fix (v7, "Liberia in the inset is not acceptable yet"): exact
// segment/box intersection, independently re-derived here (not imported from
// viz.mjs's own segmentCrossesBox) so this check proves the rendered
// geometry rather than re-running the renderer's own decision.
function segmentIntersectsSegment(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function segmentCrossesBox(ax, ay, bx, by, box) {
  if (ax >= box.x0 && ax <= box.x1 && ay >= box.y0 && ay <= box.y1) return true;
  if (bx >= box.x0 && bx <= box.x1 && by >= box.y0 && by <= box.y1) return true;
  const c = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
  for (let i = 0; i < 4; i++) {
    const [cx1, cy1] = c[i];
    const [cx2, cy2] = c[(i + 1) % 4];
    if (segmentIntersectsSegment(ax, ay, bx, by, cx1, cy1, cx2, cy2)) return true;
  }
  return false;
}
// A box "overlaps" a ring set when any ring edge crosses it, or - the
// fully-inside case, no edge crossing possible - when the box's own centre
// falls inside the rings (pointInRings, defined above).
function ringsCrossBox(rings, box) {
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[j];
      if (segmentCrossesBox(x1, y1, x2, y2, box)) return true;
    }
  }
  return pointInRings((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, rings);
}
// Same CJK-aware glyph-width estimate test_choropleth.mjs's own leader/label
// helpers use (a full-width CJK code point measures as one em, everything
// else as 0.56em) - kept in sync by convention, not by import, per this
// file's independence rule (see module doc comment).
function glyphWidth(text, size, textWidth) {
  if (textWidth) return textWidth(text, size, false); // NEWSROOM_QA_SHARED_WIDTH=1: render_qa.mjs injects the geometry estimator
  return Array.from(text).reduce((sum, ch) => sum + (/[　-鿿＀-￯]/u.test(ch) ? size : size * 0.56), 0);
}

/**
 * @param {string} svgText - one rendered viewport's full SVG document text.
 * @param {object} options
 * @param {Array<object>} options.rows - the exact rows the chart was built from.
 * @param {string} options.category_field
 * @param {string} options.value_field
 * @param {string} options.category_names - 'worldbank' | 'iso3' | 'iso2'
 * @param {string} [options.unit]
 * @param {(text: string) => any} deps.parseXml - injected to avoid a static
 *   import cycle with render_qa_svg.mjs's own consumers; render_qa.mjs wires
 *   the real implementation through.
 * @param {(rows, spec) => any[]} deps.joinChoroplethRows
 * @param {(value: number, unit?: string, spec?: object) => string} deps.fmt
 * @param {string} deps.noDataFill - must equal renderChoropleth's own current
 *   non-data fill (viz.mjs's live-bound PALETTE.grid). Injected the same way
 *   as parseXml/joinChoroplethRows/fmt above - this module stays pure and
 *   import-free - rather than kept as a hand-copied literal, so this check
 *   can never silently drift from the renderer's actual colour the way a
 *   frozen copy would the moment the renderer's own value changes (e.g.
 *   between the legacy and house styles). render_qa.mjs wires the real
 *   PALETTE.grid through.
 */
export function checkChoroplethValueLabels(svgText, options, deps) {
  const { parseXml, joinChoroplethRows, fmt, noDataFill, worldLabelIso3s, worldListEnabled, worldListText } = deps;
  const expectedNoDataFill = String(noDataFill ?? "").toLowerCase();
  const rows = Array.isArray(options?.rows) ? options.rows : [];
  const spec = { category_field: options?.category_field, category_names: options?.category_names };
  const unit = options?.unit ?? "";
  // measure kind/semantics (P2) so the expected label text is spelled the same way the renderer spelled it
  const kindSpec = { unit, value_field: options?.value_field, measure_kind: options?.measure_kind, measure_semantics: options?.measure_semantics, language: options?.language };
  const value_field = options?.value_field;

  const root = parseXml(svgText);
  const nodes = walk(root, []);
  const dataPaths = nodes.filter((n) => n.tag === "path" && n.attrs["data-role"] === "choropleth-data");
  const contextPaths = nodes.filter((n) => n.tag === "path" && n.attrs["data-role"] === "choropleth-context");
  // Name/value labels can appear on the main map, inside a zoom inset (task:
  // inset), or - for a region a boundary column couldn't fit within its
  // leader-length cap (task: leader research) - in the numbered-footnote
  // fallback below the map. All three roles feed the same per-iso3 tally
  // below, so "exactly one label, wherever it lives" is what gets proven,
  // not "exactly one on-map label".
  const nameLabels = nodes.filter((n) => n.tag === "text" && ["choropleth-label", "choropleth-inset-label", "choropleth-footnote-name"].includes(n.attrs["data-role"]));
  const valueLabels = nodes.filter((n) => n.tag === "text" && ["choropleth-label-value", "choropleth-inset-label-value", "choropleth-footnote-value"].includes(n.attrs["data-role"]));

  const failures = [];

  for (const path of contextPaths) {
    const fill = String(path.attrs.fill ?? "").toLowerCase();
    if (fill !== expectedNoDataFill) {
      failures.push({ rule: "no_data_style_missing", message: `a no-data region has fill '${path.attrs.fill ?? ""}', expected the shared no-data fill ${noDataFill}` });
    }
  }

  const dataIso3ByRegion = new Map();
  for (const path of dataPaths) {
    const iso3 = path.attrs["data-iso3"];
    const value = path.attrs["data-value"];
    if (!iso3 || value === undefined || value === "") {
      failures.push({ rule: "data_region_missing_attrs", message: "a plotted region is missing data-iso3/data-value" });
      continue;
    }
    dataIso3ByRegion.set(iso3, Number(value));
  }

  // Collected as arrays, not a last-write-wins Map: a region labelled more
  // than once (main map AND inset, or twice in the same place) must fail,
  // even when every copy happens to agree - "exactly once" is the contract,
  // not "at least once and consistent".
  const namesByIso3 = new Map();
  for (const label of nameLabels) {
    const iso3 = label.attrs["data-iso3"];
    if (!iso3) continue;
    if (!namesByIso3.has(iso3)) namesByIso3.set(iso3, []);
    namesByIso3.get(iso3).push(labelText(label));
  }
  const valuesByIso3 = new Map();
  for (const label of valueLabels) {
    const iso3 = label.attrs["data-iso3"];
    if (!iso3) continue;
    if (!valuesByIso3.has(iso3)) valuesByIso3.set(iso3, []);
    valuesByIso3.get(iso3).push(labelText(label));
  }

  const joined = joinChoroplethRows(rows, spec).filter(
    (item) => item.entry?.kind === "economy" && item.iso3 && item.featureIndices.length && Number.isFinite(Number(item.row?.[value_field])),
  );

  const wanContext = joined.some((item) => Math.abs(Number(item.row[value_field])) >= 10_000);

  // World mode (map_extent: "world") labels only the range ends and highlight_values;
  // the set is re-derived from the rows here, and every other region must carry no text.
  const worldLabelled = options?.map_extent === "world" && typeof worldLabelIso3s === "function"
    ? worldLabelIso3s(joined, { value_field, category_field: options?.category_field, highlight_values: options?.highlight_values })
    : null;

  // World list mode (the program's own NEWSROOM_MAP_WORLD_LIST switch, passed in as deps.worldListEnabled; never read
  // from the chart spec): every country with data carries exactly one name and one value, on the map or in the list
  // under it, so the "labelled although world mode labels only..." rule gives way to the same exactly-one rule below.
  // The expected set is the rows' own iso3s, not anything read from the SVG; a label for a country with no data row fails.
  const worldList = Boolean(worldLabelled) && typeof worldListEnabled === "function" && worldListEnabled() === true;
  if (worldList) {
    const dataIso3 = new Set(joined.map((item) => item.iso3));
    for (const iso3 of new Set([...namesByIso3.keys(), ...valuesByIso3.keys()])) {
      if (!dataIso3.has(iso3)) failures.push({ rule: "value_label_unexpected", message: `${iso3} is labelled although it has no data row` });
    }
  }

  const joinedValues = joined.map((item) => Number(item.row[value_field]));
  for (const item of joined) {
    const iso3 = item.iso3;
    const value = Number(item.row[value_field]);
    const expectedValueText = worldList && typeof worldListText === "function" && !worldLabelled.has(iso3) ? worldListText(value, unit, kindSpec, joinedValues, wanContext) : fmt(value, unit, kindSpec, wanContext);
    if (!dataIso3ByRegion.has(iso3)) {
      failures.push({ rule: "value_label_missing_region", message: `${iso3} has a data row but no rendered choropleth-data region` });
      continue;
    }
    const renderedValue = dataIso3ByRegion.get(iso3);
    if (Number.isFinite(renderedValue) && Math.abs(renderedValue - value) > 1e-9) {
      failures.push({ rule: "region_value_mismatch", message: `${iso3} region data-value is ${renderedValue}, row value is ${value}` });
    }
    if (worldLabelled && !worldList && !worldLabelled.has(iso3)) {
      if ((namesByIso3.get(iso3) ?? []).length || (valuesByIso3.get(iso3) ?? []).length) {
        failures.push({ rule: "value_label_unexpected", message: `${iso3} is labelled although world mode labels only the range ends and highlight_values` });
      }
      continue;
    }
    const names = namesByIso3.get(iso3) ?? [];
    const values = valuesByIso3.get(iso3) ?? [];
    if (names.length === 0) failures.push({ rule: "value_label_missing", message: `${iso3} has no visible name label` });
    else if (names.length > 1) failures.push({ rule: "value_label_duplicate", message: `${iso3} has ${names.length} name labels (main map and/or inset); it must be labelled exactly once` });
    if (values.length === 0) {
      failures.push({ rule: "value_label_missing", message: `${iso3} has no visible value label` });
      continue;
    }
    if (values.length > 1) {
      const distinct = [...new Set(values)];
      failures.push({ rule: "value_label_duplicate", message: `${iso3} has ${values.length} value labels (main map and/or inset) showing [${distinct.join(", ")}]; it must be labelled exactly once` });
      continue;
    }
    const shownValue = values[0];
    if (shownValue !== expectedValueText) {
      failures.push({ rule: "value_label_mismatch", message: `${iso3} shows '${shownValue}', expected '${expectedValueText}' for row value ${value} (truncated, clipped, or wrong)` });
    }
  }

  // Review fix (map extent): a leader (choropleth-leader, main map only -
  // the source-to-inset connector is a separate, differently-purposed line
  // and is not a per-label leader) must never be longer than the render-QA
  // gate allows, regardless of how the renderer chose to place it.
  const MAX_LEADER_PX = 120;
  const leaderPaths = nodes.filter((n) => n.tag === "path" && n.attrs["data-role"] === "choropleth-leader");
  for (const leader of leaderPaths) {
    const len = pathLength(leader.attrs.d);
    if (len > MAX_LEADER_PX + 0.5) {
      failures.push({ rule: "leader_too_long", message: `a choropleth leader is ${len.toFixed(1)}px long, over the ${MAX_LEADER_PX}px floor` });
    }
  }

  // Review fix (labels crossing borders): an on-map label (text-anchor
  // "middle" - the on-polygon placement; a leader/overflow label is exempt,
  // since it is explicitly outside its own region already) must sit mostly
  // on its own region's polygon, never mostly on a neighbour's. Sampled
  // straight off the already-rendered choropleth-data <path d> geometry (see
  // parsePathRings's own doc comment for why this is exact, not a lon/lat
  // re-derivation) - independent of anything the renderer itself decided.
  const polygonsByIso3 = new Map();
  for (const path of dataPaths) {
    const iso3 = path.attrs["data-iso3"];
    if (!iso3) continue;
    if (!polygonsByIso3.has(iso3)) polygonsByIso3.set(iso3, []);
    polygonsByIso3.get(iso3).push(...parsePathRings(path.attrs.d));
  }
  // v7: the inset panel projects its own regions through a separate
  // projection (viz.mjs's zoomProj) into the same absolute canvas space as
  // the main map, but renders them under a distinct role
  // (choropleth-inset-data) - a leadered inset label must be checked against
  // these rings, never the main map's own choropleth-data rings.
  const insetPolygonsByIso3 = new Map();
  for (const path of nodes.filter((cand) => cand.tag === "path" && cand.attrs["data-role"] === "choropleth-inset-data")) {
    const iso3 = path.attrs["data-iso3"];
    if (!iso3) continue;
    if (!insetPolygonsByIso3.has(iso3)) insetPolygonsByIso3.set(iso3, []);
    insetPolygonsByIso3.get(iso3).push(...parsePathRings(path.attrs.d));
  }
  // P3 (add-only gate): a region that the inset itself draws smaller than the
  // dot threshold is invisible as a polygon, so it must carry a value-coloured
  // dot in the inset (same threshold as viz.mjs TINY_REGION_PX: 6px desktop,
  // 5px mobile).
  const insetDotIso3 = new Set(nodes.filter((n) => n.tag === "circle" && n.attrs["data-role"] === "choropleth-inset-dot").map((n) => n.attrs["data-iso3"]));
  const insetTinyPx = nodes.find((n) => n.tag === "svg")?.attrs?.["data-viewport"] === "mobile" ? 5 : 6;
  for (const [iso3, rings] of insetPolygonsByIso3) {
    let largest = 0;
    for (const ring of rings) {
      const xs = ring.map((pt) => pt[0]), ys = ring.map((pt) => pt[1]);
      largest = Math.max(largest, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
    if (largest < insetTinyPx && !insetDotIso3.has(iso3)) {
      failures.push({ rule: "inset_region_too_small", message: `${iso3} is drawn ${largest.toFixed(1)}px across in the inset (under ${insetTinyPx}px) and has no value-coloured dot` });
    }
  }
  const onMapNameLabels = nodes.filter((n) => n.tag === "text" && n.attrs["data-role"] === "choropleth-label" && n.attrs["text-anchor"] === "middle");
  const onMapValueLabels = nodes.filter((n) => n.tag === "text" && n.attrs["data-role"] === "choropleth-label-value" && n.attrs["text-anchor"] === "middle");
  for (const label of [...onMapNameLabels, ...onMapValueLabels]) {
    const iso3 = label.attrs["data-iso3"];
    const ownRings = polygonsByIso3.get(iso3);
    if (!iso3 || !ownRings) continue;
    const x = Number(label.attrs.x);
    const y = Number(label.attrs.y);
    const fontSize = Number(label.attrs["font-size"]) || 12;
    const text = labelText(label);
    const halfW = Math.max(4, text.length * fontSize * 0.3);
    const samples = [
      [x, y], [x - halfW, y], [x + halfW, y],
    ];
    for (const [otherIso3, otherRings] of polygonsByIso3) {
      if (otherIso3 === iso3) continue;
      const straddling = samples.some(([sx, sy]) => pointInRings(sx, sy, otherRings));
      if (straddling) {
        failures.push({ rule: "label_straddles_neighbour", message: `${iso3}'s label sits partly on ${otherIso3}'s polygon instead of its own` });
        break;
      }
    }
  }

  // Review fix (v7, "Liberia in the inset is not acceptable yet"): a
  // leadered label - one the renderer placed off its own polygon and
  // connected back with a leader line, because it could not be set legibly
  // inside any polygon - must land in genuinely open space: its box must not
  // overlap ANY data polygon, its own included (unlike label_straddles_
  // neighbour above, which allows and expects an on-map label to sit on its
  // OWN region's polygon), and the leader itself must be a real, visible
  // connector, not a near-zero-length line that only technically qualifies
  // as "leadered" while the label still sits on top of the map. Mirrors the
  // hard gates viz.mjs's own renderChoropleth now enforces at placement time
  // (MIN_LEADER_DRAWN_LENGTH, boxOverlapsFeature), but re-derived here from
  // the rendered SVG alone, independent of the renderer's own bookkeeping -
  // this is the proof that those gates actually held, not a re-run of them.
  const MIN_LEADER_PX = 10;
  const LEADER_ROLES = [
    { leader: "choropleth-leader", name: "choropleth-label", value: "choropleth-label-value", polygons: polygonsByIso3 },
    { leader: "choropleth-inset-leader", name: "choropleth-inset-label", value: "choropleth-inset-label-value", polygons: insetPolygonsByIso3 },
  ];
  for (const { leader: leaderRole, name: nameRole, value: valueRole, polygons } of LEADER_ROLES) {
    const nameByIso3 = new Map();
    for (const textNode of nodes.filter((cand) => cand.tag === "text" && cand.attrs["data-role"] === nameRole)) {
      if (textNode.attrs["data-iso3"]) nameByIso3.set(textNode.attrs["data-iso3"], textNode);
    }
    const valueByIso3 = new Map();
    for (const textNode of nodes.filter((cand) => cand.tag === "text" && cand.attrs["data-role"] === valueRole)) {
      if (textNode.attrs["data-iso3"]) valueByIso3.set(textNode.attrs["data-iso3"], textNode);
    }
    for (const leaderNode of nodes.filter((cand) => cand.tag === "path" && cand.attrs["data-role"] === leaderRole)) {
      const iso3 = leaderNode.attrs["data-iso3"];
      if (!iso3) continue;
      const len = pathLength(leaderNode.attrs.d);
      if (len < MIN_LEADER_PX - 0.5) {
        failures.push({ rule: "leader_too_short", message: `${leaderRole} for ${iso3} is ${len.toFixed(1)}px long, under the ${MIN_LEADER_PX}px floor` });
      }
      const nameNode = nameByIso3.get(iso3);
      const valueNode = valueByIso3.get(iso3);
      if (!nameNode || !valueNode) continue; // value_label_missing above already covers an absent label
      const lineBoxes = [nameNode, valueNode].map((node) => {
        const x = Number(node.attrs.x);
        const y = Number(node.attrs.y);
        const size = Number(node.attrs["font-size"]) || 12;
        const w = glyphWidth(labelText(node), size, deps.textWidth);
        const anchor = node.attrs["text-anchor"] === "end" ? "end" : node.attrs["text-anchor"] === "middle" ? "middle" : "start";
        const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
        return { x0, x1: x0 + w, y0: y - size * 0.9, y1: y + size * 0.25 };
      });
      const box = {
        x0: Math.min(lineBoxes[0].x0, lineBoxes[1].x0),
        x1: Math.max(lineBoxes[0].x1, lineBoxes[1].x1),
        y0: Math.min(lineBoxes[0].y0, lineBoxes[1].y0),
        y1: Math.max(lineBoxes[0].y1, lineBoxes[1].y1),
      };
      for (const [otherIso3, rings] of polygons) {
        if (ringsCrossBox(rings, box)) {
          failures.push({ rule: "leader_label_overlaps_polygon", message: `${leaderRole} label for ${iso3} box overlaps ${otherIso3}'s polygon` });
          break;
        }
      }
    }
  }

  // A numbered marker whose circle no longer covers the point it stands for
  // (data-anchor-x/y) must be joined to that point by a "<role>-leader" path
  // that starts on its circle and ends at the point; otherwise the number has
  // no visible geographic link.
  for (const role of ["choropleth-footnote-marker", "choropleth-inset-footnote-marker"]) {
    const tethers = nodes.filter((n) => n.tag === "path" && n.attrs["data-role"] === `${role}-leader`);
    for (const marker of nodes.filter((n) => n.tag === "circle" && n.attrs["data-role"] === role)) {
      const ax = Number(marker.attrs["data-anchor-x"]), ay = Number(marker.attrs["data-anchor-y"]);
      const cx = Number(marker.attrs.cx), cy = Number(marker.attrs.cy), r = Number(marker.attrs.r) || 9;
      const num = marker.attrs["data-number"];
      if (![ax, ay, cx, cy].every(Number.isFinite)) {
        failures.push({ rule: "marker_displaced_without_tether", message: `marker ${num} (${marker.attrs["data-iso3"]}) carries no anchor point` });
        continue;
      }
      if (Math.hypot(cx - ax, cy - ay) <= r) continue;
      const ok = tethers.some((t) => {
        if (t.attrs["data-number"] !== num) return false;
        const pts = (String(t.attrs.d ?? "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        if (pts.length < 4) return false;
        const [sx, sy] = pts, [ex, ey] = pts.slice(-2);
        return Math.abs(Math.hypot(sx - cx, sy - cy) - r) <= 1.5 && Math.hypot(ex - ax, ey - ay) <= 0.6;
      });
      if (!ok) failures.push({ rule: "marker_displaced_without_tether", message: `marker ${num} (${marker.attrs["data-iso3"]}) is displaced ${Math.hypot(cx - ax, cy - ay).toFixed(0)}px from its point with no tether back to it` });
    }
  }

  // Regions left without a map marker (list-only) are reported, and a chart
  // that drops more than a quarter of its numbered markers fails.
  const listOnlyNode = nodes.find((n) => n.attrs?.["data-role"] === "choropleth-marker-list-only");
  const listOnly = listOnlyNode
    ? { count: Number(listOnlyNode.attrs["data-count"]), total: Number(listOnlyNode.attrs["data-total"]), iso3: String(listOnlyNode.attrs["data-iso3"] ?? "").split(",").filter(Boolean) }
    : { count: 0, total: 0, iso3: [] };
  if (listOnly.count > 0 && !(listOnly.count * 4 <= listOnly.total)) {
    failures.push({ rule: "markers_list_only_exceed_quarter", message: `${listOnly.count} of ${listOnly.total} numbered regions have no map marker (more than a quarter): ${listOnly.iso3.join(", ")}` });
  }
  return { passed: failures.length === 0, checked: joined.length, failures, list_only_markers: listOnly };
}

/**
 * NEWSROOM_HEATMAP_VALUE_LABELS=1 proof for a desktop heatmap: EVERY cell with a non-null value has exactly one cell rect
 * and exactly one value text that is the exact formatted value (heatmapCellText), centred inside that cell, at or above
 * the 12px floor. A cell without a label (labels are dropped when cellW <= 48 or cellH <= 30) fails. Contrast is proven by
 * render_qa.mjs, which fails this check when the viewport's contrast check has any failure.
 * @param {string} svgText
 * @param {{rows: object[], x_field: string, y_field: string, value_field: string}} options
 * @param {{parseXml: Function, cellText: (value: number) => string}} deps
 */
export function checkHeatmapValueLabels(svgText, options, deps) {
  const { parseXml, cellText } = deps;
  const rows = Array.isArray(options?.rows) ? options.rows : [];
  const nodes = walk(parseXml(svgText), []);
  const key = (x, y) => `${x}\u0000${y}`;
  const cells = new Map();
  for (const n of nodes.filter((c) => c.tag === "rect" && c.attrs["data-role"] === "heatmap-cell")) {
    const k = key(n.attrs["data-x"], n.attrs["data-y"]);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(n);
  }
  const texts = new Map();
  for (const n of nodes.filter((c) => c.tag === "text" && c.attrs["data-role"] === "heatmap-cell-value")) {
    const k = key(n.attrs["data-x"], n.attrs["data-y"]);
    if (!texts.has(k)) texts.set(k, []);
    texts.get(k).push(n);
  }
  const failures = [];
  const seen = new Set();
  for (const row of rows) {
    const raw = row?.[options?.value_field];
    const value = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(value)) continue;
    const k = key(String(row[options.x_field]), String(row[options.y_field]));
    if (seen.has(k)) continue;
    seen.add(k);
    const name = `${row[options.y_field]} / ${row[options.x_field]}`;
    const rect = cells.get(k) ?? [];
    const labels = texts.get(k) ?? [];
    if (rect.length !== 1) { failures.push({ rule: "heatmap_cell_missing", message: `${name} has ${rect.length} rendered cells, expected one` }); continue; }
    if (labels.length === 0) { failures.push({ rule: "value_label_missing", message: `${name} has no visible value label` }); continue; }
    if (labels.length > 1) { failures.push({ rule: "value_label_duplicate", message: `${name} has ${labels.length} value labels; it must be labelled exactly once` }); continue; }
    const label = labels[0];
    const shown = labelText(label), expected = cellText(value);
    if (shown !== expected) failures.push({ rule: "value_label_mismatch", message: `${name} shows '${shown}', expected '${expected}'` });
    const size = Number(label.attrs["font-size"]);
    if (!(size >= 12)) failures.push({ rule: "value_label_font_below_floor", message: `${name} label is ${label.attrs["font-size"] ?? "unsized"}px, below 12px` });
    const cx = Number(rect[0].attrs.x), cy = Number(rect[0].attrs.y), cw = Number(rect[0].attrs.width), ch = Number(rect[0].attrs.height);
    // the text's x is its anchor point: centre by default (heatmap cells); a text-anchor of start/end (tile_map corner numbers) puts the box to one side of it
    const tx = Number(label.attrs.x), ty = Number(label.attrs.y), width = glyphWidth(shown, size, deps.textWidth);
    const anchor = label.attrs["text-anchor"];
    const left = anchor === "end" ? tx - width : anchor === "start" ? tx : tx - width / 2;
    const inside = left >= cx - 0.01 && left + width <= cx + cw + 0.01 && ty - size * 0.8 >= cy - 0.01 && ty + size * 0.25 <= cy + ch + 0.01;
    if (!inside) failures.push({ rule: "value_label_outside_cell", message: `${name} label does not fit inside its cell` });
  }
  if (seen.size === 0) failures.push({ rule: "value_label_missing", message: "the heatmap has no cell with a value to prove" });
  return { passed: failures.length === 0, failures };
}

// NEWSROOM_QA_HEATMAP_MONOTONE=1 (exact "1", default off): a heatmap's fill must get darker as the cell value grows, equal values must share a
// fill, and the grid must be complete. Reads only the values the cell proof already carries (data-value, rows); it computes no new numbers.
const parseFillRgb = (fill) => {
  const f = String(fill ?? "").trim();
  let m = f.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = f.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return null;
};
const relLuminance = ([r, g, b]) => {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
export function checkHeatmapFillMonotone(svgText, options, deps) {
  const { parseXml } = deps;
  const rows = Array.isArray(options?.rows) ? options.rows : [];
  const nodes = walk(parseXml(svgText), []);
  const key = (x, y) => `${x}\u0000${y}`;
  const cells = new Map();
  for (const n of nodes.filter((c) => c.tag === "rect" && c.attrs["data-role"] === "heatmap-cell")) {
    const k = key(n.attrs["data-x"], n.attrs["data-y"]);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(n);
  }
  const failures = [];
  const xs = [...new Set(rows.map((r) => String(r?.[options?.x_field])))];
  const ys = [...new Set(rows.map((r) => String(r?.[options?.y_field])))];
  const present = new Set();
  for (const row of rows) {
    const raw = row?.[options?.value_field];
    if (raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw))) present.add(key(String(row[options.x_field]), String(row[options.y_field])));
  }
  for (const y of ys) for (const x of xs) {
    if (!present.has(key(x, y))) failures.push({ rule: "heatmap_grid_incomplete", message: `${y} / ${x} has no value, so the grid is not complete` });
  }
  const measured = [];
  for (const [k, list] of cells) {
    if (list.length !== 1) continue;
    const a = list[0].attrs;
    const value = Number(a["data-value"]);
    const name = `${a["data-y"]} / ${a["data-x"]}`;
    const rgb = parseFillRgb(a.fill);
    if (!Number.isFinite(value)) { failures.push({ rule: "heatmap_fill_unreadable", message: `${name} has no readable value` }); continue; }
    if (!rgb) { failures.push({ rule: "heatmap_fill_unreadable", message: `${name} has a fill the check cannot read` }); continue; }
    measured.push({ name, value, fill: rgb.join(","), lum: relLuminance(rgb) });
  }
  measured.sort((p, q) => p.value - q.value);
  const EPS = 1e-4;
  for (let i = 1; i < measured.length; i++) {
    const lo = measured[i - 1], hi = measured[i];
    if (hi.value === lo.value) {
      if (hi.fill !== lo.fill) failures.push({ rule: "heatmap_equal_values_different_fill", message: `${lo.name} and ${hi.name} have the same value but different fills` });
    } else if (hi.lum > lo.lum + EPS) {
      failures.push({ rule: "heatmap_fill_not_monotone", message: `${hi.name} has a larger value than ${lo.name} but a lighter fill` });
    }
  }
  return { passed: failures.length === 0, failures, cells_checked: measured.length };
}

/**
 * chart_type tile_map (NEWSROOM_TILE_MAP=1) tile proof, run next to the heatmap value-label proof (which proves every printed
 * number). From the rendered SVG and the rows: every state that has rows has exactly one tile and one name (the table's
 * short name), no tile exists for a state without rows, tiles sit in the table's grid order (same column -> same x, same row
 * -> same y, both increasing), highlighted states (and only those) carry one highlight outline, and for the line mark every
 * line vertex, the peak dot and the last-point dot sit where the rows put them. The scale is re-derived here from the rows
 * (zero baseline unless a value is negative, top = the state's own peak), not read back from the SVG.
 * @param {string} svgText
 * @param {{rows: object[], category_field: string, x_field: string, value_field: string, cell_mark: "line"|"strip", language?: string, highlight_values?: string[], provisional_values?: string[]}} options
 * @param {{parseXml: Function, resolveUsState: Function, usStateShortName: Function, usStates: Function, orderedPoints: Function}} deps
 */
export function checkTileMapProof(svgText, options, deps) {
  const { parseXml, resolveUsState, usStateShortName, usStates, orderedPoints } = deps;
  const nodes = walk(parseXml(svgText), []);
  const failures = [];
  const rows = Array.isArray(options?.rows) ? options.rows : [];
  const points = orderedPoints(rows, options.x_field);
  const zh = options.language === "zh";
  const byState = new Map();
  for (const row of rows) {
    const st = resolveUsState(row?.[options.category_field]);
    if (!st) continue;
    if (!byState.has(st.usps)) byState.set(st.usps, { st, values: new Map(), raws: [] });
    const v = row[options.value_field] === null || row[options.value_field] === undefined || row[options.value_field] === "" ? NaN : Number(row[options.value_field]);
    const entry = byState.get(st.usps);
    if (Number.isFinite(v)) entry.values.set(String(row[options.x_field]), v);
    entry.raws.push(String(row[options.category_field]));
  }
  const of = (role) => nodes.filter((c) => c.attrs?.["data-role"] === role);
  const group = (list) => { const m = new Map(); for (const n of list) { const k = n.attrs["data-state"]; if (!m.has(k)) m.set(k, []); m.get(k).push(n); } return m; };
  const tiles = group(nodes.filter((c) => c.tag === "rect" && c.attrs?.["data-tile-state"] !== undefined).map((c) => ({ ...c, attrs: { ...c.attrs, "data-state": c.attrs["data-tile-state"] } }))), names = group(of("tile-map-name"));
  for (const usps of tiles.keys()) if (!byState.has(usps)) failures.push({ rule: "tile_map_extra_tile", message: `a tile is drawn for ${usps}, which has no row` });
  for (const [usps, { st }] of byState) {
    if ((tiles.get(usps) ?? []).length !== 1) { failures.push({ rule: "tile_map_tile_missing", message: `${usps} has ${(tiles.get(usps) ?? []).length} tiles, expected one` }); continue; }
    const nm = names.get(usps) ?? [];
    if (nm.length !== 1) { failures.push({ rule: "tile_map_name_missing", message: `${usps} has ${nm.length} names, expected one` }); continue; }
    const expected = usStateShortName(st, zh ? "zh" : "en");
    if (labelText(nm[0]) !== expected) failures.push({ rule: "tile_map_name_mismatch", message: `${usps} shows '${labelText(nm[0])}', the table says '${expected}'` });
  }
  const placed = [...byState.keys()].filter((k) => (tiles.get(k) ?? []).length === 1).map((k) => ({ st: byState.get(k).st, x: Number(tiles.get(k)[0].attrs.x), y: Number(tiles.get(k)[0].attrs.y) }));
  for (const a of placed) for (const b of placed) {
    if (a.st.tile_col === b.st.tile_col && Math.abs(a.x - b.x) > 0.01) failures.push({ rule: "tile_map_position", message: `${a.st.usps} and ${b.st.usps} share a tile column but sit at different x` });
    if (a.st.tile_row === b.st.tile_row && Math.abs(a.y - b.y) > 0.01) failures.push({ rule: "tile_map_position", message: `${a.st.usps} and ${b.st.usps} share a tile row but sit at different y` });
    if (a.st.tile_col < b.st.tile_col && !(a.x < b.x)) failures.push({ rule: "tile_map_position", message: `${a.st.usps} is not left of ${b.st.usps}` });
    if (a.st.tile_row < b.st.tile_row && !(a.y < b.y)) failures.push({ rule: "tile_map_position", message: `${a.st.usps} is not above ${b.st.usps}` });
  }
  const hot = new Set((options.highlight_values ?? []).map(String));
  const wantHot = [...byState.values()].filter(({ st, raws }) => hot.has(st.usps) || hot.has(st.en) || hot.has(st.zh) || raws.some((r) => hot.has(r))).map(({ st }) => st.usps).sort();
  const gotHot = of("tile-map-highlight").map((n) => n.attrs["data-state"]).sort();
  if (JSON.stringify(wantHot) !== JSON.stringify(gotHot)) failures.push({ rule: "tile_map_highlight", message: `highlight outlines are on [${gotHot}], the highlighted states are [${wantHot}]` });
  if (options.cell_mark === "line") {
    const lines = group(of("tile-map-line")), dashed = group(of("tile-map-line-provisional")), dots = group(of("tile-map-point"));
    const prov = new Set((options.provisional_values ?? []).map(String));
    const parse = (n) => String(n.attrs.points ?? "").trim().split(/\s+/).filter(Boolean).map((p) => p.split(",").map(Number));
    for (const [usps, { st, values }] of byState) {
      const series = points.map((p) => values.get(p));
      if (series.some((v) => v === undefined)) { failures.push({ rule: "tile_map_line_data", message: `${usps} has no row for every time point` }); continue; }
      const solid = lines.get(usps) ?? [];
      if (solid.length !== 1) { failures.push({ rule: "tile_map_line_missing", message: `${usps} has ${solid.length} lines, expected one` }); continue; }
      const y0 = Number(solid[0].attrs["data-y0"]), y1 = Number(solid[0].attrs["data-y1"]);
      const lo = Math.min(0, ...series), hi = Math.max(...series);
      const wantY = (v) => (hi === lo ? y1 : y1 - ((v - lo) / (hi - lo)) * (y1 - y0));
      const verts = [...parse(solid[0]), ...((dashed.get(usps) ?? []).length ? parse(dashed.get(usps)[0]).slice(1) : [])];
      if (verts.length !== points.length) { failures.push({ rule: "tile_map_line_vertices", message: `${usps} line has ${verts.length} vertices for ${points.length} time points` }); continue; }
      verts.forEach(([x, y], i) => {
        if (!(Math.abs(y - wantY(series[i])) <= 0.02)) failures.push({ rule: "tile_map_line_value", message: `${usps} ${points[i]}: the line is at y=${y}, the row puts it at ${wantY(series[i]).toFixed(2)}` });
        if (i > 0 && !(x > verts[i - 1][0])) failures.push({ rule: "tile_map_line_order", message: `${usps} line does not run left to right in time order` });
      });
      const mine = dots.get(usps) ?? [];
      const peak = series.indexOf(hi), last = points.length - 1;
      const dot = (kind, i) => mine.find((d) => d.attrs["data-kind"] === kind && d.attrs["data-x"] === points[i]);
      const peakDot = dot("peak", peak);
      if (!peakDot) failures.push({ rule: "tile_map_peak_dot", message: `${usps} has no peak dot at ${points[peak]}` });
      else if (!(Math.abs(Number(peakDot.attrs.cy) - verts[peak][1]) <= 0.02 && Math.abs(Number(peakDot.attrs.cx) - verts[peak][0]) <= 0.02 && Number(peakDot.attrs["data-value"]) === series[peak])) failures.push({ rule: "tile_map_peak_dot", message: `${usps} peak dot is not on the peak vertex` });
      if (peak !== last) {
        const lastDot = dot("last", last) ?? dot("provisional", last);
        if (!lastDot) failures.push({ rule: "tile_map_last_dot", message: `${usps} has no hollow dot at ${points[last]}` });
        else if (!(Math.abs(Number(lastDot.attrs.cy) - verts[last][1]) <= 0.02 && Number(lastDot.attrs["data-value"]) === series[last])) failures.push({ rule: "tile_map_last_dot", message: `${usps} last dot is not on the last vertex` });
      }
      points.forEach((p, i) => { if (prov.has(p) && i !== peak && i !== last && !dot("provisional", i)) failures.push({ rule: "tile_map_provisional_dot", message: `${usps} ${p} is provisional but has no hollow dot` }); });
    }
  }
  if (byState.size === 0) failures.push({ rule: "tile_map_no_states", message: "the tile map has no state to prove" });
  return { passed: failures.length === 0, failures };
}
