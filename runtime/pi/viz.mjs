import { createHash } from "node:crypto";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL, GEOMETRY_SEMANTICS, basemapAdequacy, getBasemap, MAP_PROJECTIONS, coordinateExtent, createProjection, createProjectionForExtent, geometryDisclosure, greatCirclePoints, optimizeAbstractOdRoutes, parseRouteGeometry, parseTrajectoryPoints, projectedPolylinePath, renderBasemapPaths, selectRoutes, trajectoryLines, validRouteGeometry } from "./cartography.mjs";

export const CHART_TYPES = [
  "horizontal_bar",
  "dot",
  "dumbbell",
  "slope",
  "line",
  "multi_line",
  "small_multiples",
  "scatter",
  "diverging_bar",
  "heatmap",
  "sankey",
  "alluvial",
  "node_link",
  "adjacency_matrix",
  "hierarchy_tree",
  "timeline",
  "streamgraph",
  "parallel_sets",
  "chord",
  "geo_flow_map",
  "cartographic_flow_map",
  "trajectory_profile",
  "process_schematic",
];

export const VISUAL_FAMILIES = [
  "statistical",
  "flow",
  "relationship",
  "hierarchy",
  "temporal",
  "spatial",
  "explanatory",
];

export const READER_TASKS = [
  "ranking",
  "comparison",
  "change",
  "distribution",
  "correlation",
  "part_to_whole",
  "spatial",
  "flow",
  "relationship",
  "hierarchy",
  "sequence",
  "process",
];

const PALETTE = {
  ink: "#202124",
  muted: "#687076",
  grid: "#d9dde1",
  faint: "#f2f3f4",
  accent: "#d1493f",
  accent2: "#2f6f8f",
  context: "#a9afb5",
  positive: "#3c7d5a",
  negative: "#a8443e",
  series3: "#7b6ba8",
  series4: "#b7843e",
  series5: "#4c8a83",
  series6: "#8c6c59",
};

const SERIES_COLORS = [PALETTE.accent2, PALETTE.accent, PALETTE.positive, PALETTE.series3, PALETTE.series4, PALETTE.series5, PALETTE.series6, PALETTE.context];

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function n(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(values.map((v) => String(v)))];
}

function annotations(spec) {
  return Array.isArray(spec.annotations) ? spec.annotations : [];
}

function pointAnnotations(spec, row) {
  return annotations(spec).filter((annotation) =>
    annotation?.type === "point" &&
    annotation.match_field &&
    String(row?.[annotation.match_field]) === String(annotation.match_value)
  );
}

function annotationLabel(annotation, maxChars = 58) {
  const text = String(annotation?.text ?? "").trim();
  const maxTotal = Math.max(maxChars * 3, maxChars);
  return text.length <= maxTotal ? text : text.slice(0, Math.max(1, maxTotal - 1)).trimEnd() + "…";
}

function createAnnotationLayout(bounds = {}) {
  const top = bounds.top ?? 18;
  const bottom = bounds.bottom ?? 10_000;
  const left = bounds.left ?? 18;
  const right = bounds.right ?? 10_000;
  const placed = [];
  const lineGap = bounds.line_gap ?? 16;
  return {
    place(x, y, text, preferredSide = "right", lineCount = 1) {
      const estimatedWidth = Math.max(42, Math.min(280, Math.min(String(text ?? "").length, 46) * 6.1));
      let side = preferredSide;
      if (side === "right" && x + 18 + estimatedWidth > right) side = "left";
      if (side === "left" && x - 18 - estimatedWidth < left) side = "right";
      const dx = side === "left" ? -12 : 12;
      const anchor = side === "left" ? "end" : "start";
      let ty = clamp(y - 13, top, Math.max(top, bottom - Math.max(0, lineCount - 1) * 13));
      const minY = top;
      const maxY = Math.max(minY, bottom - Math.max(0, lineCount - 1) * 13);
      const occupiedGap = Math.max(lineGap, lineCount * 13 + 4);
      for (let attempt = 0; attempt < 14; attempt++) {
        const collision = placed.find((item) => Math.abs(item.y - ty) < Math.max(occupiedGap, item.height ?? lineGap) && item.side === side);
        if (!collision) break;
        const direction = attempt % 2 === 0 ? 1 : -1;
        const distance = Math.ceil((attempt + 1) / 2) * occupiedGap;
        ty = clamp(y - 13 + direction * distance, minY, maxY);
      }
      const tx = clamp(x + dx, left, right);
      placed.push({ x: tx, y: ty, side, width: estimatedWidth, height: lineCount * 13 + 2 });
      return { side, dx, anchor, tx, ty };
    },
    placed,
  };
}

function addPointAnnotation(parts, annotation, x, y, opts = {}) {
  const maxChars = opts.maxChars ?? 46;
  const text = annotationLabel(annotation, maxChars);
  const lines = wrapText(text, maxChars).slice(0, opts.maxLines ?? 3);
  if (lines.length === (opts.maxLines ?? 3) && lines.join("").length < text.replace(/\s/g, "").length) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace(/…?$/, "…");
  }
  let side = opts.side ?? "right";
  if (!opts.layout) {
    const estimated = Math.max(...lines.map((line) => line.length), 1) * 6.1;
    if (x + 18 + estimated > (opts.right ?? 820)) side = "left";
    if (x - 18 - estimated < (opts.left ?? 180)) side = "right";
  }
  const placed = opts.layout
    ? opts.layout.place(x, y, text, side, lines.length)
    : (() => {
        const dx = side === "left" ? -12 : 12;
        return { side, dx, anchor: side === "left" ? "end" : "start", tx: x + dx, ty: Math.max(18, y - 13) };
      })();
  parts.push(`<line data-role="annotation-leader" x1="${x}" y1="${y}" x2="${x + placed.dx * 0.75}" y2="${placed.ty + 4}" stroke="${PALETTE.muted}" stroke-width="1"/>`);
  parts.push(`<text data-role="annotation" x="${placed.tx}" y="${placed.ty}" text-anchor="${placed.anchor}" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="600" fill="${PALETTE.ink}">${lines.map((line, index) => `<tspan x="${placed.tx}" dy="${index === 0 ? 0 : 13}">${esc(line)}</tspan>`).join("")}</text>`);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function separateLabelBaselines(items, top, bottom, minGap = 14) {
  const placed = items
    .map((item) => ({ ...item, labelY: clamp(item.y, top, bottom) }))
    .sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].labelY - placed[i - 1].labelY < minGap) placed[i].labelY = placed[i - 1].labelY + minGap;
  }
  if (placed.length && placed[placed.length - 1].labelY > bottom) {
    const overflow = placed[placed.length - 1].labelY - bottom;
    for (const item of placed) item.labelY -= overflow;
    for (let i = placed.length - 2; i >= 0; i--) {
      if (placed[i + 1].labelY - placed[i].labelY < minGap) placed[i].labelY = placed[i + 1].labelY - minGap;
    }
  }
  for (const item of placed) item.labelY = clamp(item.labelY, top, bottom);
  return placed;
}

function fmt(value, unit = "") {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  let text;
  if (abs >= 1_000_000_000) text = `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}bn`;
  else if (abs >= 1_000_000) text = `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  else if (abs >= 1_000) text = `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  else if (abs >= 100) text = value.toFixed(0);
  else if (abs >= 10) text = value.toFixed(1).replace(/\.0$/, "");
  else text = value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  if (unit === "%") return `${text}%`;
  if (unit && /^[£$€¥]$/.test(unit)) return `${unit}${text}`;
  return unit ? `${text} ${unit}` : text;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function hashRows(rows) {
  return createHash("sha256").update(JSON.stringify(canonicalize(rows))).digest("hex");
}

function inferVisualFamily(chartType) {
  if (["sankey", "alluvial", "parallel_sets"].includes(chartType)) return "flow";
  if (["node_link", "adjacency_matrix", "chord"].includes(chartType)) return "relationship";
  if (chartType === "hierarchy_tree") return "hierarchy";
  if (["timeline", "streamgraph", "trajectory_profile"].includes(chartType)) return "temporal";
  if (["geo_flow_map", "cartographic_flow_map"].includes(chartType)) return "spatial";
  if (chartType === "process_schematic") return "explanatory";
  return "statistical";
}

function inferDataTopology(chartType) {
  if (["sankey", "alluvial"].includes(chartType)) return "flow_edges";
  if (chartType === "parallel_sets") return "categorical_flow";
  if (["node_link", "adjacency_matrix", "chord"].includes(chartType)) return "graph_edges";
  if (chartType === "hierarchy_tree") return "hierarchy";
  if (chartType === "timeline") return "events";
  if (["geo_flow_map", "cartographic_flow_map"].includes(chartType)) return "geo_edges";
  if (chartType === "process_schematic") return "process_graph";
  return "tabular";
}

function topologyStats(rows, sourceField, targetField) {
  const nodes = unique(rows.flatMap((row) => [row[sourceField], row[targetField]]).filter((v) => v !== null && v !== undefined && String(v) !== ""));
  const edges = rows.filter((row) => String(row[sourceField] ?? "") && String(row[targetField] ?? ""));
  const selfLoops = edges.filter((row) => String(row[sourceField]) === String(row[targetField])).length;
  const density = nodes.length > 1 ? edges.length / (nodes.length * (nodes.length - 1)) : 0;
  return { nodes, edges, selfLoops, density };
}

function flowImbalances(rows, sourceField, targetField, valueField) {
  const totals = new Map();
  const ensure = (id) => { if (!totals.has(id)) totals.set(id, { in: 0, out: 0 }); return totals.get(id); };
  for (const row of rows) {
    const source = String(row[sourceField] ?? ""), target = String(row[targetField] ?? ""), value = n(row[valueField]) ?? 0;
    if (!source || !target || value < 0) continue;
    ensure(source).out += value; ensure(target).in += value;
  }
  return [...totals.entries()].flatMap(([node, t]) => {
    if (t.in <= 0 || t.out <= 0) return [];
    const base = Math.max(t.in, t.out, 1);
    return [{ node, in: t.in, out: t.out, relative: Math.abs(t.in - t.out) / base }];
  });
}

function countFlowCrossings(rows, spec) {
  const layout = flowLayout(rows, spec);
  const orderByLevel = new Map();
  layout.levels.forEach((level, li) => level.forEach((node, i) => orderByLevel.set(`${li}\0${node.id}`, i)));
  const edges = rows.map((row) => {
    const source = String(row[spec.source_field] ?? ""), target = String(row[spec.target_field] ?? "");
    const a = layout.nodes.get(source), b = layout.nodes.get(target);
    return a && b ? { sl: a.level, tl: b.level, si: orderByLevel.get(`${a.level}\0${source}`), ti: orderByLevel.get(`${b.level}\0${target}`) } : null;
  }).filter(Boolean);
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if (a.sl !== b.sl || a.tl !== b.tl || a.si === b.si || a.ti === b.ti) continue;
    if ((a.si - b.si) * (a.ti - b.ti) < 0) crossings++;
  }
  return crossings;
}

function hasDirectedCycle(rows, sourceField, targetField) {
  const adj = new Map();
  for (const row of rows) {
    const a = String(row[sourceField] ?? ""), b = String(row[targetField] ?? "");
    if (!a || !b) continue;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
    if (!adj.has(b)) adj.set(b, []);
  }
  const state = new Map();
  const visit = (node) => {
    const mark = state.get(node) ?? 0;
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(node, 1);
    for (const next of adj.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 2);
    return false;
  };
  return [...adj.keys()].some(visit);
}

function hierarchyStats(rows, nodeField, parentField) {
  const ids = rows.map((row) => String(row[nodeField] ?? "")).filter(Boolean);
  const idSet = new Set(ids);
  const duplicateIds = ids.length - idSet.size;
  const roots = rows.filter((row) => row[parentField] === null || row[parentField] === undefined || String(row[parentField]) === "");
  const missingParents = rows.filter((row) => {
    const p = row[parentField];
    return p !== null && p !== undefined && String(p) !== "" && !idSet.has(String(p));
  });
  const edges = rows.filter((row) => row[parentField] !== null && row[parentField] !== undefined && String(row[parentField]) !== "").map((row) => ({ source: row[parentField], target: row[nodeField] }));
  return { ids, duplicateIds, roots, missingParents, cycle: hasDirectedCycle(edges, "source", "target") };
}

function makeScale(values, left, right, scaleType = "linear") {
  const finite = values.filter((value) => Number.isFinite(value));
  if (scaleType === "log") {
    const positive = finite.filter((value) => value > 0);
    const domain = extent(positive.map(Math.log10), false);
    const linear = horizontalScale(domain, left, right);
    return { domain: [10 ** domain[0], 10 ** domain[1]], scale: (value) => linear(Math.log10(value)), ticks: tickValues(domain, 4).map((v) => 10 ** v) };
  }
  const domain = extent(finite, false);
  return { domain, scale: horizontalScale(domain, left, right), ticks: tickValues(domain, 4) };
}

function requiredFields(spec) {
  const common = ["title", "alt", "source_note", "unit", "claim_id", "sql", "reader_task", "chart_type"];
  const byType = {
    horizontal_bar: ["category_field", "value_field"],
    dot: ["category_field", "value_field"],
    dumbbell: ["category_field", "start_field", "end_field"],
    slope: ["category_field", "start_field", "end_field"],
    line: ["x_field", "value_field"],
    multi_line: ["x_field", "value_field", "series_field"],
    small_multiples: ["x_field", "value_field", "facet_field"],
    scatter: ["x_field", "y_field"],
    diverging_bar: ["category_field", "value_field"],
    heatmap: ["x_field", "y_field", "value_field"],
    sankey: ["source_field", "target_field", "value_field"],
    alluvial: ["source_field", "target_field", "value_field"],
    node_link: ["source_field", "target_field"],
    adjacency_matrix: ["source_field", "target_field"],
    hierarchy_tree: ["node_field", "parent_field"],
    timeline: ["x_field", "label_field"],
    streamgraph: ["x_field", "value_field", "series_field"],
    parallel_sets: ["value_field"],
    chord: ["source_field", "target_field", "value_field"],
    geo_flow_map: ["source_lat_field", "source_lon_field", "target_lat_field", "target_lon_field", "value_field"],
    cartographic_flow_map: ["value_field", "geometry_semantics", "geometry_crs", "projection", "basemap_id", "basemap_source_url", "basemap_license", "basemap_content_hash"],
    trajectory_profile: ["x_field", "altitude_field", "speed_field", "segment_field"],
    process_schematic: ["source_field", "target_field"],
  };
  return [...common, ...(byType[spec.chart_type] ?? [])];
}

export function validateVizSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") return ["Visualization spec must be an object"];
  if (!CHART_TYPES.includes(spec.chart_type)) errors.push(`Unsupported chart_type '${spec.chart_type}'`);
  if (!READER_TASKS.includes(spec.reader_task)) errors.push(`Unsupported reader_task '${spec.reader_task}'`);
  if (spec.visual_family !== undefined && !VISUAL_FAMILIES.includes(spec.visual_family)) errors.push(`Unsupported visual_family '${spec.visual_family}'`);
  if (spec.visual_family && spec.visual_family !== inferVisualFamily(spec.chart_type) && !(spec.visual_family === "temporal" && spec.chart_type === "line")) errors.push(`visual_family '${spec.visual_family}' does not match chart_type '${spec.chart_type}'`);
  if (spec.x_scale !== undefined && !["linear", "log"].includes(spec.x_scale)) errors.push("x_scale must be linear or log");
  if (spec.y_scale !== undefined && !["linear", "log"].includes(spec.y_scale)) errors.push("y_scale must be linear or log");
  if (spec.data_topology !== undefined && !["tabular", "flow_edges", "graph_edges", "hierarchy", "events", "categorical_flow", "geo_edges", "process_graph"].includes(spec.data_topology)) errors.push(`Unsupported data_topology '${spec.data_topology}'`);
  if (spec.data_topology && spec.data_topology !== inferDataTopology(spec.chart_type)) errors.push(`data_topology '${spec.data_topology}' does not match chart_type '${spec.chart_type}'`);
  if (spec.chart_type === "parallel_sets") {
    if (!Array.isArray(spec.dimension_fields) || spec.dimension_fields.length < 2 || spec.dimension_fields.length > 5) errors.push("parallel_sets requires dimension_fields with 2 to 5 field names");
    else if (spec.dimension_fields.some((field) => !String(field ?? "").trim())) errors.push("parallel_sets dimension_fields must be non-empty strings");
  }
  if (spec.chart_type === "cartographic_flow_map") {
    if (spec.flow_layer_field !== undefined && !String(spec.flow_layer_field ?? '').trim()) errors.push("flow_layer_field must be a non-empty field name when provided");
    if (spec.flow_unit_field !== undefined && !String(spec.flow_unit_field ?? '').trim()) errors.push("flow_unit_field must be a non-empty field name when provided");
    if (spec.flow_period_field !== undefined && !String(spec.flow_period_field ?? '').trim()) errors.push("flow_period_field must be a non-empty field name when provided");
    if (spec.flow_id_field !== undefined && !String(spec.flow_id_field ?? '').trim()) errors.push("flow_id_field must be a non-empty field name when provided");
    if (spec.flow_layer_field && !spec.flow_unit_field) errors.push("flow_unit_field is required when flow_layer_field is provided so layer scales cannot be confused");
    if (spec.flow_layer_order !== undefined && (!Array.isArray(spec.flow_layer_order) || spec.flow_layer_order.length < 1 || spec.flow_layer_order.length > 6 || spec.flow_layer_order.some((item) => !String(item ?? '').trim()))) errors.push("flow_layer_order must contain 1 to 6 non-empty layer names");
    if (!GEOMETRY_SEMANTICS.includes(spec.geometry_semantics)) errors.push(`geometry_semantics must be one of ${GEOMETRY_SEMANTICS.join(", ")}`);
    if (spec.geometry_crs !== 'EPSG:4326') errors.push("geometry_crs must be 'EPSG:4326' in cartography 0.1");
    if (!MAP_PROJECTIONS.includes(spec.projection)) errors.push(`projection must be one of ${MAP_PROJECTIONS.join(", ")}`);
    const basemap = getBasemap(spec.basemap_id);
    if (!basemap) errors.push(`Unknown basemap_id '${spec.basemap_id}'`);
    else {
      if (spec.basemap_source_url !== basemap.source_url) errors.push('basemap_source_url does not match the registered basemap provenance');
      if (spec.basemap_license !== basemap.license) errors.push('basemap_license does not match the registered basemap provenance');
      if (spec.basemap_content_hash !== basemap.content_hash) errors.push('basemap_content_hash does not match the registered basemap geometry');
    }
    if (["abstract_od","great_circle_reference"].includes(spec.geometry_semantics)) {
      for (const field of ["source_lat_field","source_lon_field","target_lat_field","target_lon_field"]) if (!String(spec[field] ?? '').trim()) errors.push(`${field} is required for ${spec.geometry_semantics}`);
    } else {
      if (!String(spec.route_provenance_note ?? '').trim()) errors.push(`route_provenance_note is required for ${spec.geometry_semantics}`);
      if (spec.geometry_semantics === 'observed_trajectory' && String(spec.trajectory_points_field ?? '').trim()) {
        if (spec.route_geometry_field !== undefined && String(spec.route_geometry_field).trim()) errors.push('observed_trajectory must use either trajectory_points_field or route_geometry_field, not both');
      } else {
        if (!String(spec.route_geometry_field ?? '').trim()) errors.push(`route_geometry_field is required for ${spec.geometry_semantics}`);
        if (spec.geometry_semantics === 'observed_trajectory' && !String(spec.time_field ?? '').trim()) errors.push('time_field is required for legacy observed_trajectory route geometry');
      }
    }
    if (spec.extent_mode !== undefined && !["world","data"].includes(spec.extent_mode)) errors.push('extent_mode must be world or data');
    if (spec.map_task !== undefined && !['global_context','regional_route','local_context','local_port','airport_detail','infrastructure_detail'].includes(spec.map_task)) errors.push('unsupported map_task');
    if (spec.extent_min_span_deg !== undefined && (!(Number(spec.extent_min_span_deg) >= 0) || Number(spec.extent_min_span_deg) > 60)) errors.push('extent_min_span_deg must be between 0 and 60');
    if (spec.reference_path !== undefined && !["none","great_circle"].includes(spec.reference_path)) errors.push('reference_path must be none or great_circle');
    if (spec.reference_path === 'great_circle' && spec.geometry_semantics !== 'observed_trajectory') errors.push('reference_path=great_circle is currently supported only for observed_trajectory');
    if (spec.aggregation_policy !== undefined && !["none","top_n"].includes(spec.aggregation_policy)) errors.push('aggregation_policy must be none or top_n');
    if (spec.aggregation_policy === 'top_n' && (!(Number(spec.top_n) >= 1) || Number(spec.top_n) > 80)) errors.push('top_n must be between 1 and 80 when aggregation_policy=top_n');
  }
  for (const field of requiredFields(spec)) {
    if (spec[field] === undefined || spec[field] === null || String(spec[field]).trim() === "") errors.push(`Missing required field '${field}'`);
  }
  if (spec.annotations !== undefined && !Array.isArray(spec.annotations)) errors.push("annotations must be an array");
  if (Array.isArray(spec.annotations)) {
    if (spec.annotations.length > 8) errors.push("annotations may contain at most 8 items");
    spec.annotations.forEach((annotation, index) => {
      if (!annotation || typeof annotation !== "object") { errors.push(`annotations[${index}] must be an object`); return; }
      if (!["point", "node"].includes(annotation.type)) errors.push(`annotations[${index}].type is unsupported`);
      if (!String(annotation.text ?? "").trim()) errors.push(`annotations[${index}].text is required`);
      if (!String(annotation.claim_id ?? "").trim()) errors.push(`annotations[${index}].claim_id is required`);
      if (["point", "node"].includes(annotation.type) && (!String(annotation.match_field ?? "").trim() || annotation.match_value === undefined)) errors.push(`annotations[${index}] ${annotation.type} annotations require match_field and match_value`);
    });
  }
  return errors;
}

function fieldExists(rows, field) {
  return rows.length > 0 && rows.some((row) => Object.prototype.hasOwnProperty.call(row, field));
}

function numericCount(rows, field) {
  return rows.reduce((count, row) => count + (n(row[field]) === null ? 0 : 1), 0);
}

function cartographicDataExtent(spec,rows){
  const lines=[];for(const row of selectRoutes(rows,spec)){
    if(spec.geometry_semantics==='observed_trajectory'&&spec.trajectory_points_field){const pts=parseTrajectoryPoints(row[spec.trajectory_points_field]),ls=trajectoryLines(pts);if(ls)lines.push(...ls);}
    else if(['abstract_od','great_circle_reference'].includes(spec.geometry_semantics)){const vals=[n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),n(row[spec.target_lon_field]),n(row[spec.target_lat_field])];if(vals.every(v=>v!==null))lines.push([[vals[0],vals[1]],[vals[2],vals[3]]]);}
    else {const ls=parseRouteGeometry(row[spec.route_geometry_field]);if(ls)lines.push(...ls);}
  }return coordinateExtent(lines);
}

export function lintVizSpec(spec, rows, context = {}) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  blockers.push(...validateVizSpec(spec));
  if (spec.semantic_gate?.status === "BLOCK") blockers.push("semantic_comparison_blocked");
  if (spec.semantic_gate?.status === "CONTEXTUAL") notes.push("Semantic comparison is contextual; visual roles must remain explicitly differentiated");
  if (!Array.isArray(rows) || rows.length === 0) blockers.push("Visualization query returned no rows");
  if (rows.length > 240) blockers.push(`Visualization query returned ${rows.length} rows; maximum is 240`);

  const requiredDataFields = [
    spec.category_field,
    spec.x_field,
    spec.y_field,
    spec.value_field,
    spec.start_field,
    spec.end_field,
    spec.series_field,
    spec.facet_field,
    spec.reference_period_field,
    spec.source_field,
    spec.target_field,
    spec.node_field,
    spec.parent_field,
    spec.source_lat_field,
    spec.source_lon_field,
    spec.target_lat_field,
    spec.target_lon_field,
    spec.route_geometry_field,
    spec.trajectory_points_field,
    spec.route_provenance_field,
    spec.time_field,
    spec.altitude_field,
    spec.speed_field,
    spec.segment_field,
    ...(Array.isArray(spec.dimension_fields) ? spec.dimension_fields : []),
  ].filter(Boolean);
  for (const field of unique(requiredDataFields)) {
    if (!fieldExists(rows, field)) blockers.push(`Field '${field}' is absent from query output`);
  }

  for (const field of [spec.value_field, spec.start_field, spec.end_field, spec.source_lat_field, spec.source_lon_field, spec.target_lat_field, spec.target_lon_field].filter(Boolean)) {
    if (fieldExists(rows, field) && numericCount(rows, field) !== rows.length) {
      blockers.push(`Field '${field}' contains non-numeric or missing values`);
    }
  }
  if (spec.chart_type === "trajectory_profile") {
    if (fieldExists(rows,spec.x_field) && numericCount(rows,spec.x_field)!==rows.length) blockers.push(`trajectory_profile x_field '${spec.x_field}' must be numeric`);
    if (fieldExists(rows,spec.altitude_field) && numericCount(rows,spec.altitude_field)<Math.max(2,Math.ceil(rows.length*.8))) blockers.push(`trajectory_profile altitude_field '${spec.altitude_field}' has insufficient numeric coverage`);
    if (fieldExists(rows,spec.speed_field) && numericCount(rows,spec.speed_field)<Math.max(2,Math.ceil(rows.length*.6))) blockers.push(`trajectory_profile speed_field '${spec.speed_field}' has insufficient numeric coverage`);
  }
  if (spec.chart_type === "scatter") {
    if (fieldExists(rows, spec.x_field) && numericCount(rows, spec.x_field) !== rows.length) blockers.push(`Scatter x_field '${spec.x_field}' must be numeric`);
    if (fieldExists(rows, spec.y_field) && numericCount(rows, spec.y_field) !== rows.length) blockers.push(`Scatter y_field '${spec.y_field}' must be numeric`);
  }
  if (spec.x_scale === "log" && spec.x_field && rows.some((row) => (n(row[spec.x_field]) ?? 0) <= 0)) blockers.push(`Log x_scale requires positive values in '${spec.x_field}'`);
  if (spec.y_scale === "log" && spec.y_field && rows.some((row) => (n(row[spec.y_field]) ?? 0) <= 0)) blockers.push(`Log y_scale requires positive values in '${spec.y_field}'`);

  const verifiedClaimIds = new Set(context.verified_claim_ids ?? []);
  if (spec.claim_id && !verifiedClaimIds.has(spec.claim_id)) {
    blockers.push(`claim_id '${spec.claim_id}' is not a verified recorded claim`);
  }
  for (const [index, annotation] of annotations(spec).entries()) {
    if (annotation.claim_id && !verifiedClaimIds.has(annotation.claim_id)) blockers.push(`annotations[${index}].claim_id '${annotation.claim_id}' is not a verified recorded claim`);
    if (["point", "node"].includes(annotation.type) && annotation.match_field) {
      if (!fieldExists(rows, annotation.match_field)) blockers.push(`annotations[${index}] match_field '${annotation.match_field}' is absent from query output`);
      else if (!rows.some((row) => String(row[annotation.match_field]) === String(annotation.match_value))) blockers.push(`annotations[${index}] target '${annotation.match_value}' was not found in '${annotation.match_field}'`);
    }
  }
  if (annotations(spec).length > 4) warnings.push(`Visualization has ${annotations(spec).length} annotations; editorial hierarchy may become crowded`);
  if ((spec.highlight_values ?? []).length > 4) warnings.push(`Visualization highlights ${(spec.highlight_values ?? []).length} values; consider one primary focus and contextual series`);

  if (!spec.alt || String(spec.alt).trim().length < 20) blockers.push("Alt description must be at least 20 characters");
  if (!spec.source_note || String(spec.source_note).trim().length < 3) blockers.push("Source attribution is required");
  if (!spec.unit || String(spec.unit).trim().length < 1) blockers.push("A quantitative unit is required");

  if (spec.reference_period_field && fieldExists(rows, spec.reference_period_field)) {
    const periods = unique(rows.map((row) => row[spec.reference_period_field]).filter((v) => v !== null && v !== undefined));
    if (periods.length > 1) {
      const strategy = spec.mixed_period_strategy ?? "reject";
      const separatedByFacet = spec.facet_field === spec.reference_period_field && spec.chart_type === "small_multiples";
      if (strategy === "reject" && !separatedByFacet) {
        blockers.push(`Mixed reference periods detected (${periods.join(", ")}); separate them or explicitly justify the comparison`);
      } else if (strategy === "facet" && !separatedByFacet) {
        blockers.push("mixed_period_strategy='facet' requires small_multiples with facet_field equal to reference_period_field");
      } else {
        notes.push(`Reference periods explicitly handled: ${periods.join(", ")}`);
      }
    }
  }

  if (spec.chart_type === "small_multiples") {
    if (!spec.panel_mark || !["line", "dot"].includes(spec.panel_mark)) {
      blockers.push("small_multiples requires panel_mark='line' or panel_mark='dot'");
    }
  }

  const taskFit = {
    ranking: new Set(["horizontal_bar", "dot", "diverging_bar"]),
    comparison: new Set(["horizontal_bar", "dot", "dumbbell", "slope", "diverging_bar", "small_multiples", "adjacency_matrix"]),
    change: new Set(["line", "multi_line", "slope", "small_multiples", "streamgraph"]),
    distribution: new Set(["dot", "scatter", "heatmap"]),
    correlation: new Set(["scatter"]),
    part_to_whole: new Set(["sankey", "alluvial", "parallel_sets", "chord"]),
    spatial: new Set(["geo_flow_map", "cartographic_flow_map"]),
    flow: new Set(["sankey", "alluvial", "parallel_sets", "geo_flow_map", "cartographic_flow_map"]),
    relationship: new Set(["node_link", "adjacency_matrix", "chord"]),
    hierarchy: new Set(["hierarchy_tree"]),
    sequence: new Set(["timeline"]),
    process: new Set(["sankey", "alluvial", "hierarchy_tree", "timeline", "process_schematic"]),
  };
  if (taskFit[spec.reader_task] && !taskFit[spec.reader_task].has(spec.chart_type)) {
    warnings.push(`Chart type '${spec.chart_type}' is an unusual fit for reader task '${spec.reader_task}'`);
  }

  if (["sankey", "alluvial", "node_link", "adjacency_matrix", "chord"].includes(spec.chart_type)) {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.selfLoops) blockers.push(`${spec.chart_type} contains ${topo.selfLoops} self-loop edge(s)`);
    if (["sankey", "alluvial"].includes(spec.chart_type)) {
      if (topo.nodes.length > 36) blockers.push(`${spec.chart_type} has ${topo.nodes.length} nodes; maximum is 36 for an editorial frame`);
      if (topo.edges.length > 96) blockers.push(`${spec.chart_type} has ${topo.edges.length} links; maximum is 96`);
      if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push(`${spec.chart_type} does not allow negative flows`);
      const cyclicFlow = hasDirectedCycle(rows, spec.source_field, spec.target_field);
      if (cyclicFlow) blockers.push(`${spec.chart_type} requires an acyclic flow graph; cycles must be resolved or represented with another form`);
      const conservationMode = spec.flow_conservation ?? "warn";
      const tolerance = Number.isFinite(Number(spec.flow_tolerance)) ? Math.max(0, Number(spec.flow_tolerance)) : 0.02;
      const imbalances = flowImbalances(rows, spec.source_field, spec.target_field, spec.value_field).filter((item) => item.relative > tolerance);
      if (imbalances.length) {
        const summary = imbalances.slice(0, 4).map((item) => `${item.node} (${fmt(item.in, spec.unit)} in vs ${fmt(item.out, spec.unit)} out)`).join("; ");
        if (conservationMode === "strict") blockers.push(`Flow conservation failed beyond ${(tolerance * 100).toFixed(1)}% tolerance: ${summary}`);
        else if (conservationMode === "warn") warnings.push(`Flow conservation differs at intermediate node(s): ${summary}`);
      }
      if (!cyclicFlow) {
        const crossings = countFlowCrossings(rows, spec);
        if (crossings > 30) warnings.push(`${spec.chart_type} layout has an estimated ${crossings} link crossings; aggregate, reorder, or consider a matrix/parallel-set alternative`);
        else if (crossings > 10) notes.push(`${spec.chart_type} layout has an estimated ${crossings} link crossings`);
      }
      if (topo.edges.length > 42) warnings.push(`${spec.chart_type} has ${topo.edges.length} links; consider aggregation or an "Other" category`);
    }
    if (spec.chart_type === "node_link") {
      if (topo.nodes.length > 70) blockers.push(`node_link has ${topo.nodes.length} nodes; switch to adjacency_matrix or filter the graph`);
      if (topo.edges.length > 180) blockers.push(`node_link has ${topo.edges.length} edges; switch to adjacency_matrix or filter the graph`);
      if (topo.nodes.length > 20 && topo.density > 0.12) warnings.push(`Dense graph (${topo.nodes.length} nodes, density ${topo.density.toFixed(3)}) is likely more legible as adjacency_matrix`);
    }
    if (spec.chart_type === "adjacency_matrix") {
      if (topo.nodes.length > 80) blockers.push(`adjacency_matrix has ${topo.nodes.length} nodes; maximum is 80`);
      if (spec.value_field && numericCount(rows, spec.value_field) !== rows.length) blockers.push(`adjacency_matrix value_field '${spec.value_field}' must be numeric`);
    }
    if (spec.chart_type === "chord") {
      if (topo.nodes.length > 24) blockers.push(`chord has ${topo.nodes.length} nodes; maximum is 24 for readable labels`);
      if (topo.edges.length > 90) blockers.push(`chord has ${topo.edges.length} relationships; maximum is 90`);
      if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push("chord does not allow negative relationship weights");
      if (topo.nodes.length > 12 || topo.edges.length > 36) warnings.push(`chord is visually dense (${topo.nodes.length} nodes, ${topo.edges.length} links); consider adjacency_matrix for precise comparison`);
    }
  }
  if (spec.chart_type === "parallel_sets") {
    const dims = spec.dimension_fields ?? [];
    const totalCategories = dims.reduce((sum, field) => sum + unique(rows.map((row) => row[field])).length, 0);
    const maxCardinality = Math.max(...dims.map((field) => unique(rows.map((row) => row[field])).length), 0);
    if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push("parallel_sets does not allow negative weights");
    if (totalCategories > 42) blockers.push(`parallel_sets has ${totalCategories} category nodes across axes; maximum is 42`);
    if (maxCardinality > 14) blockers.push(`parallel_sets has an axis with ${maxCardinality} categories; maximum is 14`);
    if (rows.length > 160) blockers.push(`parallel_sets has ${rows.length} paths; aggregate identical categorical paths before rendering`);
    if (totalCategories > 28 || rows.length > 80) warnings.push("parallel_sets is dense; aggregate rare categories into a defensible Other group or split the story");
  }
  if (spec.chart_type === "geo_flow_map") {
    const coordinateFields = [spec.source_lat_field, spec.source_lon_field, spec.target_lat_field, spec.target_lon_field];
    if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push("geo_flow_map does not allow negative flow weights");
    for (const row of rows) {
      const slat=n(row[spec.source_lat_field]), slon=n(row[spec.source_lon_field]), tlat=n(row[spec.target_lat_field]), tlon=n(row[spec.target_lon_field]);
      if (slat !== null && (slat < -90 || slat > 90)) blockers.push(`geo_flow_map source latitude out of range: ${slat}`);
      if (tlat !== null && (tlat < -90 || tlat > 90)) blockers.push(`geo_flow_map target latitude out of range: ${tlat}`);
      if (slon !== null && (slon < -180 || slon > 180)) blockers.push(`geo_flow_map source longitude out of range: ${slon}`);
      if (tlon !== null && (tlon < -180 || tlon > 180)) blockers.push(`geo_flow_map target longitude out of range: ${tlon}`);
    }
    if (rows.length > 70) blockers.push(`geo_flow_map has ${rows.length} routes; maximum is 70 in one editorial frame`);
    if (rows.length > 30) warnings.push(`geo_flow_map has ${rows.length} routes; route overlap may obscure directional structure`);
    notes.push("geo_flow_map uses a schematic equirectangular coordinate frame without administrative boundary geometry; do not imply boundary precision");
  }
  if (spec.chart_type === "cartographic_flow_map") {
    if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push('cartographic_flow_map does not allow negative flow weights');
    const selected = selectRoutes(rows, spec);
    if (spec.flow_layer_field) {
      const layerValues = selected.map((row) => String(row[spec.flow_layer_field] ?? '').trim()).filter(Boolean);
      const layerSet = [...new Set(layerValues)];
      if (layerValues.length !== selected.length) blockers.push(`cartographic_flow_map flow_layer_field '${spec.flow_layer_field}' contains missing values`);
      if (layerSet.length > 6) blockers.push(`cartographic_flow_map has ${layerSet.length} flow layers; maximum is 6 in one composite`);
      if (Array.isArray(spec.flow_layer_order)) {
        const unknown = layerSet.filter((layer) => !spec.flow_layer_order.map(String).includes(layer));
        if (unknown.length) blockers.push(`flow_layer_order is missing layer(s): ${unknown.join(', ')}`);
      }
      const unitsByLayer = new Map();
      for (const row of selected) {
        const layer = String(row[spec.flow_layer_field] ?? '').trim();
        const unit = String(row[spec.flow_unit_field] ?? '').trim();
        if (!unit) blockers.push(`cartographic_flow_map layer '${layer || 'unknown'}' has no unit in '${spec.flow_unit_field}'`);
        else { if (!unitsByLayer.has(layer)) unitsByLayer.set(layer, new Set()); unitsByLayer.get(layer).add(unit); }
      }
      for (const [layer, units] of unitsByLayer) if (units.size > 1) blockers.push(`cartographic_flow_map layer '${layer}' mixes units; each layer needs one independent width scale`);
      if (spec.flow_period_field) {
        const periodsByLayer = new Map();
        for (const row of selected) {
          const layer = String(row[spec.flow_layer_field] ?? '').trim(), period = String(row[spec.flow_period_field] ?? '').trim();
          if (!period) blockers.push(`cartographic_flow_map layer '${layer || 'unknown'}' has no period in '${spec.flow_period_field}'`);
          else { if (!periodsByLayer.has(layer)) periodsByLayer.set(layer, new Set()); periodsByLayer.get(layer).add(period); }
        }
        for (const [layer, periods] of periodsByLayer) if (periods.size > 1) blockers.push(`cartographic_flow_map layer '${layer}' mixes reference periods; facet or separate the observations`);
      }
      notes.push(`layered cartographic flow: ${layerSet.length} independent layers; width scales reset within each layer and must not be compared across units`);
    }
    if (spec.aggregation_policy !== 'top_n' && rows.length > 80) blockers.push(`cartographic_flow_map has ${rows.length} routes; set aggregation_policy=top_n or split the story`);
    if (selected.length > 45) warnings.push(`cartographic_flow_map renders ${selected.length} routes; route density may exceed a static editorial frame`);
    if (["abstract_od","great_circle_reference"].includes(spec.geometry_semantics)) {
      for (const row of selected) {
        const coords=[n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),n(row[spec.target_lon_field]),n(row[spec.target_lat_field])];
        if (coords.some(v=>v===null)) blockers.push(`cartographic_flow_map ${spec.geometry_semantics} requires numeric source/target coordinates`);
        else if (coords[0] < -180 || coords[0] > 180 || coords[2] < -180 || coords[2] > 180 || coords[1] < -90 || coords[1] > 90 || coords[3] < -90 || coords[3] > 90) blockers.push('cartographic_flow_map coordinate is outside valid WGS84 longitude/latitude bounds');
      }
    } else {
      for (const row of selected) {
        if(spec.geometry_semantics==='observed_trajectory' && spec.trajectory_points_field){
          const points=parseTrajectoryPoints(row[spec.trajectory_points_field]);
          if(!points) blockers.push(`cartographic_flow_map row has invalid ${spec.trajectory_points_field} trajectory samples`);
          else {
            const lines=trajectoryLines(points); if(!validRouteGeometry(lines)) blockers.push('observed_trajectory trajectory samples do not form at least one valid line segment');
            if(points.length<4) warnings.push('observed_trajectory has fewer than four trajectory samples; route shape may be under-resolved');
          }
        } else {
          const lines=parseRouteGeometry(row[spec.route_geometry_field]);
          if (!validRouteGeometry(lines)) blockers.push(`cartographic_flow_map row has invalid ${spec.route_geometry_field} geometry for ${spec.geometry_semantics}`);
        }
      }
    }
    if (spec.geometry_semantics === 'abstract_od') notes.push('abstract_od route curves encode relationships only and must not be described as physical routes');
    if (spec.geometry_semantics === 'great_circle_reference') notes.push('great_circle_reference is a geodesic baseline, not a filed or observed route');
    const selectedBasemap = getBasemap(spec.basemap_id);
    notes.push(`cartographic basemap=${spec.basemap_id ?? BASEMAP_ID}; crs=${spec.geometry_crs}; projection=${spec.projection}; geometry_semantics=${spec.geometry_semantics}`);
    if(spec.extent_mode==='data'){const ex=cartographicDataExtent(spec,selected);if(ex){const span=Math.max(ex.east-ex.west,ex.north-ex.south);if(span<1)warnings.push(`cartographic extent spans only ${span.toFixed(3)} degrees; ${selectedBasemap?.label ?? spec.basemap_id} is too coarse for harbour/street-scale geographic context`);}}
  }
  if (spec.chart_type === "process_schematic") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.selfLoops) blockers.push(`process_schematic contains ${topo.selfLoops} self-loop edge(s)`);
    if (hasDirectedCycle(rows, spec.source_field, spec.target_field)) blockers.push("process_schematic requires an acyclic process graph");
    if (topo.nodes.length > 32) blockers.push(`process_schematic has ${topo.nodes.length} nodes; maximum is 32`);
    if (topo.edges.length > 48) blockers.push(`process_schematic has ${topo.edges.length} transitions; maximum is 48`);
    if (topo.nodes.length > 18) warnings.push("process_schematic is dense; split the mechanism into stages or separate panels");
  }
  if (spec.chart_type === "hierarchy_tree") {
    const h = hierarchyStats(rows, spec.node_field, spec.parent_field);
    if (h.duplicateIds) blockers.push(`hierarchy_tree has ${h.duplicateIds} duplicate node id(s)`);
    if (h.roots.length !== 1) blockers.push(`hierarchy_tree requires exactly one root; found ${h.roots.length}`);
    if (h.missingParents.length) blockers.push(`hierarchy_tree has ${h.missingParents.length} node(s) whose parent is absent`);
    if (h.cycle) blockers.push("hierarchy_tree contains a cycle");
    if (h.ids.length > 80) blockers.push(`hierarchy_tree has ${h.ids.length} nodes; maximum is 80`);
  }
  if (spec.chart_type === "timeline") {
    if (rows.length > 60) blockers.push("timeline has more than 60 events; aggregate or split the story");
    if (rows.some((row) => row[spec.x_field] === null || row[spec.x_field] === undefined || String(row[spec.x_field]) === "")) blockers.push(`timeline x_field '${spec.x_field}' contains missing values`);
  }
  if (spec.chart_type === "streamgraph") {
    if (rows.some((row) => (n(row[spec.value_field]) ?? 0) < 0)) blockers.push("streamgraph does not support negative values; use a diverging or baseline-aware form");
    const series = unique(rows.map((row) => row[spec.series_field]));
    if (series.length > 12) blockers.push(`streamgraph has ${series.length} series; maximum is 12`);
    if (series.length > 8) warnings.push(`streamgraph has ${series.length} series; direct interpretation may be difficult`);
  }
  if (spec.chart_type === "multi_line" && spec.series_field && fieldExists(rows, spec.series_field)) {
    const series = unique(rows.map((row) => row[spec.series_field]));
    if (series.length > 12) blockers.push(`multi_line has ${series.length} series; use small multiples or filter context`);
    else if (series.length > 6) warnings.push(`multi_line has ${series.length} series; small multiples may be more legible`);
  }
  if (["horizontal_bar", "dot", "dumbbell", "slope", "diverging_bar"].includes(spec.chart_type) && rows.length > 30) {
    warnings.push(`${spec.chart_type} has ${rows.length} rows; consider filtering to a defensible top/bottom set or small multiples`);
  }
  if (spec.chart_type === "heatmap") {
    const xs = unique(rows.map((r) => r[spec.x_field]));
    const ys = unique(rows.map((r) => r[spec.y_field]));
    if (xs.length * ys.length > 400) blockers.push("Heatmap exceeds 400 cells");
  }

  if (spec.title && /\b(latest|current|today|now)\b/i.test(spec.title) && spec.reference_period_field) {
    warnings.push("Title uses currentness language; verify the observation period is actually current");
  }

  return {
    schema_version: spec.schema_version === "1.0.0" ? "1.0.0" : "0.9.0",
    passed: blockers.length === 0,
    blockers,
    warnings,
    notes,
    data_hash: hashRows(rows),
    row_count: rows.length,
  };
}

export function critiqueViz(spec, rows, lint = {}, svg = "") {
  const issues = [];
  const suggestions = [];
  let score = 100;
  const add = (severity, code, message, penalty, suggestion) => {
    issues.push({ severity, code, message });
    score -= penalty;
    if (suggestion) suggestions.push(suggestion);
  };

  if (lint.passed === false || (lint.blockers ?? []).length) add("blocker", "lint_not_passed", "Deterministic visualization lint has blocking failures.", 100, "Resolve every deterministic lint blocker before editorial review.");
  if (String(spec.title ?? "").length > 95) add("warning", "title_too_long", "Title is longer than 95 characters and may wrap heavily on mobile.", 8, "Shorten the title to one evidence-backed takeaway.");
  if (String(spec.subtitle ?? "").length > 180) add("warning", "subtitle_too_long", "Subtitle is too dense for a chart dek.", 5, "Move methodology details to the note and keep the subtitle focused on denominator and period.");
  if ((spec.highlight_values ?? []).length === 0 && ["multi_line", "scatter", "slope"].includes(spec.chart_type)) add("info", "no_visual_focus", "The chart has no explicit highlighted subject.", 6, "Highlight the series or entity that carries the governing claim when editorially justified.");
  if ((spec.highlight_values ?? []).length > 4) add("warning", "too_many_highlights", "Too many marks compete for attention.", 10, "Reduce highlights to one primary focus and a small number of comparisons.");
  if (annotations(spec).length === 0 && rows.length >= 8) add("info", "no_annotation", "The visual has enough data density that a local annotation could reduce reader search cost.", 4, "Add one verified annotation to the most decision-relevant point if it improves comprehension.");
  if (annotations(spec).length > 4) add("warning", "annotation_density", "More than four annotations are likely to compete with the data.", 9, "Keep only annotations that identify, compare, summarize, or explain the governing claim.");
  if (spec.chart_type === "multi_line") {
    const count = spec.series_field ? unique(rows.map((r) => r[spec.series_field])).length : 1;
    if (count > 6) add("warning", "series_density", `${count} line series are difficult to scan even when lint permits them.`, 10, "Use small multiples or filter to defensible context series.");
    if (spec.direct_labels === false) add("info", "legend_dependency", "Direct labels are disabled for a multi-line chart.", 5, "Prefer end labels over a detached legend when space allows.");
  }
  if (spec.chart_type === "small_multiples") {
    const facets = spec.facet_field ? unique(rows.map((r) => r[spec.facet_field])).length : 0;
    if (facets > 8) add("warning", "facet_density", `${facets} facets may be too dense for one editorial frame.`, 8, "Filter or paginate facets, or group them into a defensible hierarchy.");
  }
  if (["sankey", "alluvial"].includes(spec.chart_type)) {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.edges.length > 35) add("warning", "flow_density", `${topo.edges.length} flow links create a high visual-search burden.`, 8, "Aggregate minor flows or expose a drill-down rather than showing every link.");
  }
  if (spec.chart_type === "node_link") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.nodes.length > 20 && topo.density > 0.1) add("warning", "network_density", "The node-link graph is dense enough that paths and labels may overlap.", 12, "Prefer adjacency_matrix for dense comparison tasks or filter to an ego network.");
  }
  if (spec.chart_type === "parallel_sets") {
    const axes = spec.dimension_fields ?? [];
    if (axes.length > 4) add("warning", "parallel_sets_axes", `${axes.length} categorical axes increase path tracing cost.`, 6, "Use four or fewer axes in the main frame and move extra dimensions to a follow-up view.");
  }
  if (spec.chart_type === "chord") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.nodes.length > 12 || topo.edges.length > 36) add("warning", "chord_density", "The chord diagram is dense enough that ribbon comparison becomes difficult.", 10, "Use adjacency_matrix when exact pairwise comparison matters more than cyclical structure.");
  }
  if (spec.chart_type === "geo_flow_map" && rows.length > 24) add("warning", "route_density", `${rows.length} routes compete on the same geographic frame.`, 8, "Aggregate minor routes or filter to the flows that carry the governing claim.");
  if (spec.chart_type === "cartographic_flow_map") {
    const selected=selectRoutes(rows,spec);
    if (selected.length > 35) add("warning","cartographic_route_density",`${selected.length} routes compete on the same cartographic frame.`,8,"Aggregate to top routes, facet by category, or separate overview from detail.");
    if (spec.geometry_semantics === "abstract_od" && !/(physical|tanker|pipeline|relationship|not\s+(?:actual\s+)?(?:ship\s+)?routes?)/i.test(String(spec.note ?? ""))) add("warning","od_route_disclosure","Abstract OD arcs require an explicit note that they are not physical routes.",8,"State that arcs encode relationships and do not trace physical movement.");
    if (["verified_route","observed_trajectory","network_constrained"].includes(spec.geometry_semantics) && !String(spec.route_provenance_note ?? "").trim()) add("blocker","route_provenance_missing","Physical or observed route geometry has no route provenance note.",100,"Bind route geometry to an explicit source and measurement description.");
    if(spec.extent_mode==="data"){const ex=cartographicDataExtent(spec,selected);if(ex){const adequacy=basemapAdequacy(spec.basemap_id,ex,spec.map_task??null);if(!adequacy.adequate)add("warning","basemap_detail_mismatch",`Basemap ${spec.basemap_id} is not qualified for ${adequacy.task}-scale interpretation (${adequacy.reason}).`,14,"Use a provenance-bound basemap whose registered detail class and extent cover this geographic task.");}}
  }
  if (spec.chart_type === "process_schematic") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.nodes.length > 16) add("warning", "process_density", `${topo.nodes.length} process nodes create a high explanatory burden.`, 8, "Split the mechanism into stages or use progressive panels.");
  }
  if (spec.chart_type === "scatter" && spec.x_scale === "linear") {
    const xs = rows.map((r) => n(r[spec.x_field])).filter((v) => v !== null && v > 0);
    if (xs.length >= 6 && Math.max(...xs) / Math.min(...xs) > 30) add("warning", "heavy_tail_linear_axis", "The x variable spans more than 30x on a linear scale.", 9, "Consider x_scale='log' if ratios are meaningful for the reader task.");
  }
  if (svg && !/role="img"/.test(svg)) add("blocker", "svg_accessibility", "Rendered SVG is missing role=img.", 100, "Render accessible SVG markup.");
  if (svg && !/<desc\b/.test(svg)) add("blocker", "svg_description", "Rendered SVG is missing an accessible description.", 100, "Include a <desc> based on the verified alt text.");
  if (svg && !/Source:/.test(svg)) add("blocker", "source_missing", "Rendered SVG does not visibly include a source note.", 100, "Render the source attribution in the visual footer.");

  score = Math.max(0, Math.min(100, score));
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  return {
    schema_version: spec.schema_version === "1.0.0" ? "1.0.0" : "0.9.0",
    passed: blockers.length === 0 && score >= 75,
    score,
    issues,
    suggestions: [...new Set(suggestions)],
  };
}

function isCjkChar(char) {
  return /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/u.test(char);
}

function textTokens(text) {
  const tokens = [];
  let latin = "";
  let pendingSpace = false;
  const flush = () => {
    if (latin) { tokens.push({ text: latin, spaceBefore: pendingSpace }); latin = ""; pendingSpace = false; }
  };
  for (const char of Array.from(String(text ?? ""))) {
    if (/\s/u.test(char)) { flush(); pendingSpace = true; continue; }
    if (isCjkChar(char)) {
      flush();
      tokens.push({ text: char, spaceBefore: false });
      pendingSpace = false;
      continue;
    }
    latin += char;
  }
  flush();
  return tokens;
}

export function wrapText(text, maxChars) {
  const tokens = textTokens(text);
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const separator = token.spaceBefore && line ? " " : "";
    let candidate = line + separator + token.text;
    if (candidate.length <= maxChars) { line = candidate; continue; }
    if (line) { lines.push(line); line = ""; }
    const units = Array.from(token.text);
    while (units.length > maxChars) lines.push(units.splice(0, maxChars).join(""));
    line = units.join("");
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function svgTextLines(parts, text, x, y, opts = {}) {
  const lines = wrapText(text, opts.maxChars ?? 90);
  const size = opts.size ?? 14;
  const lineHeight = opts.lineHeight ?? Math.round(size * 1.35);
  const fill = opts.fill ?? PALETTE.ink;
  const weight = opts.weight ?? 400;
  const anchor = opts.anchor ?? "start";
  lines.forEach((line, index) => {
    parts.push(`<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(line)}</text>`);
  });
  return lines.length * lineHeight;
}

function frame(spec, bodyHeight) {
  const width = 1040;
  const titleLines = wrapText(spec.title, 62).length;
  const dekLines = spec.subtitle ? wrapText(spec.subtitle, 105).length : 0;
  const header = 32 + titleLines * 34 + dekLines * 21 + 22;
  const footer = 70 + (spec.note ? wrapText(spec.note, 120).length * 16 : 0);
  const height = Math.max(420, header + bodyHeight + footer);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="viz-title viz-desc" data-viewport="desktop">`];
  parts.push(`<title id="viz-title">${esc(spec.title)}</title>`);
  parts.push(`<desc id="viz-desc">${esc(spec.alt)}</desc>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  let y = 38;
  y += svgTextLines(parts, spec.title, 54, y, { size: 28, lineHeight: 34, weight: 700, maxChars: 62 });
  if (spec.subtitle) y += svgTextLines(parts, spec.subtitle, 54, y + 2, { size: 15, lineHeight: 21, fill: PALETTE.muted, maxChars: 105 });
  y += 14;
  const bodyTop = y;
  const bodyBottom = height - footer;
  return {
    width,
    height,
    parts,
    bodyTop,
    bodyBottom,
    footerTop: height - footer + 15,
    annotationLayout: createAnnotationLayout({ left: 54, right: 986, top: bodyTop + 4, bottom: bodyBottom - 8 }),
  };
}

function addFooter(parts, spec, footerTop) {
  parts.push(`<line x1="54" y1="${footerTop - 16}" x2="986" y2="${footerTop - 16}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  let y = footerTop;
  if (spec.note) y += svgTextLines(parts, `Note: ${spec.note}`, 54, y, { size: 11, lineHeight: 15, fill: PALETTE.muted, maxChars: 120 });
  svgTextLines(parts, sourceAttribution(spec.source_note), 54, y + 3, { size: 11, lineHeight: 15, fill: PALETTE.muted, maxChars: 120 });
}

function sourceAttribution(value) {
  const note = String(value ?? '').trim();
  return /^source\s*:/i.test(note) ? note : `Source: ${note}`;
}

function extent(values, includeZero = false) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (includeZero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { min -= 1; max += 1; }
  const pad = includeZero ? 0 : (max - min) * 0.08;
  return [min - pad, max + pad];
}

function horizontalScale(domain, left, right) {
  const [min, max] = domain;
  return (value) => left + ((value - min) / (max - min)) * (right - left);
}

function verticalScale(domain, top, bottom) {
  const [min, max] = domain;
  return (value) => bottom - ((value - min) / (max - min)) * (bottom - top);
}

function tickValues(domain, count = 4) {
  const [min, max] = domain;
  return Array.from({ length: count + 1 }, (_, i) => min + ((max - min) * i) / count);
}

function addHorizontalAxis(parts, domain, left, right, top, bottom, unit) {
  for (const tick of tickValues(domain, 4)) {
    const x = horizontalScale(domain, left, right)(tick);
    parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${x}" y="${bottom + 21}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.muted}">${esc(fmt(tick, unit))}</text>`);
  }
}

function sortRows(rows, spec, field) {
  const mode = spec.sort ?? "none";
  const copy = [...rows];
  if (mode === "asc") copy.sort((a, b) => (n(a[field]) ?? 0) - (n(b[field]) ?? 0));
  if (mode === "desc") copy.sort((a, b) => (n(b[field]) ?? 0) - (n(a[field]) ?? 0));
  return copy;
}

function renderGroupedDots(spec, rows) {
  const valueField = spec.value_field;
  const categoryField = spec.category_field;
  const seriesField = spec.series_field;
  const categories = unique(rows.map((row) => String(row[categoryField] ?? ""))).filter(Boolean);
  const series = unique(rows.map((row) => String(row[seriesField] ?? ""))).filter(Boolean);
  const bodyHeight = Math.max(250, categories.length * 48 + 78);
  const f = frame(spec, bodyHeight);
  const left = 250, right = 955, top = f.bodyTop + 34, bottom = f.bodyBottom - 34;
  const values = rows.map((row) => n(row[valueField])).filter((value) => value !== null);
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  const renderedAnnotations = new Set();
  const annotationSeries = new Map(categories.map((category) => {
    const available = series.map((seriesName, index) => rows.some((row) => String(row[categoryField] ?? "") === category && String(row[seriesField] ?? "") === seriesName) ? index : -1).filter((index) => index >= 0);
    return [category, available.at(-1)];
  }));
  const legendY = f.bodyTop + 12;
  f.parts.push(`<text x="${left}" y="${legendY}" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="700" fill="${PALETTE.muted}">分组：</text>`);
  let legendX = left + 42;
  series.forEach((name, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    f.parts.push(`<circle cx="${legendX}" cy="${legendY - 4}" r="5" fill="${color}"/>`);
    f.parts.push(`<text x="${legendX + 10}" y="${legendY}" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.ink}">${esc(name)}</text>`);
    legendX += Math.max(68, String(name).length * 11 + 30);
  });
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit);
  f.parts.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  const step = (bottom - top) / Math.max(categories.length, 1);
  const offsets = series.length <= 1
    ? [0]
    : series.map((_name, index) => (index - (series.length - 1) / 2) * Math.min(16, 28 / series.length));
  categories.forEach((category, categoryIndex) => {
    const center = top + step * categoryIndex + step * 0.5;
    f.parts.push(`<text x="235" y="${center + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${PALETTE.ink}">${esc(category)}</text>`);
    series.forEach((seriesName, seriesIndex) => {
      const row = rows.find((candidate) => String(candidate[categoryField] ?? "") === category && String(candidate[seriesField] ?? "") === seriesName);
      if (!row) return;
      const value = n(row[valueField]);
      if (value === null) return;
      const y = center + (offsets[seriesIndex] ?? 0);
      const x = scale(value);
      const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="5.5" fill="${color}"/>`);
      const label = fmt(value, spec.label_unit ?? "");
      const labelWidth = Math.max(24, label.length * 6.2);
      const canPlaceRight = x + 9 + labelWidth <= right;
      const canPlaceLeft = x - 9 - labelWidth >= left;
      const placeRight = value >= 0 ? canPlaceRight || !canPlaceLeft : !canPlaceLeft;
      const anchor = placeRight ? "start" : "end";
      const labelX = x + (placeRight ? 9 : -9);
      if (spec.direct_labels !== false) {
        f.parts.push(`<text data-role="dot-value-label" x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);
      }
      if (seriesIndex === annotationSeries.get(category)) {
        pointAnnotations(spec, row).forEach((annotation) => {
          const key = `${annotation.claim_id ?? ""}|${annotation.match_field ?? ""}|${annotation.match_value ?? ""}|${annotation.text ?? ""}`;
          if (renderedAnnotations.has(key)) return;
          renderedAnnotations.add(key);
          addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout });
        });
      }
    });
  });
  addFooter(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

function renderHorizontal(spec, rows, mode) {
  const valueField = spec.value_field;
  if (mode === "dot" && spec.series_field && fieldExists(rows, spec.series_field)) {
    return renderGroupedDots(spec, rows);
  }
  const sorted = sortRows(rows, spec, valueField);
  const bodyHeight = Math.max(230, sorted.length * 38 + 45);
  const f = frame(spec, bodyHeight);
  const left = 250, right = 955, top = f.bodyTop + 4, bottom = f.bodyBottom - 34;
  const values = sorted.map((r) => n(r[valueField])).filter((v) => v !== null);
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit);
  f.parts.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  const step = (bottom - top) / sorted.length;
  sorted.forEach((row, i) => {
    const value = n(row[valueField]);
    if (value === null) return;
    const y = top + step * i + step * 0.5;
    f.parts.push(`<text x="235" y="${y + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${PALETTE.ink}">${esc(row[spec.category_field])}</text>`);
    const x = scale(value);
    const highlighted = (spec.highlight_values ?? []).map(String).includes(String(row[spec.category_field]));
    const fill = highlighted ? PALETTE.accent : PALETTE.context;
    if (mode === "bar") {
      const rx = Math.min(x, zero), width = Math.max(1, Math.abs(x - zero));
      f.parts.push(`<rect x="${rx}" y="${y - 8}" width="${width}" height="16" fill="${fill}"/>`);
    } else {
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="5" fill="${fill}"/>`);
    }
    if (spec.chart_type === "diverging_bar") {
      const nearLeft = x <= left + 44;
      const nearRight = x >= right - 44;
      const inside = (value < 0 && nearLeft) || (value >= 0 && nearRight);
      const anchor = inside ? (value < 0 ? "start" : "end") : (value >= 0 ? "start" : "end");
      const labelX = inside ? x + (value < 0 ? 9 : -9) : x + (value >= 0 ? 9 : -9);
      const labelFill = inside && highlighted ? "#fff" : PALETTE.ink;
      f.parts.push(`<text data-role="bar-value-label" x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="600" fill="${labelFill}">${esc(fmt(value, spec.unit))}</text>`);
    } else {
      const anchor = value >= 0 ? "start" : "end";
      const labelX = x + (value >= 0 ? 9 : -9);
      f.parts.push(`<text x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="600" fill="${PALETTE.ink}">${esc(fmt(value, spec.unit))}</text>`);
    }
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout }));
  });
  addFooter(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

function renderDumbbell(spec, rows) {
  const sorted = [...rows];
  const bodyHeight = Math.max(230, sorted.length * 42 + 40);
  const f = frame(spec, bodyHeight);
  const left = 250, right = 945, top = f.bodyTop + 4, bottom = f.bodyBottom - 34;
  const values = sorted.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false);
  const scale = horizontalScale(domain, left, right);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit);
  const step = (bottom - top) / sorted.length;
  sorted.forEach((row, i) => {
    const a = n(row[spec.start_field]), b = n(row[spec.end_field]);
    if (a === null || b === null) return;
    const y = top + step * i + step * 0.5;
    const x1 = scale(a), x2 = scale(b);
    f.parts.push(`<text x="235" y="${y + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${PALETTE.ink}">${esc(row[spec.category_field])}</text>`);
    f.parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${PALETTE.context}" stroke-width="3"/>`);
    f.parts.push(`<circle cx="${x1}" cy="${y}" r="5" fill="${PALETTE.accent2}"/><circle cx="${x2}" cy="${y}" r="5" fill="${PALETTE.accent}"/>`);
    f.parts.push(`<text x="${x1 - 7}" y="${y - 9}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.muted}">${esc(fmt(a, spec.unit))}</text>`);
    f.parts.push(`<text x="${x2 + 7}" y="${y - 9}" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.ink}">${esc(fmt(b, spec.unit))}</text>`);
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x2, y, { side: "right", layout: f.annotationLayout }));
  });
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderSlope(spec, rows) {
  const f = frame(spec, Math.max(300, rows.length * 26));
  const left = 250, right = 790, top = f.bodyTop + 10, bottom = f.bodyBottom - 25;
  const values = rows.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false);
  const scaleY = verticalScale(domain, top, bottom);
  f.parts.push(`<text x="${left}" y="${top - 10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.start_label ?? spec.start_field)}</text>`);
  f.parts.push(`<text x="${right}" y="${top - 10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.end_label ?? spec.end_field)}</text>`);
  rows.forEach((row) => {
    const a = n(row[spec.start_field]), b = n(row[spec.end_field]);
    if (a === null || b === null) return;
    const y1 = scaleY(a), y2 = scaleY(b);
    const category = String(row[spec.category_field] ?? "");
    const highlighted = (spec.highlight_values ?? []).map(String).includes(category);
    const stroke = highlighted ? PALETTE.accent : PALETTE.context;
    const width = highlighted ? 3 : 1.5;
    f.parts.push(`<line x1="${left}" y1="${y1}" x2="${right}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`);
    f.parts.push(`<circle cx="${left}" cy="${y1}" r="4" fill="${stroke}"/><circle cx="${right}" cy="${y2}" r="4" fill="${stroke}"/>`);
    f.parts.push(`<text x="${left - 10}" y="${y1 + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.ink}">${esc(category)} ${esc(fmt(a, spec.unit))}</text>`);
    f.parts.push(`<text x="${right + 10}" y="${y2 + 4}" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.ink}">${esc(fmt(b, spec.unit))}</text>`);
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, right, y2, { side: "right", layout: f.annotationLayout }));
  });
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function sortX(values) {
  const numeric = values.every((v) => n(v) !== null);
  return [...values].sort((a, b) => numeric ? n(a) - n(b) : String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function renderLine(spec, rows, multi = false) {
  const f = frame(spec, 380);
  const left = 100, right = 940, top = f.bodyTop + 15, bottom = f.bodyBottom - 48;
  const seriesField = multi ? spec.series_field : null;
  const seriesNames = seriesField ? unique(rows.map((r) => r[seriesField])) : ["series"];
  const xValues = sortX(unique(rows.map((r) => r[spec.x_field])));
  const yValues = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  const yDomain = extent(yValues, false);
  const yScale = verticalScale(yDomain, top, bottom);
  const xIndex = new Map(xValues.map((v, i) => [String(v), i]));
  const xScale = (value) => xValues.length <= 1 ? (left + right) / 2 : left + (xIndex.get(String(value)) / (xValues.length - 1)) * (right - left);
  for (const tick of tickValues(yDomain, 4)) {
    const y = yScale(tick);
    f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    f.parts.push(`<text x="${left - 12}" y="${y + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.muted}">${esc(fmt(tick, spec.unit))}</text>`);
  }
  const labelEvery = Math.max(1, Math.ceil(xValues.length / 8));
  const directLabels = [];
  xValues.forEach((xv, i) => {
    if (i % labelEvery !== 0 && i !== xValues.length - 1) return;
    f.parts.push(`<text x="${xScale(xv)}" y="${bottom + 24}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.muted}">${esc(xv)}</text>`);
  });
  seriesNames.forEach((series, seriesIndex) => {
    const group = rows.filter((r) => !seriesField || String(r[seriesField]) === series).sort((a, b) => xIndex.get(String(a[spec.x_field])) - xIndex.get(String(b[spec.x_field])));
    const highlighted = !multi || (spec.highlight_values ?? []).map(String).includes(String(series));
    const stroke = multi ? (highlighted ? PALETTE.accent : PALETTE.context) : PALETTE.accent2;
    const width = highlighted ? 3 : 1.4;
    const coords = group.map((r) => `${xScale(r[spec.x_field])},${yScale(n(r[spec.value_field]))}`).join(" ");
    f.parts.push(`<polyline fill="none" stroke="${stroke}" stroke-width="${width}" points="${coords}" opacity="${highlighted ? 1 : 0.72}"/>`);
    if (highlighted || !multi) {
      group.forEach((r) => f.parts.push(`<circle cx="${xScale(r[spec.x_field])}" cy="${yScale(n(r[spec.value_field]))}" r="2.8" fill="${stroke}"/>`));
    }
    group.forEach((row) => { const px=xScale(row[spec.x_field]), py=yScale(n(row[spec.value_field])); pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, px, py, { side: px > right - 170 ? "left" : "right", layout: f.annotationLayout, maxChars: 36, maxLines: 3 })); });
    const last = group[group.length - 1];
    if (last && multi && spec.direct_labels !== false) {
      directLabels.push({
        text: String(series),
        x: Math.min(972, xScale(last[spec.x_field]) + 7),
        y: yScale(n(last[spec.value_field])) + 4,
        highlighted,
      });
    }
    if (last && !multi && spec.direct_labels === true) {
      f.parts.push(`<text data-role="direct-label" x="${Math.min(972, xScale(last[spec.x_field]) + 8)}" y="${yScale(n(last[spec.value_field])) - 8}" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="700" fill="${PALETTE.ink}">${esc(fmt(n(last[spec.value_field]), spec.unit))}</text>`);
    }
  });
  if (multi && spec.direct_labels !== false) {
    for (const label of separateLabelBaselines(directLabels, top + 7, bottom - 7, 14)) {
      f.parts.push(`<text data-role="direct-label" x="${label.x}" y="${label.labelY}" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="${label.highlighted ? 700 : 400}" fill="${label.highlighted ? PALETTE.ink : PALETTE.muted}">${esc(label.text)}</text>`);
    }
  }
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderSmallMultiples(spec, rows) {
  const facets = sortX(unique(rows.map((r) => r[spec.facet_field])));
  const cols = facets.length === 1 ? 1 : 2;
  const gapX = 34, gapY = 44;

  if (spec.panel_mark === "dot") {
    const groups = facets.map((facet) => rows.filter((r) => String(r[spec.facet_field]) === facet));
    const maxItems = Math.max(...groups.map((g) => g.length), 1);
    const panelW = 445;
    const panelH = Math.max(250, maxItems * 36 + 72);
    const rowsN = Math.ceil(facets.length / cols);
    const f = frame(spec, rowsN * panelH + Math.max(0, rowsN - 1) * gapY + 20);
    const allY = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
    let domain = extent(allY, true);
    if (spec.unit === "%" && Math.min(...allY) >= 0 && Math.max(...allY) <= 100) domain = [0, 100];

    facets.forEach((facet, fi) => {
      const col = fi % cols, rowN = Math.floor(fi / cols);
      const x0 = 54 + col * (panelW + gapX), y0 = f.bodyTop + rowN * (panelH + gapY);
      const group = sortRows(rows.filter((r) => String(r[spec.facet_field]) === facet), spec, spec.value_field);
      const labelW = 150;
      const plotLeft = x0 + labelW, plotRight = x0 + panelW - 12;
      const plotTop = y0 + 38, plotBottom = y0 + panelH - 34;
      const xScale = horizontalScale(domain, plotLeft, plotRight);
      f.parts.push(`<text x="${x0}" y="${y0 + 16}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" fill="${PALETTE.ink}">${esc(facet)}</text>`);
      tickValues(domain, 2).forEach((tick) => {
        const x = xScale(tick);
        f.parts.push(`<line x1="${x}" y1="${plotTop - 4}" x2="${x}" y2="${plotBottom}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
        f.parts.push(`<text x="${x}" y="${plotTop - 10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(fmt(tick, spec.unit))}</text>`);
      });
      const step = Math.max(27, (plotBottom - plotTop) / Math.max(group.length, 1));
      group.forEach((r, i) => {
        const value = n(r[spec.value_field]); if (value === null) return;
        const y = plotTop + i * step + step * 0.48;
        const x = xScale(value);
        const category = String(r[spec.x_field] ?? "");
        const highlighted = (spec.highlight_values ?? []).map(String).includes(category);
        f.parts.push(`<text x="${plotLeft - 9}" y="${y + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10.7" fill="${PALETTE.ink}">${esc(category)}</text>`);
        f.parts.push(`<line x1="${plotLeft}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1.5"/>`);
        f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted ? 6 : 4.8}" fill="${highlighted ? PALETTE.accent : PALETTE.accent2}"/>`);
        f.parts.push(`<text x="${x + 7}" y="${y + 4}" font-family="Arial, Helvetica, sans-serif" font-size="10.3" font-weight="600" fill="${PALETTE.ink}">${esc(fmt(value, spec.unit))}</text>`);
        pointAnnotations(spec, r).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: "right", layout: f.annotationLayout }));
      });
    });
    addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
  }

  const panelW = 430, panelH = 230;
  const rowsN = Math.ceil(facets.length / cols);
  const f = frame(spec, rowsN * panelH + Math.max(0, rowsN - 1) * gapY + 20);
  const allY = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  const yDomain = extent(allY, false);
  facets.forEach((facet, fi) => {
    const col = fi % cols, rowN = Math.floor(fi / cols);
    const x0 = 70 + col * (panelW + gapX), y0 = f.bodyTop + rowN * (panelH + gapY);
    const group = rows.filter((r) => String(r[spec.facet_field]) === facet);
    const xs = sortX(unique(group.map((r) => r[spec.x_field])));
    const xMap = new Map(xs.map((v, i) => [String(v), i]));
    const xScale = (value) => xs.length <= 1 ? x0 + panelW / 2 : x0 + (xMap.get(String(value)) / (xs.length - 1)) * panelW;
    const yScale = verticalScale(yDomain, y0 + 30, y0 + panelH - 30);
    f.parts.push(`<text x="${x0}" y="${y0 + 14}" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700" fill="${PALETTE.ink}">${esc(facet)}</text>`);
    [yDomain[0], (yDomain[0] + yDomain[1]) / 2, yDomain[1]].forEach((tick) => {
      const y = yScale(tick);
      f.parts.push(`<line x1="${x0}" y1="${y}" x2="${x0 + panelW}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    });
    const sorted = [...group].sort((a, b) => xMap.get(String(a[spec.x_field])) - xMap.get(String(b[spec.x_field])));
    if (xs.length > 1) {
      const coords = sorted.map((r) => `${xScale(r[spec.x_field])},${yScale(n(r[spec.value_field]))}`).join(" ");
      f.parts.push(`<polyline fill="none" stroke="${PALETTE.accent2}" stroke-width="2.3" points="${coords}"/>`);
    }
    sorted.forEach((r) => {
      const x = xScale(r[spec.x_field]), y = yScale(n(r[spec.value_field]));
      f.parts.push(`<circle cx="${x}" cy="${y}" r="4.2" fill="${PALETTE.accent2}"/>`);
      pointAnnotations(spec, r).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: "right", layout: f.annotationLayout }));
    });
    if (xs.length > 1) {
      f.parts.push(`<text x="${x0}" y="${y0 + panelH}" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.muted}">${esc(xs[0])}</text>`);
      f.parts.push(`<text x="${x0 + panelW}" y="${y0 + panelH}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.muted}">${esc(xs[xs.length - 1])}</text>`);
    }
  });
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderScatter(spec, rows) {
  const f = frame(spec, 420);
  const left = 100, right = 930, top = f.bodyTop + 10, bottom = f.bodyBottom - 66;
  const xs = rows.map((r) => n(r[spec.x_field])).filter((v) => v !== null);
  const ys = rows.map((r) => n(r[spec.y_field])).filter((v) => v !== null);
  const xInfo = makeScale(xs, left, right, spec.x_scale ?? "linear");
  const yRaw = spec.y_scale === "log" ? ys.map(Math.log10) : ys;
  const yDomainRaw = extent(yRaw, false);
  const yLinear = verticalScale(yDomainRaw, top, bottom);
  const yScale = (value) => yLinear(spec.y_scale === "log" ? Math.log10(value) : value);
  const yTicks = tickValues(yDomainRaw, 4).map((v) => spec.y_scale === "log" ? 10 ** v : v);
  yTicks.forEach((tick) => {
    const y = yScale(tick); f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}"/>`);
    f.parts.push(`<text x="${left - 12}" y="${y + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.muted}">${esc(fmt(tick, spec.y_unit ?? spec.unit))}</text>`);
  });
  xInfo.ticks.forEach((tick) => {
    const x = xInfo.scale(tick); f.parts.push(`<text x="${x}" y="${bottom + 24}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.muted}">${esc(fmt(tick, spec.x_unit ?? ""))}</text>`);
  });
  if (spec.x_label) f.parts.push(`<text x="${(left + right) / 2}" y="${bottom + 50}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="600" fill="${PALETTE.muted}">${esc(spec.x_label)}</text>`);
  if (spec.y_label) f.parts.push(`<text x="18" y="${(top + bottom) / 2}" transform="rotate(-90 18 ${(top + bottom) / 2})" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="600" fill="${PALETTE.muted}">${esc(spec.y_label)}</text>`);
  rows.forEach((row) => {
    const x = n(row[spec.x_field]), y = n(row[spec.y_field]); if (x === null || y === null) return;
    const label = spec.label_field ? String(row[spec.label_field] ?? "") : "";
    const highlighted = label && (spec.highlight_values ?? []).map(String).includes(label);
    const px=xInfo.scale(x), py=yScale(y);
    f.parts.push(`<circle cx="${px}" cy="${py}" r="${highlighted ? 6 : 4}" fill="${highlighted ? PALETTE.accent : PALETTE.accent2}" opacity="${highlighted ? 1 : 0.68}"/>`);
    if (highlighted) {
      const labelSide = px > right - 150 ? "left" : "right";
      const placedLabel = f.annotationLayout.place(px, py, label, labelSide, 1);
      if (Math.abs(placedLabel.ty - (py - 13)) > 10) f.parts.push(`<line data-role="direct-label-leader" x1="${px}" y1="${py}" x2="${px + placedLabel.dx * 0.7}" y2="${placedLabel.ty + 3}" stroke="${PALETTE.muted}" stroke-width=".8"/>`);
      f.parts.push(`<text data-role="direct-label" x="${placedLabel.tx}" y="${placedLabel.ty}" text-anchor="${placedLabel.anchor}" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);
    }
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, px, py, { side: px > right - 180 ? "left" : "right", layout: f.annotationLayout, maxChars: 38, maxLines: 3 }));
  });
  if (spec.x_scale === "log") f.parts.push(`<text x="${right}" y="${bottom + 50}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="${PALETTE.muted}">log scale</text>`);
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderHeatmap(spec, rows) {
  const xs = unique(rows.map((r) => r[spec.x_field]));
  const ys = unique(rows.map((r) => r[spec.y_field]));
  const bodyHeight = Math.max(300, ys.length * 34 + 75);
  const f = frame(spec, bodyHeight);
  const left = 190, right = 950, top = f.bodyTop + 35, bottom = f.bodyBottom - 40;
  const cellW = (right - left) / Math.max(1, xs.length), cellH = (bottom - top) / Math.max(1, ys.length);
  const vals = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  const [min, max] = extent(vals, false);
  const index = new Map(rows.map((r) => [`${r[spec.x_field]}\u0000${r[spec.y_field]}`, n(r[spec.value_field])]));
  const mix = (t) => {
    const a = [242, 243, 244], b = [209, 73, 63];
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * clamp(t, 0, 1)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  xs.forEach((xv, xi) => f.parts.push(`<text x="${left + (xi + 0.5) * cellW}" y="${top - 10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.muted}">${esc(xv)}</text>`));
  ys.forEach((yv, yi) => {
    f.parts.push(`<text x="${left - 10}" y="${top + (yi + 0.5) * cellH + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.ink}">${esc(yv)}</text>`);
    xs.forEach((xv, xi) => {
      const value = index.get(`${xv}\u0000${yv}`); if (value === null || value === undefined) return;
      const t = (value - min) / (max - min || 1);
      const x = left + xi * cellW, y = top + yi * cellH;
      f.parts.push(`<rect x="${x + 1}" y="${y + 1}" width="${Math.max(1, cellW - 2)}" height="${Math.max(1, cellH - 2)}" fill="${mix(t)}"/>`);
      if (cellW > 48 && cellH > 24) f.parts.push(`<text x="${x + cellW / 2}" y="${y + cellH / 2 + 4}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="${t > 0.58 ? "#fff" : PALETTE.ink}">${esc(fmt(value, spec.unit))}</text>`);
    });
  });
  const legendY=bottom+13, legendW=150;
  f.parts.push(`<defs><linearGradient id="heatmap-grad-d" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="${mix(0)}"/><stop offset="100%" stop-color="${mix(1)}"/></linearGradient></defs>`);
  f.parts.push(`<rect data-role="heatmap-legend" x="${left}" y="${legendY}" width="${legendW}" height="8" fill="url(#heatmap-grad-d)"/>`);
  f.parts.push(`<text x="${left}" y="${legendY+22}" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="${PALETTE.muted}">${esc(fmt(min,spec.unit))}</text>`);
  f.parts.push(`<text x="${left+legendW}" y="${legendY+22}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="${PALETTE.muted}">${esc(fmt(max,spec.unit))}</text>`);
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}


function mobileFrame(spec, bodyHeight) {
  const width = 640;
  const margin = 32;
  const titleLines = wrapText(spec.title, 38).length;
  const dekLines = spec.subtitle ? wrapText(spec.subtitle, 58).length : 0;
  const header = 26 + titleLines * 31 + dekLines * 20 + 20;
  const footer = 78 + (spec.note ? wrapText(spec.note, 70).length * 15 : 0);
  const height = Math.max(440, header + bodyHeight + footer);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="viz-title-mobile viz-desc-mobile" data-viewport="mobile">`];
  parts.push(`<title id="viz-title-mobile">${esc(spec.title)}</title>`);
  parts.push(`<desc id="viz-desc-mobile">${esc(spec.alt)}</desc>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  let y = 34;
  y += svgTextLines(parts, spec.title, margin, y, { size: 25, lineHeight: 31, weight: 700, maxChars: 38 });
  if (spec.subtitle) y += svgTextLines(parts, spec.subtitle, margin, y + 2, { size: 14, lineHeight: 20, fill: PALETTE.muted, maxChars: 58 });
  y += 14;
  const bodyTop = y;
  const bodyBottom = height - footer;
  return {
    width,
    margin,
    height,
    parts,
    bodyTop,
    bodyBottom,
    footerTop: height - footer + 16,
    annotationLayout: createAnnotationLayout({ left: margin, right: width - margin, top: bodyTop + 4, bottom: bodyBottom - 8, line_gap: 17 }),
  };
}

function addMobileFooter(parts, spec, footerTop) {
  parts.push(`<line x1="32" y1="${footerTop - 16}" x2="608" y2="${footerTop - 16}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  let y = footerTop;
  if (spec.note) y += svgTextLines(parts, `Note: ${spec.note}`, 32, y, { size: 10.5, lineHeight: 15, fill: PALETTE.muted, maxChars: 70 });
  svgTextLines(parts, sourceAttribution(spec.source_note), 32, y + 3, { size: 10.5, lineHeight: 15, fill: PALETTE.muted, maxChars: 70 });
}

function renderMobileHorizontal(spec, rows, mode) {
  if (mode === "dot" && spec.series_field && fieldExists(rows, spec.series_field)) {
    return renderGroupedDotsMobile(spec, rows);
  }
  const sorted = sortRows(rows, spec, spec.value_field);
  const f = mobileFrame(spec, Math.max(250, sorted.length * 42 + 50));
  const left = 178, right = 595, top = f.bodyTop + 5, bottom = f.bodyBottom - 36;
  const values = sorted.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit);
  f.parts.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  const step = (bottom - top) / Math.max(1, sorted.length);
  sorted.forEach((row, i) => {
    const value = n(row[spec.value_field]); if (value === null) return;
    const y = top + step * i + step * 0.5;
    const category = String(row[spec.category_field] ?? "");
    f.parts.push(`<text x="165" y="${y + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.ink}">${esc(category.length > 20 ? category.slice(0, 19) + "…" : category)}</text>`);
    const x = scale(value);
    const highlighted = (spec.highlight_values ?? []).map(String).includes(category);
    const fill = highlighted ? PALETTE.accent : PALETTE.context;
    if (mode === "bar") {
      const rx = Math.min(x, zero), width = Math.max(1, Math.abs(x - zero));
      f.parts.push(`<rect x="${rx}" y="${y - 7}" width="${width}" height="14" fill="${fill}"/>`);
    } else {
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="4.8" fill="${fill}"/>`);
    }
    if (spec.chart_type === "diverging_bar") {
      const nearLeft = x <= left + 40;
      const nearRight = x >= right - 40;
      const inside = (value < 0 && nearLeft) || (value >= 0 && nearRight);
      const anchor = inside ? (value < 0 ? "start" : "end") : (value >= 0 ? "start" : "end");
      const labelX = inside ? x + (value < 0 ? 8 : -8) : x + (value >= 0 ? 8 : -8);
      const labelFill = inside && highlighted ? "#fff" : PALETTE.ink;
      f.parts.push(`<text data-role="bar-value-label" x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="600" fill="${labelFill}">${esc(fmt(value, spec.unit))}</text>`);
    } else {
      const anchor = value >= 0 ? "start" : "end";
      const labelX = x + (value >= 0 ? 8 : -8);
      f.parts.push(`<text x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="600" fill="${PALETTE.ink}">${esc(fmt(value, spec.unit))}</text>`);
    }
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout, maxChars: 30 }));
  });
  addMobileFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderGroupedDotsMobile(spec, rows) {
  const valueField = spec.value_field;
  const categoryField = spec.category_field;
  const seriesField = spec.series_field;
  const categories = unique(rows.map((row) => String(row[categoryField] ?? ""))).filter(Boolean);
  const series = unique(rows.map((row) => String(row[seriesField] ?? ""))).filter(Boolean);
  const bodyHeight = Math.max(280, categories.length * 48 + 92);
  const f = mobileFrame(spec, bodyHeight);
  const left = 178, right = 592, top = f.bodyTop + 48, bottom = f.bodyBottom - 34;
  const values = rows.map((row) => n(row[valueField])).filter((value) => value !== null);
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  const renderedAnnotations = new Set();
  const annotationSeries = new Map(categories.map((category) => {
    const available = series.map((seriesName, index) => rows.some((row) => String(row[categoryField] ?? "") === category && String(row[seriesField] ?? "") === seriesName) ? index : -1).filter((index) => index >= 0);
    return [category, available.at(-1)];
  }));
  const legendY = f.bodyTop + 16;
  f.parts.push(`<text x="${left}" y="${legendY}" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" fill="${PALETTE.muted}">分组：</text>`);
  let legendX = left + 36;
  series.forEach((name, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    f.parts.push(`<circle cx="${legendX}" cy="${legendY - 3}" r="4" fill="${color}"/>`);
    f.parts.push(`<text x="${legendX + 8}" y="${legendY}" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.ink}">${esc(name)}</text>`);
    legendX += Math.max(56, String(name).length * 9 + 24);
  });
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit);
  f.parts.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.1"/>`);
  const step = (bottom - top) / Math.max(categories.length, 1);
  const offsets = series.length <= 1
    ? [0]
    : series.map((_name, index) => (index - (series.length - 1) / 2) * Math.min(14, 24 / series.length));
  categories.forEach((category, categoryIndex) => {
    const center = top + step * categoryIndex + step * 0.5;
    f.parts.push(`<text x="165" y="${center + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10.5" fill="${PALETTE.ink}">${esc(category.length > 20 ? category.slice(0, 19) + "…" : category)}</text>`);
    series.forEach((seriesName, seriesIndex) => {
      const row = rows.find((candidate) => String(candidate[categoryField] ?? "") === category && String(candidate[seriesField] ?? "") === seriesName);
      if (!row) return;
      const value = n(row[valueField]);
      if (value === null) return;
      const y = center + (offsets[seriesIndex] ?? 0);
      const x = scale(value);
      const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1.5"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="4.8" fill="${color}"/>`);
      const label = fmt(value, spec.label_unit ?? "");
      const labelWidth = Math.max(22, label.length * 5.5);
      const canPlaceRight = x + 7 + labelWidth <= right;
      const canPlaceLeft = x - 7 - labelWidth >= left;
      const placeRight = value >= 0 ? canPlaceRight || !canPlaceLeft : !canPlaceLeft;
      const anchor = placeRight ? "start" : "end";
      const labelX = x + (placeRight ? 7 : -7);
      if (spec.direct_labels !== false) {
        f.parts.push(`<text data-role="dot-value-label" x="${labelX}" y="${y + 3.5}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="9.5" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);
      }
      if (seriesIndex === annotationSeries.get(category)) {
        pointAnnotations(spec, row).forEach((annotation) => {
          const key = `${annotation.claim_id ?? ""}|${annotation.match_field ?? ""}|${annotation.match_value ?? ""}|${annotation.text ?? ""}`;
          if (renderedAnnotations.has(key)) return;
          renderedAnnotations.add(key);
          addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout, maxChars: 26 });
        });
      }
    });
  });
  addMobileFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderMobileDumbbell(spec, rows) {
  const f = mobileFrame(spec, Math.max(250, rows.length * 46 + 46));
  const left = 178, right = 585, top = f.bodyTop + 5, bottom = f.bodyBottom - 36;
  const values = rows.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false);
  const scale = horizontalScale(domain, left, right);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit);
  const step = (bottom - top) / Math.max(1, rows.length);
  rows.forEach((row, i) => {
    const a = n(row[spec.start_field]), b = n(row[spec.end_field]); if (a === null || b === null) return;
    const y = top + step * i + step * 0.5, x1 = scale(a), x2 = scale(b);
    const category = String(row[spec.category_field] ?? "");
    f.parts.push(`<text x="165" y="${y + 4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="${PALETTE.ink}">${esc(category.length > 20 ? category.slice(0, 19) + "…" : category)}</text>`);
    f.parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${PALETTE.context}" stroke-width="3"/>`);
    f.parts.push(`<circle cx="${x1}" cy="${y}" r="4.8" fill="${PALETTE.accent2}"/><circle cx="${x2}" cy="${y}" r="4.8" fill="${PALETTE.accent}"/>`);
    f.parts.push(`<text x="${x1 - 6}" y="${y - 9}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(fmt(a, spec.unit))}</text>`);
    f.parts.push(`<text x="${x2 + 6}" y="${y - 9}" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.ink}">${esc(fmt(b, spec.unit))}</text>`);
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x2, y, { side: "right", layout: f.annotationLayout, maxChars: 30 }));
  });
  addMobileFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderMobileSlope(spec, rows) {
  const f = mobileFrame(spec, Math.max(320, rows.length * 29));
  const left = 185, right = 445, top = f.bodyTop + 12, bottom = f.bodyBottom - 30;
  const values = rows.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false), scaleY = verticalScale(domain, top, bottom);
  f.parts.push(`<text x="${left}" y="${top - 10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11.5" font-weight="600" fill="${PALETTE.muted}">${esc(spec.start_label ?? spec.start_field)}</text>`);
  f.parts.push(`<text x="${right}" y="${top - 10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11.5" font-weight="600" fill="${PALETTE.muted}">${esc(spec.end_label ?? spec.end_field)}</text>`);
  rows.forEach((row) => {
    const a=n(row[spec.start_field]), b=n(row[spec.end_field]); if (a===null||b===null) return;
    const y1=scaleY(a), y2=scaleY(b), category=String(row[spec.category_field]??"");
    const highlighted=(spec.highlight_values??[]).map(String).includes(category), stroke=highlighted?PALETTE.accent:PALETTE.context;
    f.parts.push(`<line x1="${left}" y1="${y1}" x2="${right}" y2="${y2}" stroke="${stroke}" stroke-width="${highlighted?3:1.5}"/>`);
    f.parts.push(`<circle cx="${left}" cy="${y1}" r="4" fill="${stroke}"/><circle cx="${right}" cy="${y2}" r="4" fill="${stroke}"/>`);
    f.parts.push(`<text x="${left-8}" y="${y1+4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.ink}">${esc(category.length>18?category.slice(0,17)+"…":category)} ${esc(fmt(a,spec.unit))}</text>`);
    f.parts.push(`<text x="${right+8}" y="${y2+4}" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.ink}">${esc(fmt(b,spec.unit))}</text>`);
    pointAnnotations(spec,row).forEach((annotation)=>addPointAnnotation(f.parts,annotation,right,y2,{side:"right",layout:f.annotationLayout,maxChars:28}));
  });
  addMobileFooter(f.parts,spec,f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n")+"\n";
}

function renderMobileLine(spec, rows, multi=false) {
  const f=mobileFrame(spec,390), left=70, right=555, top=f.bodyTop+16, bottom=f.bodyBottom-50;
  const seriesField=multi?spec.series_field:null;
  const seriesNames=seriesField?unique(rows.map((r)=>r[seriesField])):["series"];
  const xValues=sortX(unique(rows.map((r)=>r[spec.x_field]))), yValues=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null);
  const yDomain=extent(yValues,false), yScale=verticalScale(yDomain,top,bottom), xIndex=new Map(xValues.map((v,i)=>[String(v),i]));
  const xScale=(value)=>xValues.length<=1?(left+right)/2:left+(xIndex.get(String(value))/(xValues.length-1))*(right-left);
  for (const tick of tickValues(yDomain,4)) { const y=yScale(tick); f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}"/>`); f.parts.push(`<text x="${left-9}" y="${y+4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(fmt(tick,spec.unit))}</text>`); }
  const every=Math.max(1,Math.ceil(xValues.length/5)); xValues.forEach((xv,i)=>{ if(i%every!==0&&i!==xValues.length-1)return; f.parts.push(`<text x="${xScale(xv)}" y="${bottom+23}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(xv)}</text>`); });
  const directLabels=[];
  seriesNames.forEach((series)=>{
    const group=rows.filter((r)=>!seriesField||String(r[seriesField])===String(series)).sort((a,b)=>xIndex.get(String(a[spec.x_field]))-xIndex.get(String(b[spec.x_field])));
    const highlighted=!multi||(spec.highlight_values??[]).map(String).includes(String(series)), stroke=multi?(highlighted?PALETTE.accent:PALETTE.context):PALETTE.accent2;
    const coords=group.map((r)=>`${xScale(r[spec.x_field])},${yScale(n(r[spec.value_field]))}`).join(" ");
    f.parts.push(`<polyline fill="none" stroke="${stroke}" stroke-width="${highlighted?3:1.4}" points="${coords}" opacity="${highlighted?1:.72}"/>`);
    if(highlighted||!multi) group.forEach((r)=>f.parts.push(`<circle cx="${xScale(r[spec.x_field])}" cy="${yScale(n(r[spec.value_field]))}" r="2.8" fill="${stroke}"/>`));
    group.forEach((row)=>{const px=xScale(row[spec.x_field]),py=yScale(n(row[spec.value_field]));pointAnnotations(spec,row).forEach((annotation)=>addPointAnnotation(f.parts,annotation,px,py,{side:px>right-135?"left":"right",layout:f.annotationLayout,maxChars:28,maxLines:3}));});
    const last=group[group.length-1];
    if(last&&multi&&spec.direct_labels!==false) directLabels.push({text:String(series),x:Math.min(602,xScale(last[spec.x_field])+6),y:yScale(n(last[spec.value_field]))+4,highlighted});
    if(last&&!multi&&spec.direct_labels===true) f.parts.push(`<text data-role="direct-label" x="${Math.min(602,xScale(last[spec.x_field])+7)}" y="${yScale(n(last[spec.value_field]))-8}" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" fill="${PALETTE.ink}">${esc(fmt(n(last[spec.value_field]),spec.unit))}</text>`);
  });
  if(multi&&spec.direct_labels!==false) for(const label of separateLabelBaselines(directLabels,top+7,bottom-7,15)) f.parts.push(`<text data-role="direct-label" x="${label.x}" y="${label.labelY}" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="${label.highlighted?700:400}" fill="${label.highlighted?PALETTE.ink:PALETTE.muted}">${esc(label.text)}</text>`);
  addMobileFooter(f.parts,spec,f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n")+"\n";
}

function renderMobileSmallMultiples(spec, rows) {
  const facets=sortX(unique(rows.map((r)=>r[spec.facet_field]))), gapY=34, panelW=576;
  if(spec.panel_mark==="dot") {
    const groups=facets.map((facet)=>rows.filter((r)=>String(r[spec.facet_field])===String(facet))), maxItems=Math.max(...groups.map((g)=>g.length),1);
    const panelH=Math.max(245,maxItems*36+68), f=mobileFrame(spec,facets.length*panelH+Math.max(0,facets.length-1)*gapY+20);
    const all=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null); let domain=extent(all,true); if(spec.unit==="%"&&Math.min(...all)>=0&&Math.max(...all)<=100)domain=[0,100];
    facets.forEach((facet,fi)=>{
      const x0=32,y0=f.bodyTop+fi*(panelH+gapY),group=sortRows(rows.filter((r)=>String(r[spec.facet_field])===String(facet)),spec,spec.value_field),labelW=138,plotLeft=x0+labelW,plotRight=x0+panelW-6,plotTop=y0+38,plotBottom=y0+panelH-34,xScale=horizontalScale(domain,plotLeft,plotRight);
      f.parts.push(`<text x="${x0}" y="${y0+16}" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700" fill="${PALETTE.ink}">${esc(facet)}</text>`);
      tickValues(domain,2).forEach((tick)=>{const x=xScale(tick);f.parts.push(`<line x1="${x}" y1="${plotTop-4}" x2="${x}" y2="${plotBottom}" stroke="${PALETTE.grid}"/>`);f.parts.push(`<text x="${x}" y="${plotTop-10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="${PALETTE.muted}">${esc(fmt(tick,spec.unit))}</text>`);});
      const step=Math.max(27,(plotBottom-plotTop)/Math.max(group.length,1)); group.forEach((r,i)=>{const value=n(r[spec.value_field]);if(value===null)return;const y=plotTop+i*step+step*.48,x=xScale(value),category=String(r[spec.x_field]??""),highlighted=(spec.highlight_values??[]).map(String).includes(category);f.parts.push(`<text x="${plotLeft-8}" y="${y+4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.ink}">${esc(category.length>18?category.slice(0,17)+"…":category)}</text>`);f.parts.push(`<line x1="${plotLeft}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1.4"/>`);f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted?5.7:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x+6}" y="${y+4}" font-family="Arial, Helvetica, sans-serif" font-size="9.8" font-weight="600" fill="${PALETTE.ink}">${esc(fmt(value,spec.unit))}</text>`);pointAnnotations(spec,r).forEach((annotation)=>addPointAnnotation(f.parts,annotation,x,y,{side:"right",layout:f.annotationLayout,maxChars:36}));});
    });
    addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
  }
  const panelH=220, f=mobileFrame(spec,facets.length*panelH+Math.max(0,facets.length-1)*gapY+20), all=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null), yDomain=extent(all,false);
  facets.forEach((facet,fi)=>{const x0=42,y0=f.bodyTop+fi*(panelH+gapY),group=rows.filter((r)=>String(r[spec.facet_field])===String(facet)),xs=sortX(unique(group.map((r)=>r[spec.x_field]))),xMap=new Map(xs.map((v,i)=>[String(v),i])),xScale=(value)=>xs.length<=1?x0+panelW/2:x0+(xMap.get(String(value))/(xs.length-1))*panelW,yScale=verticalScale(yDomain,y0+30,y0+panelH-30);f.parts.push(`<text x="${x0}" y="${y0+14}" font-family="Arial, Helvetica, sans-serif" font-size="13.5" font-weight="700" fill="${PALETTE.ink}">${esc(facet)}</text>`);[yDomain[0],(yDomain[0]+yDomain[1])/2,yDomain[1]].forEach((tick)=>{const y=yScale(tick);f.parts.push(`<line x1="${x0}" y1="${y}" x2="${x0+panelW}" y2="${y}" stroke="${PALETTE.grid}"/>`);});const sorted=[...group].sort((a,b)=>xMap.get(String(a[spec.x_field]))-xMap.get(String(b[spec.x_field])));if(xs.length>1){const coords=sorted.map((r)=>`${xScale(r[spec.x_field])},${yScale(n(r[spec.value_field]))}`).join(" ");f.parts.push(`<polyline fill="none" stroke="${PALETTE.accent2}" stroke-width="2.2" points="${coords}"/>`);}sorted.forEach((r)=>{const x=xScale(r[spec.x_field]),y=yScale(n(r[spec.value_field]));f.parts.push(`<circle cx="${x}" cy="${y}" r="4" fill="${PALETTE.accent2}"/>`);pointAnnotations(spec,r).forEach((annotation)=>addPointAnnotation(f.parts,annotation,x,y,{side:"right",layout:f.annotationLayout,maxChars:28}));});if(xs.length>1){f.parts.push(`<text x="${x0}" y="${y0+panelH}" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(xs[0])}</text>`);f.parts.push(`<text x="${x0+panelW}" y="${y0+panelH}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(xs[xs.length-1])}</text>`);}});
  addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}

function renderMobileScatter(spec, rows) {
  const f=mobileFrame(spec,420),left=72,right=594,top=f.bodyTop+12,bottom=f.bodyBottom-64,xs=rows.map((r)=>n(r[spec.x_field])).filter((v)=>v!==null),ys=rows.map((r)=>n(r[spec.y_field])).filter((v)=>v!==null),xInfo=makeScale(xs,left,right,spec.x_scale??"linear"),yRaw=spec.y_scale==="log"?ys.map(Math.log10):ys,yDomainRaw=extent(yRaw,false),yLinear=verticalScale(yDomainRaw,top,bottom),yScale=(value)=>yLinear(spec.y_scale==="log"?Math.log10(value):value),yTicks=tickValues(yDomainRaw,4).map((v)=>spec.y_scale==="log"?10**v:v);
  yTicks.forEach((tick)=>{const y=yScale(tick);f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}"/>`);f.parts.push(`<text x="${left-9}" y="${y+4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(fmt(tick,spec.y_unit??spec.unit))}</text>`);});
  xInfo.ticks.forEach((tick)=>{const x=xInfo.scale(tick);f.parts.push(`<text x="${x}" y="${bottom+23}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(fmt(tick,spec.x_unit??""))}</text>`);});
  if(spec.x_label)f.parts.push(`<text x="${(left+right)/2}" y="${bottom+47}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="10.5" font-weight="600" fill="${PALETTE.muted}">${esc(spec.x_label)}</text>`);
  rows.forEach((row)=>{const x=n(row[spec.x_field]),y=n(row[spec.y_field]);if(x===null||y===null)return;const label=spec.label_field?String(row[spec.label_field]??""):"",highlighted=label&&(spec.highlight_values??[]).map(String).includes(label),px=xInfo.scale(x),py=yScale(y);f.parts.push(`<circle cx="${px}" cy="${py}" r="${highlighted?5.8:3.8}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}" opacity="${highlighted?1:.68}"/>`);if(highlighted){const labelSide=px>right-125?"left":"right",placedLabel=f.annotationLayout.place(px,py,label,labelSide,1);if(Math.abs(placedLabel.ty-(py-13))>10)f.parts.push(`<line data-role="direct-label-leader" x1="${px}" y1="${py}" x2="${px+placedLabel.dx*.7}" y2="${placedLabel.ty+3}" stroke="${PALETTE.muted}" stroke-width=".8"/>`);f.parts.push(`<text data-role="direct-label" x="${placedLabel.tx}" y="${placedLabel.ty}" text-anchor="${placedLabel.anchor}" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);}pointAnnotations(spec,row).forEach((annotation)=>addPointAnnotation(f.parts,annotation,px,py,{side:px>right-150?"left":"right",layout:f.annotationLayout,maxChars:30,maxLines:3}));});
  if(spec.x_scale==="log")f.parts.push(`<text x="${right}" y="${bottom+47}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="9" fill="${PALETTE.muted}">log scale</text>`);
  addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}

function renderMobileHeatmap(spec, rows) {
  const xs=unique(rows.map((r)=>r[spec.x_field])),ys=unique(rows.map((r)=>r[spec.y_field])),f=mobileFrame(spec,Math.max(330,ys.length*34+102)),left=145,right=606,top=f.bodyTop+40,bottom=f.bodyBottom-62,cellW=(right-left)/Math.max(1,xs.length),cellH=(bottom-top)/Math.max(1,ys.length),vals=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null),[min,max]=extent(vals,false),index=new Map(rows.map((r)=>[`${r[spec.x_field]}\u0000${r[spec.y_field]}`,n(r[spec.value_field])])),mix=(t)=>{const a=[242,243,244],b=[209,73,63],c=a.map((v,i)=>Math.round(v+(b[i]-v)*clamp(t,0,1)));return `rgb(${c[0]},${c[1]},${c[2]})`;};
  xs.forEach((xv,xi)=>f.parts.push(`<text x="${left+(xi+.5)*cellW}" y="${top-10}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="${PALETTE.muted}">${esc(String(xv).length>10?String(xv).slice(0,9)+"…":xv)}</text>`));
  ys.forEach((yv,yi)=>{f.parts.push(`<text x="${left-8}" y="${top+(yi+.5)*cellH+4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="9.8" fill="${PALETTE.ink}">${esc(String(yv).length>18?String(yv).slice(0,17)+"…":yv)}</text>`);xs.forEach((xv,xi)=>{const value=index.get(`${xv}\u0000${yv}`);if(value===null||value===undefined)return;const t=(value-min)/(max-min||1),x=left+xi*cellW,y=top+yi*cellH;f.parts.push(`<rect x="${x+1}" y="${y+1}" width="${Math.max(1,cellW-2)}" height="${Math.max(1,cellH-2)}" fill="${mix(t)}"/>`);if(cellW>34&&cellH>24)f.parts.push(`<text x="${x+cellW/2}" y="${y+cellH/2+3}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="7.4" fill="${t>.58?"#fff":PALETTE.ink}">${esc(fmt(value,spec.unit))}</text>`);});});
  const legendY=bottom+13,legendW=140;
  f.parts.push(`<defs><linearGradient id="heatmap-grad-m" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="${mix(0)}"/><stop offset="100%" stop-color="${mix(1)}"/></linearGradient></defs>`);
  f.parts.push(`<rect data-role="heatmap-legend" x="${left}" y="${legendY}" width="${legendW}" height="8" fill="url(#heatmap-grad-m)"/>`);
  f.parts.push(`<text x="${left}" y="${legendY+22}" font-family="Arial, Helvetica, sans-serif" font-size="9" fill="${PALETTE.muted}">${esc(fmt(min,spec.unit))}</text>`);
  f.parts.push(`<text x="${left+legendW}" y="${legendY+22}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="9" fill="${PALETTE.muted}">${esc(fmt(max,spec.unit))}</text>`);
  addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}


function flowLayout(rows, spec) {
  if (hasDirectedCycle(rows, spec.source_field, spec.target_field)) {
    throw new Error(`${spec.chart_type ?? "flow"} renderer requires an acyclic flow graph`);
  }
  const nodes = new Map();
  const incoming = new Map(), outgoing = new Map();
  const ensure = (id) => { if (!nodes.has(id)) nodes.set(id, { id, in: 0, out: 0, level: 0 }); return nodes.get(id); };
  for (const row of rows) {
    const a=String(row[spec.source_field]), b=String(row[spec.target_field]), v=n(row[spec.value_field]) ?? 0;
    ensure(a).out += v; ensure(b).in += v;
    if(!outgoing.has(a))outgoing.set(a,[]); outgoing.get(a).push(b);
    if(!incoming.has(b))incoming.set(b,[]); incoming.get(b).push(a);
  }
  const roots=[...nodes.keys()].filter((id)=>!(incoming.get(id)?.length));
  const queue=roots.map((id)=>[id,0]); const seen=new Map();
  while(queue.length){const [id,level]=queue.shift(); if((seen.get(id)??-1)>=level)continue;seen.set(id,level);nodes.get(id).level=level;for(const next of outgoing.get(id)??[])queue.push([next,level+1]);}
  const maxLevel=Math.max(...[...nodes.values()].map((node)=>node.level),0);
  const levels=Array.from({length:maxLevel+1},()=>[]);
  for(const node of nodes.values())levels[node.level].push(node);
  for(const level of levels)level.sort((a,b)=>Math.max(b.in,b.out)-Math.max(a.in,a.out)||a.id.localeCompare(b.id));
  return { nodes, levels, maxLevel };
}

function sankeyPath(x1,y1,x2,y2) { const c=(x2-x1)*0.45; return `M${x1},${y1} C${x1+c},${y1} ${x2-c},${y2} ${x2},${y2}`; }

function renderSankey(spec, rows, mobile=false) {
  const layout=flowLayout(rows,spec), width=mobile?640:1040, nodeW=mobile?92:112, margin=mobile?32:54;
  const maxNodes=Math.max(...layout.levels.map((level)=>level.length),1), bodyH=Math.max(mobile?430:410,maxNodes*(mobile?66:58)+80);
  const f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH), left=margin+10, right=width-margin-10, top=f.bodyTop+28, bottom=f.bodyBottom-28;
  const levels=Math.max(layout.maxLevel+1,2), xAt=(level)=>left+(right-left-nodeW)*(level/Math.max(1,levels-1));
  const positions=new Map(), nodeValues=[...layout.nodes.values()].map((node)=>Math.max(node.in,node.out)); const maxNode=Math.max(...nodeValues,1);
  layout.levels.forEach((level,li)=>{const totalH=bottom-top, gap=mobile?20:16, usable=totalH-gap*Math.max(0,level.length-1), raw=level.map((node)=>Math.max(24,(Math.max(node.in,node.out)/maxNode)*Math.min(110,usable/Math.max(1,level.length)*1.7))), sum=raw.reduce((a,b)=>a+b,0), scale=sum>usable?usable/sum:1;let y=top+(usable-sum*scale)/2;level.forEach((node,i)=>{const h=raw[i]*scale;positions.set(node.id,{x:xAt(li),y,h});y+=h+gap;});});
  const maxFlow=Math.max(...rows.map((r)=>n(r[spec.value_field])??0),1);
  const outOffsets=new Map(), inOffsets=new Map();
  rows.slice().sort((a,b)=>(n(b[spec.value_field])??0)-(n(a[spec.value_field])??0)).forEach((row,ri)=>{const a=String(row[spec.source_field]),b=String(row[spec.target_field]),v=n(row[spec.value_field])??0,pa=positions.get(a),pb=positions.get(b);if(!pa||!pb)return;const sw=Math.max(1.5,(v/maxFlow)*(mobile?22:30)),oa=outOffsets.get(a)??0,ib=inOffsets.get(b)??0,y1=pa.y+pa.h/2+oa,y2=pb.y+pb.h/2+ib;outOffsets.set(a,oa+(ri%2?1:-1)*Math.min(pa.h*.18,sw*.22));inOffsets.set(b,ib+(ri%2?-1:1)*Math.min(pb.h*.18,sw*.22));const flowKey = spec.flow_id_field && row[spec.flow_id_field] !== undefined ? String(row[spec.flow_id_field]) : `${a}→${b}`;const d=sankeyPath(pa.x+nodeW,y1,pb.x,y2);f.parts.push(`<path data-role="flow-hit" data-flow-key="${esc(flowKey)}" d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(14,sw*2.5)}" stroke-linecap="round" pointer-events="stroke"/>`);f.parts.push(`<path data-role="flow-link" data-flow-key="${esc(flowKey)}" d="${d}" fill="none" stroke="${SERIES_COLORS[ri%SERIES_COLORS.length]}" stroke-width="${sw}" stroke-opacity="${spec.chart_type==="alluvial"?.46:.56}" stroke-linecap="round" pointer-events="none"/>`);});
  layout.levels.forEach((level,li)=>level.forEach((node,ni)=>{const p=positions.get(node.id), highlighted=(spec.highlight_values??[]).includes(node.id);f.parts.push(`<rect data-role="flow-node" x="${p.x}" y="${p.y}" width="${nodeW}" height="${p.h}" rx="2" fill="${highlighted?PALETTE.accent:PALETTE.ink}" opacity="${highlighted?1:.88}"/>`);const labelLines=wrapText(node.id,mobile?15:16).slice(0,2);labelLines.forEach((line,j)=>f.parts.push(`<text x="${p.x+nodeW/2}" y="${p.y+p.h/2-(labelLines.length-1)*6+j*12+4}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9.5:10.5}" font-weight="600" fill="#fff">${esc(line)}</text>`));}));
  addPointlessFlowAnnotations(f.parts,spec,positions,nodeW,f.annotationLayout,mobile);
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}

function addPointlessFlowAnnotations(parts,spec,positions,nodeW,layout,mobile){for(const annotation of annotations(spec)){if(annotation.type!=="node")continue;const p=positions.get(String(annotation.match_value));if(!p)continue;const lines=wrapText(annotationLabel(annotation,mobile?26:34),mobile?26:34).slice(0,3),cx=p.x+nodeW/2,above=p.y>90,baseY=above?p.y-18:p.y+p.h+24;parts.push(`<line data-role="annotation-leader" x1="${cx}" y1="${above?p.y:p.y+p.h}" x2="${cx}" y2="${above?baseY+7:baseY-13}" stroke="${PALETTE.muted}" stroke-width="1"/>`);lines.forEach((line,i)=>parts.push(`<text data-role="annotation" x="${cx}" y="${baseY+i*13}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9.2:10.3}" font-weight="600" fill="${PALETTE.ink}">${esc(line)}</text>`));}}

function networkLayout(rows,spec,width,height,left,top,right,bottom){const ids=unique(rows.flatMap((row)=>[row[spec.source_field],row[spec.target_field]])),degree=new Map(ids.map((id)=>[id,0]));for(const row of rows){degree.set(String(row[spec.source_field]),(degree.get(String(row[spec.source_field]))??0)+1);degree.set(String(row[spec.target_field]),(degree.get(String(row[spec.target_field]))??0)+1);}ids.sort((a,b)=>(degree.get(b)??0)-(degree.get(a)??0)||String(a).localeCompare(String(b)));const cx=(left+right)/2,cy=(top+bottom)/2,rx=(right-left)*.42,ry=(bottom-top)*.4,pos=new Map();ids.forEach((id,i)=>{const angle=-Math.PI/2+(i/Math.max(ids.length,1))*Math.PI*2;pos.set(String(id),{x:cx+Math.cos(angle)*rx,y:cy+Math.sin(angle)*ry,degree:degree.get(id)??0});});return {ids,pos,degree};}

function renderNodeLink(spec,rows,mobile=false){const f=mobile?mobileFrame(spec,440):frame(spec,440),left=mobile?58:110,right=mobile?582:930,top=f.bodyTop+35,bottom=f.bodyBottom-35,layout=networkLayout(rows,spec,mobile?640:1040,440,left,top,right,bottom),maxDegree=Math.max(...layout.ids.map((id)=>layout.degree.get(id)),1);for(const row of rows){const a=layout.pos.get(String(row[spec.source_field])),b=layout.pos.get(String(row[spec.target_field]));if(!a||!b)continue;const value=spec.value_field?(n(row[spec.value_field])??1):1;f.parts.push(`<line data-role="network-edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${PALETTE.context}" stroke-width="${Math.min(5,Math.max(.7,Math.sqrt(Math.abs(value))))}" stroke-opacity=".48"/>`);}for(const id of layout.ids){const p=layout.pos.get(id),highlighted=(spec.highlight_values??[]).includes(id),r=4.5+(p.degree/maxDegree)*8;f.parts.push(`<circle data-role="network-node" cx="${p.x}" cy="${p.y}" r="${r}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}" stroke="#fff" stroke-width="1.4"/>`);if(layout.ids.length<=24||highlighted)f.parts.push(`<text data-role="direct-label" x="${p.x+(p.x<(left+right)/2?-8:8)}" y="${p.y-7}" text-anchor="${p.x<(left+right)/2?"end":"start"}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9.5:10.5}" font-weight="${highlighted?700:500}" fill="${PALETTE.ink}">${esc(id)}</text>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

function renderAdjacencyMatrix(spec,rows,mobile=false){const ids=unique(rows.flatMap((row)=>[row[spec.source_field],row[spec.target_field]])).sort(),nIds=ids.length,bodyH=Math.max(mobile?360:420,nIds*(mobile?22:25)+100),f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?130:220,top=f.bodyTop+90,size=Math.min((mobile?640:1040)-left-(mobile?38:70),f.bodyBottom-top-25),cell=Math.max(3,size/Math.max(1,nIds)),index=new Map(ids.map((id,i)=>[String(id),i])),values=rows.map((row)=>spec.value_field?(n(row[spec.value_field])??1):1),max=Math.max(...values.map(Math.abs),1),edgeMap=new Map();rows.forEach((row)=>edgeMap.set(`${row[spec.source_field]}\0${row[spec.target_field]}`,spec.value_field?(n(row[spec.value_field])??1):1));ids.forEach((id,i)=>{const y=top+(i+.5)*cell,x=left+(i+.5)*cell;f.parts.push(`<text x="${left-8}" y="${y+3}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.7:9.7}" fill="${PALETTE.ink}">${esc(String(id).length>(mobile?13:19)?String(id).slice(0,mobile?12:18)+"…":id)}</text>`);if(nIds<=28)f.parts.push(`<text x="${x}" y="${top-8}" transform="rotate(-55 ${x} ${top-8})" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.2:9.2}" fill="${PALETTE.muted}">${esc(String(id).length>16?String(id).slice(0,15)+"…":id)}</text>`);});for(const [key,value] of edgeMap){const [a,b]=key.split("\0"),i=index.get(a),j=index.get(b),t=Math.sqrt(Math.abs(value)/max);f.parts.push(`<rect data-role="matrix-cell" x="${left+j*cell+1}" y="${top+i*cell+1}" width="${Math.max(1,cell-2)}" height="${Math.max(1,cell-2)}" fill="${PALETTE.accent2}" fill-opacity="${.12+.78*t}"/>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

function hierarchyLayout(rows,spec){const byId=new Map(rows.map((row)=>[String(row[spec.node_field]),row])),children=new Map(),root=rows.find((row)=>row[spec.parent_field]===null||row[spec.parent_field]===undefined||String(row[spec.parent_field])==="");for(const row of rows){const p=row[spec.parent_field];if(p===null||p===undefined||String(p)==="")continue;const key=String(p);if(!children.has(key))children.set(key,[]);children.get(key).push(String(row[spec.node_field]));}for(const list of children.values())list.sort();const positions=new Map(),levels=[];let leaf=0;const visit=(id,level)=>{if(!levels[level])levels[level]=[];levels[level].push(id);const kids=children.get(id)??[];if(!kids.length){positions.set(id,{leaf:leaf++,level});return positions.get(id).leaf;}const xs=kids.map((kid)=>visit(kid,level+1));const x=xs.reduce((a,b)=>a+b,0)/xs.length;positions.set(id,{leaf:x,level});return x;};if(root)visit(String(root[spec.node_field]),0);return {byId,children,positions,levels,leafCount:Math.max(leaf,1)};}

function renderHierarchyTree(spec,rows,mobile=false){const h=hierarchyLayout(rows,spec),depth=Math.max(...[...h.positions.values()].map((p)=>p.level),0),bodyH=Math.max(mobile?420:410,h.leafCount*(mobile?36:32)+80),f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?70:100,right=mobile?590:940,top=f.bodyTop+28,bottom=f.bodyBottom-28,x=(leaf)=>left+(leaf/(Math.max(1,h.leafCount-1)))*(right-left),y=(level)=>top+(level/Math.max(1,depth))*(bottom-top);for(const [parent,kids] of h.children){const pp=h.positions.get(parent);for(const kid of kids){const kp=h.positions.get(kid);f.parts.push(`<path d="M${x(pp.leaf)},${y(pp.level)} C${x(pp.leaf)},${(y(pp.level)+y(kp.level))/2} ${x(kp.leaf)},${(y(pp.level)+y(kp.level))/2} ${x(kp.leaf)},${y(kp.level)}" fill="none" stroke="${PALETTE.context}" stroke-width="1.5"/>`);}}for(const [id,p] of h.positions){const highlighted=(spec.highlight_values??[]).includes(id);f.parts.push(`<circle cx="${x(p.leaf)}" cy="${y(p.level)}" r="${highlighted?6:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x(p.leaf)}" y="${y(p.level)+(p.level===depth?16:-9)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9:10}" font-weight="${highlighted?700:500}" fill="${PALETTE.ink}">${esc(String(id).length>(mobile?13:18)?String(id).slice(0,mobile?12:17)+"…":id)}</text>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

function timelineValues(rows,spec){const parse=(v)=>{if(typeof v==="number")return v;const d=Date.parse(String(v));return Number.isFinite(d)?d:Number(v);};return rows.map((row)=>({...row,__time:parse(row[spec.x_field])})).filter((row)=>Number.isFinite(row.__time)).sort((a,b)=>a.__time-b.__time);}

function renderTimeline(spec,rows,mobile=false){const sorted=timelineValues(rows,spec);if(mobile){const bodyH=Math.max(390,sorted.length*64+40),f=mobileFrame(spec,bodyH),x=75,top=f.bodyTop+20,bottom=f.bodyBottom-20;f.parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${PALETTE.grid}" stroke-width="2"/>`);sorted.forEach((row,i)=>{const y=top+(i/(Math.max(1,sorted.length-1)))*(bottom-top),highlighted=(spec.highlight_values??[]).includes(String(row[spec.label_field]));f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted?6:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x+18}" y="${y-5}" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" fill="${PALETTE.muted}">${esc(String(row[spec.x_field]))}</text>`);svgTextLines(f.parts,String(row[spec.label_field]),x+18,y+10,{size:11,lineHeight:14,weight:highlighted?700:500,maxChars:50});});addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}const f=frame(spec,390),left=90,right=950,y=(f.bodyTop+f.bodyBottom)/2,min=sorted[0]?.__time??0,max=sorted.at(-1)?.__time??1,scale=(v)=>left+((v-min)/(max-min||1))*(right-left);f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);sorted.forEach((row,i)=>{const x=scale(row.__time),up=i%2===0,highlighted=(spec.highlight_values??[]).includes(String(row[spec.label_field])),stemEnd=y+(up?-42:42),dateY=y+(up?-49:51),eventY=y+(up?-78:72);f.parts.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${stemEnd}" stroke="${PALETTE.context}"/>`);f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted?6:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x}" y="${dateY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="9.8" font-weight="700" fill="${PALETTE.muted}">${esc(String(row[spec.x_field]))}</text>`);svgTextLines(f.parts,String(row[spec.label_field]),x,eventY,{size:10.5,lineHeight:13,weight:highlighted?700:500,maxChars:22,anchor:"middle"});});addFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

function renderStreamgraph(spec,rows,mobile=false){const xs=sortX(unique(rows.map((r)=>r[spec.x_field]))),series=unique(rows.map((r)=>r[spec.series_field])).sort(),index=new Map(rows.map((r)=>[`${r[spec.x_field]}\0${r[spec.series_field]}`,Math.max(0,n(r[spec.value_field])??0)])),totals=xs.map((x)=>series.reduce((sum,ser)=>sum+(index.get(`${x}\0${ser}`)??0),0)),maxTotal=Math.max(...totals,1),bodyH=mobile?380:400,f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?45:85,right=mobile?600:950,top=f.bodyTop+22,bottom=f.bodyBottom-40,xScale=(i)=>xs.length<=1?(left+right)/2:left+(i/(xs.length-1))*(right-left),yScale=(v)=>((v/maxTotal)*(bottom-top)*.82),upper=new Array(xs.length).fill(0);series.forEach((ser,si)=>{const topPts=[],bottomPts=[];xs.forEach((x,xi)=>{const total=totals[xi],baseline=(bottom+top)/2+yScale(total)/2,low=baseline-yScale(upper[xi]),value=index.get(`${x}\0${ser}`)??0,high=low-yScale(value);bottomPts.push(`${xScale(xi)},${low}`);topPts.push(`${xScale(xi)},${high}`);upper[xi]+=value;});const path=[`M${topPts[0]}`,...topPts.slice(1).map((p)=>`L${p}`),...bottomPts.reverse().map((p)=>`L${p}`),"Z"].join(" ");f.parts.push(`<path data-role="stream" d="${path}" fill="${SERIES_COLORS[si%SERIES_COLORS.length]}" fill-opacity=".78" stroke="#fff" stroke-width=".8"/>`);});if(xs.length){f.parts.push(`<text x="${left}" y="${bottom+24}" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(xs[0])}</text>`);f.parts.push(`<text x="${right}" y="${bottom+24}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="${PALETTE.muted}">${esc(xs.at(-1))}</text>`);}let ly=top+4;series.forEach((ser,si)=>{f.parts.push(`<rect x="${right-(mobile?145:175)}" y="${ly-9}" width="9" height="9" fill="${SERIES_COLORS[si%SERIES_COLORS.length]}"/>`);f.parts.push(`<text x="${right-(mobile?132:162)}" y="${ly}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9:10}" fill="${PALETTE.ink}">${esc(String(ser).length>20?String(ser).slice(0,19)+"…":ser)}</text>`);ly+=14;});(mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}


function geoProjection(lon, lat, left, right, top, bottom) {
  const x = left + ((clamp(lon, -180, 180) + 180) / 360) * (right - left);
  const y = bottom - ((clamp(lat, -70, 85) + 70) / 155) * (bottom - top);
  return { x, y };
}

function greatCircleLikePath(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - Math.min(70, Math.hypot(b.x - a.x, b.y - a.y) * 0.16);
  return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
}

function renderGeoFlowMap(spec, rows, mobile=false) {
  const bodyH = mobile ? 390 : 430;
  const f = mobile ? mobileFrame(spec, bodyH) : frame(spec, bodyH);
  const left = mobile ? 42 : 72, right = mobile ? 604 : 968, top = f.bodyTop + 22, bottom = f.bodyBottom - 52;
  f.parts.push(`<rect x="${left}" y="${top}" width="${right-left}" height="${bottom-top}" rx="3" fill="${PALETTE.faint}" stroke="${PALETTE.grid}"/>`);
  for (const lon of [-120,-60,0,60,120]) { const p=geoProjection(lon,0,left,right,top,bottom); f.parts.push(`<line x1="${p.x}" y1="${top}" x2="${p.x}" y2="${bottom}" stroke="#e2e5e8" stroke-width=".8"/>`); }
  for (const lat of [-60,-30,0,30,60]) { const p=geoProjection(0,lat,left,right,top,bottom); f.parts.push(`<line x1="${left}" y1="${p.y}" x2="${right}" y2="${p.y}" stroke="#e2e5e8" stroke-width=".8"/>`); }
  const max = Math.max(...rows.map((row)=>n(row[spec.value_field]) ?? 0), 1);
  const pointLabels = new Map();
  rows.slice().sort((a,b)=>(n(a[spec.value_field])??0)-(n(b[spec.value_field])??0)).forEach((row, i)=>{
    const a=geoProjection(n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),left,right,top,bottom);
    const b=geoProjection(n(row[spec.target_lon_field]),n(row[spec.target_lat_field]),left,right,top,bottom);
    const value=n(row[spec.value_field])??0; if(value<=0)return; const sw=Math.max(1.2,Math.sqrt(value/max)*(mobile?10:14));
    f.parts.push(`<path data-role="geo-flow" d="${greatCircleLikePath(a,b)}" fill="none" stroke="${SERIES_COLORS[i%SERIES_COLORS.length]}" stroke-width="${sw}" stroke-opacity=".5" stroke-linecap="round"/>`);
    f.parts.push(`<circle cx="${a.x}" cy="${a.y}" r="${mobile?3:3.5}" fill="${PALETTE.ink}"/>`);
    f.parts.push(`<circle cx="${b.x}" cy="${b.y}" r="${mobile?3:3.5}" fill="${PALETTE.accent}"/>`);
    if (spec.source_field && row[spec.source_field] !== undefined) pointLabels.set(`s:${row[spec.source_field]}`,{x:a.x,y:a.y,text:String(row[spec.source_field]),anchor:a.x>(left+right)/2?'end':'start'});
    if (spec.target_field && row[spec.target_field] !== undefined) pointLabels.set(`t:${row[spec.target_field]}`,{x:b.x,y:b.y,text:String(row[spec.target_field]),anchor:b.x>(left+right)/2?'end':'start'});
  });
  if (spec.direct_labels !== false && rows.length <= 10) {
    const candidates = rows
      .filter((row)=> (n(row[spec.value_field]) ?? 0) > 0)
      .slice()
      .sort((a,b)=>(n(b[spec.value_field])??0)-(n(a[spec.value_field])??0))
      .slice(0, rows.length > 4 ? 3 : rows.length);
    candidates.forEach((row)=>{const a=geoProjection(n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),left,right,top,bottom),b=geoProjection(n(row[spec.target_lon_field]),n(row[spec.target_lat_field]),left,right,top,bottom),value=n(row[spec.value_field])??0;if(value<=0)return;const lift=Math.min(70,Math.hypot(b.x-a.x,b.y-a.y)*0.16),mx=(a.x+b.x)/2,my=clamp((a.y+b.y)/2-Math.max(20,lift*.5),top+12,bottom-12),label=fmt(value,spec.unit),font=mobile?8.2:9.2,w=Math.max(28,label.length*font*.55+8);f.parts.push(`<rect data-role="geo-value-bg" x="${mx-w/2}" y="${my-font-3}" width="${w}" height="${font+7}" rx="2" fill="#fff" fill-opacity=".8"/>`);f.parts.push(`<text data-role="geo-value" x="${mx}" y="${my}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${font}" font-weight="600" fill="${PALETTE.muted}">${esc(label)}</text>`);});
  }
  if (pointLabels.size <= (mobile?12:18)) {
    const labels=[...pointLabels.values()].map((p)=>({...p,side:p.anchor==='end'?'left':'right'}));
    for(const side of ['left','right']){
      const items=labels.filter((p)=>p.side===side).map((p)=>({...p,y:p.y}));
      const placed=separateLabelBaselines(items,top+10,bottom-8,mobile?12:14);
      for(const p of placed){const label=p.text.length>(mobile?14:20)?p.text.slice(0,mobile?13:19)+'…':p.text,tx=p.x+(side==='left'?-7:7),anchor=side==='left'?'end':'start',font=mobile?8.8:9.8,w=Math.max(24,label.length*font*.56+8),rx=side==='left'?tx-w:tx-3,ry=p.labelY-font-5;if(Math.abs(p.labelY-p.y)>5)f.parts.push(`<line data-role="geo-label-leader" x1="${p.x}" y1="${p.y}" x2="${tx+(side==='left'?3:-3)}" y2="${p.labelY-3}" stroke="${PALETTE.muted}" stroke-width=".7"/>`);f.parts.push(`<rect data-role="geo-label-bg" x="${rx}" y="${ry}" width="${w}" height="${font+7}" rx="2" fill="#fff" fill-opacity=".86"/>`);f.parts.push(`<text data-role="geo-label" x="${tx}" y="${p.labelY-4}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${font}" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);}
    }
  }
  f.parts.push(`<text x="${right}" y="${bottom+22}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.5:9.5}" fill="${PALETTE.muted}">Schematic equirectangular projection; route geometry is approximate</text>`);
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop); f.parts.push('</svg>'); return f.parts.join('\n')+'\n';
}

function parallelSetsLayout(spec, rows, mobile=false) {
  const dims=spec.dimension_fields, weight=(row)=>Math.max(0,n(row[spec.value_field])??0), total=Math.max(rows.reduce((sum,row)=>sum+weight(row),0),1);
  const axisCats=dims.map((field)=>{const totals=new Map();for(const row of rows){const key=String(row[field]);totals.set(key,(totals.get(key)??0)+weight(row));}return [...totals.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));});
  return {dims,weight,total,axisCats};
}

function renderCartographicFlowMap(spec, rows, mobile=false) {
  const bodyH = mobile ? 470 : 540;
  const f = mobile ? mobileFrame(spec, bodyH) : frame(spec, bodyH);
  const left = mobile ? 36 : 60, right = mobile ? 610 : 980, top = f.bodyTop + 20, bottom = f.bodyBottom - 74;
  const routeRows=selectRoutes(rows,spec);
  const trajectoryCache=new Map();
  const extentLines=[];
  for(const row of routeRows){
    if(spec.geometry_semantics==='observed_trajectory'&&spec.trajectory_points_field){
      const pts=parseTrajectoryPoints(row[spec.trajectory_points_field]); trajectoryCache.set(row,pts); const lines=trajectoryLines(pts); if(lines)extentLines.push(...lines);
    }else if(['abstract_od','great_circle_reference'].includes(spec.geometry_semantics)){
      const slon=n(row[spec.source_lon_field]),slat=n(row[spec.source_lat_field]),tlon=n(row[spec.target_lon_field]),tlat=n(row[spec.target_lat_field]);
      if([slon,slat,tlon,tlat].every(v=>v!==null))extentLines.push([[slon,slat],[tlon,tlat]]);
    }else{const lines=parseRouteGeometry(row[spec.route_geometry_field]);if(lines)extentLines.push(...lines);}
  }
  const dataExtent=coordinateExtent(extentLines);
  const project=spec.extent_mode==='data'&&dataExtent?createProjectionForExtent(spec.projection??'natural_earth_1',dataExtent,left,right,top,bottom,Number(spec.extent_padding_ratio??.12),Number(spec.extent_min_span_deg??0)):createProjection(spec.projection??'natural_earth_1',left,right,top,bottom);
  const mapPath=renderBasemapPaths(project,spec.basemap_id), mapMeta=getBasemap(spec.basemap_id), mapFill=mapMeta?.detail_class==='local'?'#e6e9e6':'#d9dedb', markerId=`carto-arrow-${mobile?'m':'d'}`, clipId=`carto-clip-${mobile?'m':'d'}`;
  f.parts.push(`<defs><clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${right-left}" height="${bottom-top}" rx="3"/></clipPath><marker id="${markerId}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3.5 L0,7 z" fill="${PALETTE.muted}"/></marker></defs>`);
  f.parts.push(`<rect data-role="cartographic-ocean" x="${left}" y="${top}" width="${right-left}" height="${bottom-top}" rx="3" fill="#eef2f3" stroke="${PALETTE.grid}"/>`);
  f.parts.push(`<g clip-path="url(#${clipId})"><path data-role="cartographic-basemap" d="${mapPath}" fill="${mapFill}" stroke="#ffffff" stroke-width="${mobile?.55:.7}" stroke-linejoin="round"/>`);
  const max=Math.max(...routeRows.map(row=>n(row[spec.value_field])??0),1),sourceFrequency=new Map(); for(const row of routeRows){if(spec.source_field&&row[spec.source_field]!==undefined){const k=String(row[spec.source_field]);sourceFrequency.set(k,(sourceFrequency.get(k)??0)+1);}}
  const odLayout=spec.geometry_semantics==='abstract_od'?optimizeAbstractOdRoutes(routeRows.map((row,i)=>({index:i,key:`${row[spec.source_field]??''}|${row[spec.target_field]??''}|${i}`,a:project(n(row[spec.source_lon_field]),n(row[spec.source_lat_field])),b:project(n(row[spec.target_lon_field]),n(row[spec.target_lat_field])),value:n(row[spec.value_field])??0})),{left,right,top,bottom}):null;
  const pointLabels=new Map(), categoryIndex=new Map(); let nextCategory=0; const routeInfos=[];
  routeRows.forEach((row,i)=>{
    const value=n(row[spec.value_field])??0;if(value<=0)return; const cat=spec.category_field?String(row[spec.category_field]??'Other'):'flow'; if(!categoryIndex.has(cat))categoryIndex.set(cat,nextCategory++); const color=SERIES_COLORS[categoryIndex.get(cat)%SERIES_COLORS.length];
    let sw=Math.max(1.05,Math.sqrt(value/max)*(mobile?8.5:12.5)),d='',a=null,b=null,mid=null,lines=null,points=null;
    if(spec.geometry_semantics==='abstract_od'){const layout=odLayout[i];a=layout.item.a;b=layout.item.b;d=layout.d;mid=layout.mid;}
    else if(spec.geometry_semantics==='great_circle_reference'){lines=[greatCirclePoints(n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),n(row[spec.target_lon_field]),n(row[spec.target_lat_field]),mobile?20:32)];d=projectedPolylinePath(lines,project,(right-left)*.55);a=project(lines[0][0][0],lines[0][0][1]);const last=lines[0][lines[0].length-1];b=project(last[0],last[1]);const m=lines[0][Math.floor(lines[0].length/2)];mid=project(m[0],m[1]);}
    else {points=spec.geometry_semantics==='observed_trajectory'&&spec.trajectory_points_field?trajectoryCache.get(row):null;lines=points?trajectoryLines(points):parseRouteGeometry(row[spec.route_geometry_field]);if(!validRouteGeometry(lines))return;d=projectedPolylinePath(lines,project,(right-left)*.55);const first=lines[0][0],lastLine=lines[lines.length-1],last=lastLine[lastLine.length-1];a=project(first[0],first[1]);b=project(last[0],last[1]);const line=lines[Math.floor(lines.length/2)],m=line[Math.floor(line.length/2)];mid=project(m[0],m[1]);if(spec.geometry_semantics==='observed_trajectory')sw=mobile?2.8:3.4;}
    if(spec.geometry_semantics==='observed_trajectory'&&spec.reference_path==='great_circle'&&lines){const first=lines[0][0],lastLine=lines[lines.length-1],last=lastLine[lastLine.length-1],ref=[greatCirclePoints(first[0],first[1],last[0],last[1],40)],rd=projectedPolylinePath(ref,project,(right-left)*.55);f.parts.push(`<path data-role="cartographic-reference" d="${rd}" fill="none" stroke="${PALETTE.ink}" stroke-width="${mobile?1:1.25}" stroke-opacity=".42" stroke-dasharray="5 5"/>`);}
    const opacity=spec.geometry_semantics==='observed_trajectory'?.88:spec.geometry_semantics==='verified_route'?.7:.6;
    const flowKey = spec.flow_id_field && row[spec.flow_id_field] !== undefined
      ? String(row[spec.flow_id_field])
      : `${String(row[spec.source_field] ?? '')}→${String(row[spec.target_field] ?? '')}`;
    const layerKey = spec.flow_layer_field && row[spec.flow_layer_field] !== undefined ? String(row[spec.flow_layer_field]) : '';
    const flowAttrs = `data-flow-key="${esc(flowKey)}"${layerKey ? ` data-flow-layer="${esc(layerKey)}"` : ''}`;
    // Keep the visible stroke editorially thin while giving pointer/touch users
    // a generous target, following the B3 big-threads interaction contract.
    f.parts.push(`<path data-role="cartographic-flow" ${flowAttrs} data-geometry-semantics="${esc(spec.geometry_semantics)}" d="${d}" fill="none" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none" marker-end="url(#${markerId})"/>`);
    f.parts.push(`<path data-role="cartographic-hit" ${flowAttrs} d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(12, sw * 3).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" pointer-events="stroke"/>`);
    if(points&&points.length){const markerPoints=[{p:points[0],label:'coverage starts'},...points.filter((p,j)=>j>0&&p.segment!==points[j-1].segment).map(p=>({p,label:'coverage resumes'})),{p:points[points.length-1],label:points[points.length-1].altitude_ft===0?'ground / coverage ends':'coverage ends'}];const maxAlt=points.reduce((best,p)=>Number(p.altitude_ft)>Number(best.altitude_ft)?p:best,points[0]);if(maxAlt&&Number(maxAlt.altitude_ft)>0)markerPoints.splice(markerPoints.length-1,0,{p:maxAlt,label:`${Math.round(Number(maxAlt.altitude_ft)).toLocaleString('en-US')} ft`});for(const [mi,item] of markerPoints.entries()){const q=project(item.p.lon,item.p.lat),anchor=q.x>(left+right)/2?'end':'start',tx=q.x+(anchor==='end'?-7:7),ty=q.y+(mi%2?12:-8);f.parts.push(`<circle data-role="trajectory-marker" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${mobile?2.4:2.8}" fill="#fff" stroke="${color}" stroke-width="1.5"/><text data-role="trajectory-marker-label" x="${tx.toFixed(1)}" y="${clamp(ty,top+10,bottom-4).toFixed(1)}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?7.5:8.7}" font-weight="700" fill="${PALETTE.ink}">${esc(item.label)}</text>`);}}
    if(a)f.parts.push(`<circle data-role="cartographic-origin" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="${mobile?2.6:3.2}" fill="${PALETTE.ink}"/>`); if(b)f.parts.push(`<circle data-role="cartographic-destination" cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${mobile?2.9:3.5}" fill="${PALETTE.accent}"/>`);
    const routeLength=a&&b?Math.hypot(b.x-a.x,b.y-a.y):Infinity,sourceKey=spec.source_field&&row[spec.source_field]!==undefined?String(row[spec.source_field]):'',valueAtSource=routeLength<(mobile?105:145)&&sourceKey&&(sourceFrequency.get(sourceKey)??0)===1;
    if(spec.source_field&&a&&row[spec.source_field]!==undefined){const text=valueAtSource?`${sourceKey} · ${fmt(value,'')}`:sourceKey;pointLabels.set(`s:${sourceKey}`,{...a,text,anchor:a.x>(left+right)/2?'end':'start'});} if(spec.target_field&&b&&row[spec.target_field]!==undefined)pointLabels.set(`t:${row[spec.target_field]}`,{...b,text:String(row[spec.target_field]),anchor:b.x>(left+right)/2?'end':'start'}); routeInfos.push({row,value,color,mid,routeLength,valueAtSource});
  });
  f.parts.push('</g>');
  if(spec.direct_labels!==false&&spec.geometry_semantics!=='observed_trajectory'){routeInfos.slice().sort((a,b)=>b.value-a.value).filter(info=>!info.valueAtSource).slice(0,mobile?2:3).forEach(info=>{if(!info.mid)return;const label=fmt(info.value,spec.unit),font=mobile?8.2:9.2,w=Math.max(30,label.length*font*.56+9),x=clamp(info.mid.x,left+w/2+2,right-w/2-2),y=clamp(info.mid.y,top+font+5,bottom-4);f.parts.push(`<rect data-role="cartographic-value-bg" pointer-events="none" x="${(x-w/2).toFixed(1)}" y="${(y-font-4).toFixed(1)}" width="${w.toFixed(1)}" height="${(font+7).toFixed(1)}" rx="2" fill="#fff" fill-opacity=".88"/><text data-role="cartographic-value" pointer-events="none" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);});}
  if(pointLabels.size<= (mobile?10:16)){const labels=[...pointLabels.values()].map(p=>({...p,side:p.anchor==='end'?'left':'right'}));for(const side of ['left','right']){const placed=separateLabelBaselines(labels.filter(p=>p.side===side),top+10,bottom-8,mobile?12:14);for(const p of placed){const label=p.text.length>(mobile?15:28)?p.text.slice(0,mobile?14:27)+'…':p.text,tx=p.x+(side==='left'?-7:7),anchor=side==='left'?'end':'start',font=mobile?8.5:9.5,w=Math.max(25,label.length*font*.56+8),rx=side==='left'?tx-w:tx-3,ry=p.labelY-font-6;if(Math.abs(p.labelY-p.y)>5)f.parts.push(`<line data-role="cartographic-label-leader" pointer-events="none" x1="${p.x}" y1="${p.y}" x2="${tx+(side==='left'?3:-3)}" y2="${p.labelY-3}" stroke="${PALETTE.muted}" stroke-width=".7"/>`);f.parts.push(`<rect data-role="cartographic-label-bg" pointer-events="none" x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${w.toFixed(1)}" height="${(font+8).toFixed(1)}" rx="2" fill="#fff" fill-opacity=".82"/><text data-role="cartographic-label" pointer-events="none" x="${tx}" y="${p.labelY-4}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);}}}
  if(spec.locator_inset&&dataExtent){const iw=mobile?112:150,ih=mobile?66:88,ix=right-iw-8,iy=top+8,ip=createProjection(spec.projection??'natural_earth_1',ix+4,ix+iw-4,iy+4,iy+ih-4),world=renderBasemapPaths(ip,spec.basemap_id),nw=ip(dataExtent.west,dataExtent.north),se=ip(dataExtent.east,dataExtent.south);f.parts.push(`<g data-role="cartographic-locator"><rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="3" fill="#fff" fill-opacity=".92" stroke="${PALETTE.grid}"/><path d="${world}" fill="#e3e7e5" stroke="#fff" stroke-width=".25"/><rect x="${Math.min(nw.x,se.x).toFixed(1)}" y="${Math.min(nw.y,se.y).toFixed(1)}" width="${Math.max(3,Math.abs(se.x-nw.x)).toFixed(1)}" height="${Math.max(3,Math.abs(se.y-nw.y)).toFixed(1)}" fill="none" stroke="${PALETTE.accent}" stroke-width="1.2"/></g>`);}
  const keyY=bottom+18; f.parts.push(`<g data-role="cartographic-direction-key"><circle cx="${left}" cy="${keyY-3}" r="3" fill="${PALETTE.ink}"/><text x="${left+7}" y="${keyY}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?7.8:8.8}" fill="${PALETTE.muted}">origin / observed start</text><text x="${left+(mobile?110:130)}" y="${keyY}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?7.8:8.8}" fill="${PALETTE.muted}">→</text><circle cx="${left+(mobile?124:146)}" cy="${keyY-3}" r="3" fill="${PALETTE.accent}"/><text x="${left+(mobile?131:153)}" y="${keyY}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?7.8:8.8}" fill="${PALETTE.muted}">destination / observed end</text></g>`);
  const disclosure=geometryDisclosure(spec.geometry_semantics,spec.route_provenance_note??''); f.parts.push(`<text data-role="cartographic-disclosure" x="${right}" y="${bottom+40}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.1:9.1}" font-weight="600" fill="${PALETTE.muted}">${esc(disclosure.length>(mobile?92:132)?disclosure.slice(0,mobile?91:131)+'…':disclosure)}</text>`);
  f.parts.push(`<text data-role="cartographic-projection" x="${left}" y="${bottom+40}" text-anchor="start" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?7.8:8.8}" fill="${PALETTE.muted}">${esc(getBasemap(spec.basemap_id)?.label??spec.basemap_id)} · ${spec.extent_mode==='data'?'data-fitted extent':'world extent'}</text>`);
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function renderTrajectoryProfile(spec,rows,mobile=false){
  const bodyH=mobile?520:500,f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?64:96,right=mobile?602:950,top=f.bodyTop+24,bottom=f.bodyBottom-48,gap=mobile?54:58,panelH=(bottom-top-gap)/2;
  const sorted=rows.slice().sort((a,b)=>(n(a[spec.x_field])??0)-(n(b[spec.x_field])??0)),xs=sorted.map(r=>n(r[spec.x_field])).filter(v=>v!==null),alts=sorted.map(r=>n(r[spec.altitude_field])).filter(v=>v!==null),speeds=sorted.map(r=>n(r[spec.speed_field])).filter(v=>v!==null);
  const xMin=Math.min(0,...xs),xMax=Math.max(...xs),xDomain=xMax>xMin?[xMin,xMax]:[xMin,xMin+1],xScale=horizontalScale(xDomain,left,right),altDomain=[0,Math.max(1,...alts)*1.06],speedDomain=[0,Math.max(1,...speeds)*1.08],altY=verticalScale(altDomain,top,top+panelH),speedTop=top+panelH+gap,speedY=verticalScale(speedDomain,speedTop,speedTop+panelH);
  const transitions=[];for(let i=1;i<sorted.length;i++)if(String(sorted[i][spec.segment_field])!==String(sorted[i-1][spec.segment_field]))transitions.push({a:sorted[i-1],b:sorted[i]});
  for(const tr of transitions){const x1=xScale(n(tr.a[spec.x_field])),x2=xScale(n(tr.b[spec.x_field])),w=Math.max(2,x2-x1),mins=(n(tr.b[spec.x_field])-n(tr.a[spec.x_field]));f.parts.push(`<rect data-role="trajectory-gap" x="${x1.toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${(bottom-top).toFixed(1)}" fill="#f3eee9" fill-opacity=".78"/><text data-role="trajectory-gap-label" x="${((x1+x2)/2).toFixed(1)}" y="${(top+13).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8:9}" font-weight="700" fill="${PALETTE.muted}">${esc(`${Math.round(mins)} min source gap`)}</text>`);}
  function panel(label,domain,yScale,y0,field,color,unit){for(const tick of tickValues(domain,4)){const y=yScale(tick);f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1"/><text x="${left-10}" y="${y+4}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9:10}" fill="${PALETTE.muted}">${esc(fmt(tick,unit))}</text>`);}f.parts.push(`<text x="${left}" y="${y0-8}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?10:11}" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);const groups=[];for(const row of sorted){let g=groups.at(-1);if(!g||String(g.segment)!==String(row[spec.segment_field])){g={segment:row[spec.segment_field],rows:[]};groups.push(g);}if(n(row[field])!==null)g.rows.push(row);}for(const g of groups){if(g.rows.length<2)continue;const coords=g.rows.map(r=>`${xScale(n(r[spec.x_field])).toFixed(1)},${yScale(n(r[field])).toFixed(1)}`).join(' ');f.parts.push(`<polyline data-role="trajectory-profile-line" fill="none" stroke="${color}" stroke-width="${mobile?2.2:2.7}" points="${coords}"/>`);g.rows.forEach(r=>f.parts.push(`<circle cx="${xScale(n(r[spec.x_field])).toFixed(1)}" cy="${yScale(n(r[field])).toFixed(1)}" r="${mobile?2:2.4}" fill="${color}"/>`));}const last=sorted.filter(r=>n(r[field])!==null).at(-1);if(last)f.parts.push(`<text data-role="direct-label" x="${(xScale(n(last[spec.x_field]))-5).toFixed(1)}" y="${(yScale(n(last[field]))-8).toFixed(1)}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.5:9.5}" font-weight="700" fill="${color}">${esc(fmt(n(last[field]),unit))}</text>`);}
  panel('Pressure altitude',altDomain,altY,top,spec.altitude_field,PALETTE.accent2,spec.altitude_unit??'ft');panel('Ground speed',speedDomain,speedY,speedTop,spec.speed_field,PALETTE.accent,spec.speed_unit??'kt');
  for(const tick of tickValues(xDomain,4)){const x=xScale(tick);f.parts.push(`<line x1="${x}" y1="${speedTop+panelH}" x2="${x}" y2="${speedTop+panelH+4}" stroke="${PALETTE.muted}"/><text x="${x}" y="${speedTop+panelH+20}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9:10}" fill="${PALETTE.muted}">${esc(`${Math.round(tick)} min`)}</text>`);}f.parts.push(`<text x="${(left+right)/2}" y="${speedTop+panelH+37}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.5:9.5}" fill="${PALETTE.muted}">elapsed time since observed coverage begins</text>`);
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function renderParallelSets(spec, rows, mobile=false) {
  const model=parallelSetsLayout(spec,rows,mobile), bodyH=Math.max(mobile?460:430,Math.max(...model.axisCats.map((x)=>x.length),1)*(mobile?34:31)+130),f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH);
  const width=mobile?640:1040,left=mobile?64:86,right=width-(mobile?64:86),top=f.bodyTop+48,bottom=f.bodyBottom-28,axisGap=(right-left)/Math.max(1,model.dims.length-1),gap=mobile?7:8,positions=[];
  model.axisCats.forEach((cats,axis)=>{const available=bottom-top-gap*Math.max(0,cats.length-1);let y=top;const map=new Map();for(const [cat,total] of cats){const h=Math.max(5,(total/model.total)*available);map.set(cat,{x:left+axis*axisGap,y,h,total});y+=h+gap;}positions.push(map);});
  for(let axis=0;axis<model.dims.length-1;axis++){
    const sourceOffsets=new Map(),targetOffsets=new Map();const groups=new Map();for(const row of rows){const a=String(row[model.dims[axis]]),b=String(row[model.dims[axis+1]]),key=`${a}\0${b}`,v=model.weight(row);if(v>0)groups.set(key,(groups.get(key)??0)+v);}const max=Math.max(...groups.values(),1);let ci=0;
    for(const [key,v] of [...groups.entries()].sort((a,b)=>b[1]-a[1])){const [a,b]=key.split('\0'),pa=positions[axis].get(a),pb=positions[axis+1].get(b);if(!pa||!pb)continue;const scaleA=pa.h/Math.max(pa.total,1),scaleB=pb.h/Math.max(pb.total,1),oa=sourceOffsets.get(a)??0,ob=targetOffsets.get(b)??0,hA=Math.max(1,v*scaleA),hB=Math.max(1,v*scaleB),y1=pa.y+oa+hA/2,y2=pb.y+ob+hB/2;sourceOffsets.set(a,oa+hA);targetOffsets.set(b,ob+hB);const sw=Math.max(1.2,Math.min(hA,hB));f.parts.push(`<path data-role="parallel-ribbon" d="${sankeyPath(pa.x+7,y1,pb.x-7,y2)}" fill="none" stroke="${SERIES_COLORS[ci++%SERIES_COLORS.length]}" stroke-width="${sw}" stroke-opacity=".42"/>`);}
  }
  model.axisCats.forEach((cats,axis)=>{const x=left+axis*axisGap;f.parts.push(`<text x="${x}" y="${top-20}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9.5:10.5}" font-weight="700" fill="${PALETTE.muted}">${esc(model.dims[axis])}</text>`);for(const [cat] of cats){const p=positions[axis].get(cat);f.parts.push(`<rect data-role="parallel-node" x="${x-7}" y="${p.y}" width="14" height="${p.h}" rx="2" fill="${PALETTE.ink}" opacity=".84"/>`);const label=cat.length>(mobile?13:18)?cat.slice(0,mobile?12:17)+'…':cat,side=axis===model.axisCats.length-1?'left':axis===0?'right':axis%2===1?'left':'right',anchor=side==='left'?'end':'start',lx=x+(side==='left'?-11:11),font=mobile?8.2:9.2,w=Math.max(22,label.length*font*.56+7),rx=side==='left'?lx-w:lx-3,ry=p.y+p.h/2-font/2-3;f.parts.push(`<rect data-role="parallel-label-bg" x="${rx}" y="${ry}" width="${w}" height="${font+7}" rx="2" fill="#fff" fill-opacity=".82"/>`);f.parts.push(`<text data-role="parallel-label" x="${lx}" y="${p.y+p.h/2+3}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${font}" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);}});
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function polar(cx,cy,r,a){return{x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r};}
function arcPath(cx,cy,r,a0,a1){const p0=polar(cx,cy,r,a0),p1=polar(cx,cy,r,a1),large=a1-a0>Math.PI?1:0;return`M${p0.x},${p0.y} A${r},${r} 0 ${large} 1 ${p1.x},${p1.y}`;}

function renderChord(spec, rows, mobile=false) {
  const ids=unique(rows.flatMap((row)=>[row[spec.source_field],row[spec.target_field]])).sort(), totals=new Map(ids.map((id)=>[id,0]));for(const row of rows){const v=Math.max(0,n(row[spec.value_field])??0);totals.set(String(row[spec.source_field]),(totals.get(String(row[spec.source_field]))??0)+v);totals.set(String(row[spec.target_field]),(totals.get(String(row[spec.target_field]))??0)+v);}const grand=Math.max([...totals.values()].reduce((a,b)=>a+b,0),1),f=mobile?mobileFrame(spec,470):frame(spec,470),cx=mobile?320:520,cy=(f.bodyTop+f.bodyBottom)/2+8,r=mobile?170:190,gap=.025,angles=new Map();let angle=-Math.PI/2;for(const id of ids){const span=(Math.PI*2-gap*ids.length)*(totals.get(id)/grand);angles.set(id,{a0:angle,a1:angle+span,mid:angle+span/2});angle+=span+gap;}const max=Math.max(...rows.map((row)=>n(row[spec.value_field])??0),1);let i=0;for(const row of rows){const a=angles.get(String(row[spec.source_field])),b=angles.get(String(row[spec.target_field]));if(!a||!b)continue;const p1=polar(cx,cy,r-8,a.mid),p2=polar(cx,cy,r-8,b.mid),v=n(row[spec.value_field])??0;if(v<=0)continue;const sw=Math.max(1.2,Math.sqrt(v/max)*(mobile?18:23));f.parts.push(`<path data-role="chord-ribbon" d="M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}" fill="none" stroke="${SERIES_COLORS[i++%SERIES_COLORS.length]}" stroke-width="${sw}" stroke-opacity=".42" stroke-linecap="round"/>`);}for(let j=0;j<ids.length;j++){const id=ids[j],a=angles.get(id),highlighted=(spec.highlight_values??[]).includes(id);f.parts.push(`<path data-role="chord-arc" d="${arcPath(cx,cy,r,a.a0,a.a1)}" fill="none" stroke="${highlighted?PALETTE.accent:PALETTE.ink}" stroke-width="${mobile?12:14}"/>`);const p=polar(cx,cy,r+(mobile?18:22),a.mid),anchor=Math.cos(a.mid)>.18?'start':Math.cos(a.mid)<-.18?'end':'middle';f.parts.push(`<text x="${p.x}" y="${p.y+3}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.8:10}" font-weight="${highlighted?700:500}" fill="${PALETTE.ink}">${esc(id.length>(mobile?13:18)?id.slice(0,mobile?12:17)+'…':id)}</text>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function processLayout(rows,spec){const pseudo=rows.map((row)=>({[spec.source_field]:row[spec.source_field],[spec.target_field]:row[spec.target_field],__value:1})),flowSpec={source_field:spec.source_field,target_field:spec.target_field,value_field:'__value',chart_type:'process_schematic'},layout=flowLayout(pseudo,flowSpec);return layout;}

function renderProcessSchematic(spec,rows,mobile=false){
  const layout=processLayout(rows,spec),maxPerLevel=Math.max(...layout.levels.map((level)=>level.length),1),desktopBody=Math.max(230,maxPerLevel*82+100),mobileBody=Math.max(430,(layout.maxLevel+1)*115),f=mobile?mobileFrame(spec,mobileBody):frame(spec,desktopBody),width=mobile?640:1040,left=mobile?60:80,right=width-(mobile?60:80),top=f.bodyTop+28,bottom=f.bodyBottom-28,positions=new Map();
  if(mobile){layout.levels.forEach((level,li)=>{const y=top+(li/Math.max(1,layout.maxLevel))*(bottom-top),gap=(right-left)/Math.max(1,level.length);level.forEach((node,i)=>positions.set(node.id,{x:left+gap*(i+.5),y}));});}
  else{layout.levels.forEach((level,li)=>{const x=left+(li/Math.max(1,layout.maxLevel))*(right-left),gap=(bottom-top)/Math.max(1,level.length);level.forEach((node,i)=>positions.set(node.id,{x,y:top+gap*(i+.5)}));});}
  const horizontalStep=(right-left)/Math.max(1,layout.maxLevel),boxW=mobile?120:Math.min(132,Math.max(94,horizontalStep*.72)),boxH=mobile?44:50;
  f.parts.push(`<defs><marker id="proc-arrow-${mobile?'m':'d'}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${PALETTE.context}"/></marker></defs>`);
  for(const row of rows){const a=positions.get(String(row[spec.source_field])),b=positions.get(String(row[spec.target_field]));if(!a||!b)continue;const x1=mobile?a.x:a.x+boxW/2,y1=mobile?a.y+boxH/2:a.y,x2=mobile?b.x:b.x-boxW/2,y2=mobile?b.y-boxH/2:b.y,mid=mobile?(y1+y2)/2:(x1+x2)/2,path=mobile?`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`:`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;f.parts.push(`<path data-role="process-edge" d="${path}" fill="none" stroke="${PALETTE.context}" stroke-width="1.8" marker-end="url(#proc-arrow-${mobile?'m':'d'})"/>`);const edgeGap=mobile?Math.abs(y2-y1)-boxH:Math.abs(x2-x1)-boxW;if(spec.edge_label_field&&row[spec.edge_label_field]&&edgeGap>(mobile?34:42)){const sourceId=String(row[spec.source_field]),sourceLevel=layout.nodes.get(sourceId)?.level??0,vertical=mobile&&Math.abs(x2-x1)<2;let lx=(x1+x2)/2,ly=(y1+y2)/2-(mobile?10:8);if(mobile&&sourceLevel===0){lx=x1+(x2-x1)*.34+(vertical?-55:0);ly=y1+(y2-y1)*.34-7;}else if(mobile&&vertical){lx=x1+58;}const text=String(row[spec.edge_label_field]),maxChars=mobile?16:18,lines=wrapText(text,maxChars).slice(0,2),startY=ly-(lines.length-1)*4.5;lines.forEach((line,i)=>f.parts.push(`<text data-role="process-edge-label" x="${lx}" y="${startY+i*9.5}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?8.3:8.8}" font-weight="600" fill="${PALETTE.muted}">${esc(line)}</text>`));}}
  for(const [id,p] of positions){const highlighted=(spec.highlight_values??[]).includes(id);f.parts.push(`<rect data-role="process-node" x="${p.x-boxW/2}" y="${p.y-boxH/2}" width="${boxW}" height="${boxH}" rx="6" fill="${highlighted?PALETTE.accent:PALETTE.faint}" stroke="${highlighted?PALETTE.accent:PALETTE.context}" stroke-width="1.3"/>`);const lines=wrapText(id,mobile?16:16).slice(0,2);lines.forEach((line,i)=>f.parts.push(`<text x="${p.x}" y="${p.y-(lines.length-1)*6+i*12+4}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mobile?9.3:9.8}" font-weight="${highlighted?700:600}" fill="${highlighted?'#fff':PALETTE.ink}">${esc(line)}</text>`));}
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

export function renderVizMobileSvg(spec, rows) {
  const errors=validateVizSpec(spec); if(errors.length) throw new Error(errors.join("; "));
  switch(spec.chart_type){
    case "horizontal_bar": return renderMobileHorizontal(spec,rows,"bar");
    case "dot": return renderMobileHorizontal(spec,rows,"dot");
    case "diverging_bar": return renderMobileHorizontal(spec,rows,"bar");
    case "dumbbell": return renderMobileDumbbell(spec,rows);
    case "slope": return renderMobileSlope(spec,rows);
    case "line": return renderMobileLine(spec,rows,false);
    case "multi_line": return renderMobileLine(spec,rows,true);
    case "small_multiples": return renderMobileSmallMultiples(spec,rows);
    case "scatter": return renderMobileScatter(spec,rows);
    case "heatmap": return renderMobileHeatmap(spec,rows);
    case "sankey": return renderSankey(spec,rows,true);
    case "alluvial": return renderSankey(spec,rows,true);
    case "node_link": return renderNodeLink(spec,rows,true);
    case "adjacency_matrix": return renderAdjacencyMatrix(spec,rows,true);
    case "hierarchy_tree": return renderHierarchyTree(spec,rows,true);
    case "timeline": return renderTimeline(spec,rows,true);
    case "streamgraph": return renderStreamgraph(spec,rows,true);
    case "parallel_sets": return renderParallelSets(spec,rows,true);
    case "chord": return renderChord(spec,rows,true);
    case "geo_flow_map": return renderGeoFlowMap(spec,rows,true);
    case "cartographic_flow_map": return renderCartographicFlowMap(spec,rows,true);
    case "trajectory_profile": return renderTrajectoryProfile(spec,rows,true);
    case "process_schematic": return renderProcessSchematic(spec,rows,true);
    default: throw new Error(`Mobile renderer does not support '${spec.chart_type}'`);
  }
}

export function renderVizBundle(spec, rows) {
  return { desktop: renderVizSvg(spec, rows), mobile: renderVizMobileSvg(spec, rows) };
}

export function renderVizSvg(spec, rows) {
  const errors = validateVizSpec(spec);
  if (errors.length) throw new Error(errors.join("; "));
  switch (spec.chart_type) {
    case "horizontal_bar": return renderHorizontal(spec, rows, "bar");
    case "dot": return renderHorizontal(spec, rows, "dot");
    case "diverging_bar": return renderHorizontal(spec, rows, "bar");
    case "dumbbell": return renderDumbbell(spec, rows);
    case "slope": return renderSlope(spec, rows);
    case "line": return renderLine(spec, rows, false);
    case "multi_line": return renderLine(spec, rows, true);
    case "small_multiples": return renderSmallMultiples(spec, rows);
    case "scatter": return renderScatter(spec, rows);
    case "heatmap": return renderHeatmap(spec, rows);
    case "sankey": return renderSankey(spec, rows, false);
    case "alluvial": return renderSankey(spec, rows, false);
    case "node_link": return renderNodeLink(spec, rows, false);
    case "adjacency_matrix": return renderAdjacencyMatrix(spec, rows, false);
    case "hierarchy_tree": return renderHierarchyTree(spec, rows, false);
    case "timeline": return renderTimeline(spec, rows, false);
    case "streamgraph": return renderStreamgraph(spec, rows, false);
    case "parallel_sets": return renderParallelSets(spec, rows, false);
    case "chord": return renderChord(spec, rows, false);
    case "geo_flow_map": return renderGeoFlowMap(spec, rows, false);
    case "cartographic_flow_map": return renderCartographicFlowMap(spec, rows, false);
    case "trajectory_profile": return renderTrajectoryProfile(spec, rows, false);
    case "process_schematic": return renderProcessSchematic(spec, rows, false);
    default: throw new Error(`Renderer does not support '${spec.chart_type}'`);
  }
}
