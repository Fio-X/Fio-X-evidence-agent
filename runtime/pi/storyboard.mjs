import { numberWordIn } from "./number_words.mjs";
// NEWSROOM_STORYBOARD=1 (exact "1", default off): the storyboard page - 4 to 8 numbered panels, each one number, one title
// sentence, one main body module (hero_stat, visual or illustration), one short note (a text module) and the colours it uses.
// With the switch off none of this is accepted and nothing here changes a rendered byte.
//
// Pure helpers, no imports besides the number-word check. infographic.mjs calls them from validate/lint and expands the panels
// into ordinary modules (a section_header per panel, then its body and note) before layout, so every existing gate sees the
// same modules it always saw.

export function storyboardEnabled() {
  return process.env.NEWSROOM_STORYBOARD === "1";
}

export const PANEL_MIN = 4;
export const PANEL_MAX = 8;
// Inferences, not sourced numbers (fb spec 1012 section 3.2 and 3.4): the title length and the per-panel height cap are tunable.
export const PANEL_TITLE_MAX = { zh: 20, en: 80 };
export const PANEL_HEIGHT_CAP = 560;
export const PANEL_HEADER_HEIGHT = 70;
// Per-panel body room (px at the real 1248px page width), recomputed from the rendered size rather than one flat number: an ordinary body
// (big number, illustration, a chart that fits) has PANEL_HEIGHT_CAP - PANEL_HEADER_HEIGHT; a chart whose own SVG is taller (wave, clock, state
// tiles, dot matrix) gets the larger of its native height and the height the layout really gives it (moduleHeight, whose own 12px font floor
// can stretch a chart past its native size), up to PANEL_CHART_HARD_CAP. A chart with no asset at hand is held to PANEL_UNKNOWN_CHART_ALLOW.
// Inferences like the cap above: a recomputation from real sizes, not a relaxation.
export const PANEL_BODY_ALLOW = PANEL_HEIGHT_CAP - PANEL_HEADER_HEIGHT;
export const PANEL_UNKNOWN_CHART_ALLOW = 900;
// The most one chart may take in a panel. Measured, not guessed: native height at the 1248px page width (SVG ratio x 1248 + the 36px label
// strip), our story chart types rendered with synthetic data: people_dots 611, clock_dial 798 (969 for the day clock in the K256 run),
// state-tile map (tile_map) 983 (999 in the K256 run), wave 752, state tiles 856, choropleth 899. The tallest is the tile map at about 999;
// 1100 leaves about 10% over it. tile_map and clock_dial draw tall by themselves; whether to compress them is left to the batch-fix list.
export const PANEL_CHART_HARD_CAP = 1100;
// A panel's note has a fixed room of this many body lines (its height comes from the layout's own text measure, see infographic.mjs); a longer
// note still counts at its real height in the page total, so it eats into the room instead of growing it.
export const PANEL_NOTE_LINES = 3;
export const PANEL_BODY_TYPES = ["hero_stat", "visual", "illustration"];
export const PANEL_KINDS = ["lead_in", "scale", "cause", "space", "compare", "basis"];
export const NEUTRAL_COLORS = ["paper", "ink", "grid"];
// storyboard pages carry the panels plus their bodies and notes; the ordinary cap of 12 modules cannot hold 8 panels.
export const STORYBOARD_MODULE_CAP = PANEL_MAX * 3;

export const isPanel = (module) => module?.type === "panel";
export const panelsOf = (spec) => (spec?.modules ?? []).filter(isPanel);
export const hasPanels = (spec) => panelsOf(spec).length > 0;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** #rgb and #rrggbb to lower-case #rrggbb; a neutral name stays as is; anything else is null. */
export function normColor(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (NEUTRAL_COLORS.includes(text)) return text;
  if (!HEX.test(text)) return null;
  return text.length === 4 ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}` : text;
}

/** Shape errors of one panel module (validateInfographicSpec); the page rules are storyboardBlockers. */
export function panelFieldErrors(module) {
  const id = module?.id ?? "?";
  const errors = [];
  if (!storyboardEnabled()) return [`STORYBOARD_DISABLED: module '${id}' is a panel; the storyboard layout is switched off`];
  if (!Number.isInteger(module.panel_no) || module.panel_no < 1) errors.push(`panel '${id}' requires panel_no, an integer from 1`);
  if (!String(module.heading ?? "").trim()) errors.push(`panel '${id}' requires heading, its one title sentence`);
  if (!String(module.body_module_id ?? "").trim()) errors.push(`panel '${id}' requires body_module_id`);
  if (!String(module.note_module_id ?? "").trim()) errors.push(`panel '${id}' requires note_module_id`);
  if (!Array.isArray(module.story_node_ids) || module.story_node_ids.length === 0) errors.push(`panel '${id}' requires story_node_ids`);
  if (module.panel_kind !== undefined && !PANEL_KINDS.includes(module.panel_kind)) errors.push(`panel '${id}' panel_kind must be one of ${PANEL_KINDS.join(", ")}`);
  if (!Array.isArray(module.color_use)) errors.push(`panel '${id}' requires color_use, the list of colours its body draws with (can be empty)`);
  return errors;
}

/** Shape errors of the page-level storyboard fields. */
export function storyboardPageErrors(spec) {
  const errors = [];
  if (spec.color_legend !== undefined || spec.render_style !== undefined) {
    if (!storyboardEnabled()) return [`STORYBOARD_DISABLED: ${["color_legend", "render_style"].filter((k) => spec[k] !== undefined).join(", ")} (storyboard) is switched off`];
  }
  if (spec.render_style !== undefined && !/^[a-z][a-z0-9_-]{0,30}$/.test(String(spec.render_style))) errors.push("render_style must be a style id such as 'pencil' (lower case letters, digits, - and _)");
  return errors;
}

/** One sentence: at most one terminator, and only at the end. */
function oneSentence(text) {
  const body = String(text).trim().replace(/[。！？!?.]$/, "");
  return !/[。！？!?；;]|\.\s/.test(body);
}

/**
 * Page rules for a storyboard page, add-only. storyGraph is optional (its node order is the story order); heightOf(module) is
 * optional (the layout's own module height at full width).
 */
export function storyboardBlockers(spec, storyGraph = null, heightOf = null, nativeOf = null, noteAllow = null) {
  const out = [];
  const panels = panelsOf(spec);
  if (!panels.length) return out;
  const lang = spec.language === "en" ? "en" : "zh";
  const byId = new Map((spec.modules ?? []).map((m) => [String(m.id), m]));
  const sorted = [...panels].sort((a, b) => (a.panel_no ?? 0) - (b.panel_no ?? 0));

  if (panels.length < PANEL_MIN || panels.length > PANEL_MAX) out.push(`storyboard_panel_count: ${panels.length} panels; a storyboard page has ${PANEL_MIN} to ${PANEL_MAX}`);
  // 1 numbering: 1..N, no gap, no repeat
  if (!sorted.every((p, i) => p.panel_no === i + 1)) out.push(`storyboard_numbering: panel_no must run 1..${panels.length} with no gap and no repeat; got ${sorted.map((p) => p.panel_no).join(", ")}`);
  // numbering follows the story: the first story node of each panel never goes back
  if (storyGraph && Array.isArray(storyGraph.nodes)) {
    const index = new Map(storyGraph.nodes.map((n, i) => [String(n.id), i]));
    let last = -1;
    for (const p of sorted) {
      const at = (p.story_node_ids ?? []).map((id) => index.get(String(id))).filter((i) => i !== undefined);
      if (!at.length) continue;
      const first = Math.min(...at);
      if (first < last) out.push(`storyboard_story_order: panel ${p.panel_no} ('${p.id}') comes from an earlier story node than panel ${p.panel_no - 1}; number the panels in story_node order`);
      last = Math.max(last, first);
    }
  }
  // 2 lead-in first, basis last
  const kinds = (kind) => sorted.filter((p) => p.panel_kind === kind);
  if (kinds("lead_in").length !== 1 || sorted[0]?.panel_kind !== "lead_in") out.push("storyboard_lead_in: exactly one panel has panel_kind 'lead_in' and it is panel 1");
  if (kinds("basis").length !== 1 || sorted[sorted.length - 1]?.panel_kind !== "basis") out.push("storyboard_basis: exactly one panel has panel_kind 'basis' and it is the last panel");
  // 3 one title sentence per panel, no number word
  for (const p of sorted) {
    const title = String(p.heading ?? "").trim();
    if (!title) continue;
    if (!oneSentence(title)) out.push(`storyboard_title_sentences: panel ${p.panel_no} ('${p.id}') heading must be exactly one sentence`);
    if ([...title].length > PANEL_TITLE_MAX[lang]) out.push(`storyboard_title_length: panel ${p.panel_no} ('${p.id}') heading is over ${PANEL_TITLE_MAX[lang]} characters`);
    const near = numberWordIn(title);
    if (near !== null) out.push(`storyboard_title_number_word: panel ${p.panel_no} ('${p.id}') heading has a number word (near "${near}"); numbers on the page come from rows, not from the title`);
  }
  // 4 body and note: real modules, each in one panel only
  const used = new Map();
  for (const p of sorted) {
    for (const [field, types] of [["body_module_id", PANEL_BODY_TYPES], ["note_module_id", ["text"]]]) {
      const target = byId.get(String(p[field] ?? ""));
      if (!target) { out.push(`storyboard_panel_refs: panel '${p.id}' ${field} '${p[field] ?? ""}' is not a module of the page`); continue; }
      if (!types.includes(target.type)) out.push(`storyboard_panel_refs: panel '${p.id}' ${field} '${target.id}' is a ${target.type}; expected ${types.join(" or ")}`);
      if (used.has(target.id)) out.push(`storyboard_panel_refs: module '${target.id}' belongs to panels '${used.get(target.id)}' and '${p.id}'; one panel each`);
      else used.set(target.id, p.id);
    }
  }
  // 5 one colour, one meaning
  const legend = Array.isArray(spec.color_legend) ? spec.color_legend : null;
  const meaningOf = new Map();
  if (!legend || !legend.length) out.push("storyboard_color_legend: color_legend (a list of {color, meaning_id}) is required on a storyboard page");
  else {
    for (const entry of legend) {
      const color = normColor(entry?.color), meaning = String(entry?.meaning_id ?? "").trim();
      if (!color || NEUTRAL_COLORS.includes(color)) { out.push(`storyboard_color_legend: color '${entry?.color}' must be a hex colour such as #d0746f (paper, ink and grid need no entry)`); continue; }
      if (!meaning) { out.push(`storyboard_color_legend: color ${color} has no meaning_id`); continue; }
      if (meaningOf.has(color) && meaningOf.get(color) !== meaning) out.push(`storyboard_one_color_one_meaning: color ${color} is registered for '${meaningOf.get(color)}' and for '${meaning}'; one colour carries one meaning`);
      else meaningOf.set(color, meaning);
    }
    for (const p of sorted) {
      for (const raw of p.color_use ?? []) {
        const color = normColor(raw);
        if (!color) out.push(`storyboard_color_use: panel '${p.id}' lists '${raw}', which is neither a hex colour nor one of ${NEUTRAL_COLORS.join(", ")}`);
        else if (!NEUTRAL_COLORS.includes(color) && !meaningOf.has(color)) out.push(`storyboard_color_use: panel '${p.id}' draws with ${color}, which color_legend does not register; give it a meaning_id`);
      }
    }
  }
  // 6 page height (cap is an inference). With nativeOf (the real SVG height of a chart body at page width, or null without an asset) the cap
  // is added up panel by panel; without it, the flat per-panel cap.
  if (heightOf) {
    let total = 0, cap = 0, flat = true;
    for (const p of sorted) {
      const body = byId.get(String(p.body_module_id)), note = byId.get(String(p.note_module_id));
      const bodyH = body ? heightOf(body) : 0, noteH = note ? heightOf(note) : 0;
      total += bodyH + noteH + PANEL_HEADER_HEIGHT;
      if (!nativeOf) { cap += PANEL_HEIGHT_CAP; continue; }
      flat = false;
      let allow = PANEL_BODY_ALLOW;
      if (body?.type === "visual") {
        const native = nativeOf(body);
        if (native === null || native === undefined) allow = PANEL_UNKNOWN_CHART_ALLOW;
        else {
          const room = Math.max(native, bodyH);
          if (room > PANEL_CHART_HARD_CAP) out.push(`storyboard_panel_chart_height: panel '${p.id}' chart '${body.id}' needs ${Math.round(room)} px at page width; a panel chart is at most ${PANEL_CHART_HARD_CAP} px (one chart per panel)`);
          else allow = Math.max(PANEL_BODY_ALLOW, room);
        }
      }
      cap += PANEL_HEADER_HEIGHT + allow + (noteAllow ?? 0);
    }
    if (total > cap) out.push(flat
      ? `storyboard_page_height: the panels need about ${Math.round(total)} px; the cap is ${cap} px (${PANEL_HEIGHT_CAP} per panel)`
      : `storyboard_page_height: the panels need about ${Math.round(total)} px; the cap is ${Math.round(cap)} px (each panel: ${PANEL_HEADER_HEIGHT} header + its chart's own height, at least ${PANEL_BODY_ALLOW}, + a note of ${PANEL_NOTE_LINES} lines)`);
  }
  return out;
}

/**
 * K249: one drawing style per page. Every chart plan on the page carries the same page_render_style (the page default, passed
 * to the renderer as spec.page_render_style; a chart's own render_style still wins there) and the page plan's render_style
 * must equal it. chartStyles is [{id, style}] with style undefined when the chart plan has none.
 */
export function pageStyleBlockers(pageStyle, chartStyles) {
  const out = [];
  const given = (chartStyles ?? []).filter((c) => c.style !== undefined && c.style !== null && c.style !== "");
  const distinct = [...new Set(given.map((c) => String(c.style)))];
  if (distinct.length > 1) out.push(`storyboard_page_style: the charts carry different page_render_style values (${given.map((c) => `${c.id}=${c.style}`).join(", ")}); one page, one style`);
  const page = pageStyle === undefined || pageStyle === null || pageStyle === "" ? undefined : String(pageStyle);
  if (distinct.length === 1) {
    const missing = (chartStyles ?? []).filter((c) => !given.includes(c)).map((c) => c.id);
    if (missing.length) out.push(`storyboard_page_style: chart plans ${missing.join(", ")} carry no page_render_style while others carry '${distinct[0]}'; plan every chart with the page style`);
    if (page !== distinct[0]) out.push(`storyboard_page_style: the page plan render_style is ${page === undefined ? "missing" : `'${page}'`} but its charts carry page_render_style '${distinct[0]}'; they must be the same`);
  } else if (distinct.length === 0 && page !== undefined && page !== "house" && (chartStyles ?? []).length) {
    out.push(`storyboard_page_style: the page plan render_style is '${page}' but no chart plan carries page_render_style; the charts are drawn before the page, so each chart plan must carry it`);
  }
  return out;
}

/** Storyboard off: a chart plan's page_render_style is dropped before rendering, so the renderer never sees it. */
export function withoutPageStyleWhenOff(spec) {
  if (storyboardEnabled() || !spec || spec.page_render_style === undefined) return spec;
  const { page_render_style: _dropped, ...rest } = spec;
  return rest;
}

/** The page's default render style for a visual (its own render_style wins). */
export function renderStyleFor(spec, module) {
  return module?.render_style ?? spec?.render_style ?? null;
}

/** Panels become ordinary modules: a numbered section_header, the body, the note. Page style becomes each visual's default. */
export function expandPanels(spec) {
  if (!storyboardEnabled() || !hasPanels(spec)) return spec;
  const byId = new Map((spec.modules ?? []).map((m) => [String(m.id), m]));
  const taken = new Set();
  const modules = [];
  const bodyOf = (m) => (m.type === "visual" && spec.render_style && m.render_style === undefined ? { ...m, render_style: spec.render_style } : m);
  const ordered = panelsOf(spec).sort((a, b) => (a.panel_no ?? 0) - (b.panel_no ?? 0));
  for (const p of ordered) {
    modules.push({ id: `${p.id}-title`, type: "section_header", span: "full", eyebrow: String(p.panel_no), heading: p.heading });
    for (const id of [p.body_module_id, p.note_module_id]) {
      const m = byId.get(String(id));
      if (m && !taken.has(m.id)) { taken.add(m.id); modules.push(bodyOf({ ...m, span: "full" })); }
    }
  }
  for (const m of spec.modules ?? []) if (!isPanel(m) && !taken.has(m.id)) modules.push(bodyOf(m));
  return { ...spec, modules };
}

// ---- Lean gates (K258, NEWSROOM_LEAN_GATES=1): the scene graph of a storyboard page is derived from its panels ----------------
// One scene per panel whose body is a visual or an illustration: that body is the anchor and hero, the panel's note is the one
// sidecar. A hero_stat body cannot anchor a scene (the scene check wants a visual or illustration), so that panel has no scene.
// The cognitive goal follows the panel kind (a judgement, pinned by tests): lead_in ORIENT, scale and basis MEASURE, cause EXPLAIN,
// space and compare COMPARE (a space panel's chart sets places side by side); a panel with no kind gets EXPLAIN. EXPLAIN is kept only for
// a mechanism chart body (see panelSceneGoal).
// scripts/verify_artifact.py derives the same graph again (derive_scene_graph) and must agree.
export const PANEL_SCENE_GOALS = Object.freeze({ lead_in: "ORIENT", scale: "MEASURE", cause: "EXPLAIN", space: "COMPARE", compare: "COMPARE", basis: "MEASURE" });
export const PANEL_SCENE_DEFAULT_GOAL = "EXPLAIN";
// EXPLAIN is offered only by grammars that need a process or causal relation (CUTAWAY, MECHANISM_FLOW), so a panel gets it only when
// its body chart is a mechanism chart (visual_grammar 'mechanism', the process_or_causal_relation evidence). Any other body falls to a
// goal by its visual grammar: composition / comparison charts COMPARE, magnitude / change / place charts MEASURE; no grammar (an
// illustration) MEASURE. Judgement pinned by tests/test_lean_panel_goals.mjs; verify_artifact.py mirrors the table.
export const EXPLAIN_EVIDENCE_GRAMMARS = Object.freeze(["mechanism"]);
export const EXPLAIN_FALLBACK_GOALS = Object.freeze({ composition: "COMPARE", rank: "COMPARE", benchmark: "COMPARE", distribution: "COMPARE", spatial: "COMPARE", change: "MEASURE", trend: "MEASURE", sequence: "MEASURE", flow: "MEASURE" });
export const EXPLAIN_FALLBACK_DEFAULT = "MEASURE";
export function panelSceneGoal(panelKind, body) {
  const goal = PANEL_SCENE_GOALS[panelKind] ?? PANEL_SCENE_DEFAULT_GOAL;
  if (goal !== "EXPLAIN" || EXPLAIN_EVIDENCE_GRAMMARS.includes(String(body?.visual_grammar))) return goal;
  return EXPLAIN_FALLBACK_GOALS[String(body?.visual_grammar)] ?? EXPLAIN_FALLBACK_DEFAULT;
}
export const PANEL_SCENE_MAX = 6;
const moduleClaimIds = (m) => [...new Set([m?.claim_id, ...(m?.claim_ids ?? []), ...(m?.claim_set ?? [])].filter(Boolean).map(String))];

/** {scene_graph, errors}: scene_graph is null when errors is not empty. */
export function deriveSceneGraphFromPanels(spec) {
  const errors = [];
  const byId = new Map((spec?.modules ?? []).map((m) => [String(m.id), m]));
  const scenes = [];
  const ordered = panelsOf(spec).sort((a, b) => (a.panel_no ?? 0) - (b.panel_no ?? 0) || String(a.id).localeCompare(String(b.id)));
  for (const p of ordered) {
    const body = byId.get(String(p.body_module_id ?? "")), note = byId.get(String(p.note_module_id ?? ""));
    if (!body || !note) { errors.push(`panel '${p.id}' body_module_id or note_module_id is not a module of the page, so no scene can be derived`); continue; }
    if (!["visual", "illustration"].includes(body.type)) continue;
    const members = [body, note];
    const claims = [...new Set(members.flatMap(moduleClaimIds))];
    scenes.push({
      id: `scene-${p.id}`,
      pattern: "hero_with_rail",
      anchor_module_id: String(body.id),
      sidecar_module_ids: [String(note.id)],
      primary_cognitive_goal: panelSceneGoal(p.panel_kind, body),
      hero_object_id: String(body.id),
      supporting_claim_ids: moduleClaimIds(body),
      scene_budget: {
        max_supporting_objects: 1,
        max_annotations: Math.min(8, members.reduce((n, m) => n + (m.annotations ?? []).length, 0)),
        max_claims: Math.min(12, Math.max(1, claims.length)),
      },
    });
  }
  if (!errors.length && !scenes.length) errors.push("no panel has a visual or illustration body, so there is no scene to derive; a scene needs one");
  if (scenes.length > PANEL_SCENE_MAX) errors.push(`${scenes.length} panels have a visual or illustration body; a scene graph holds at most ${PANEL_SCENE_MAX} scenes`);
  return errors.length ? { scene_graph: null, errors } : { scene_graph: { schema_version: "0.2.0", scenes }, errors };
}

/** The plan params of a lean storyboard page with the derived scene_graph put in; one the model wrote is refused. */
export function withDerivedSceneGraph(params) {
  if (params.scene_graph !== undefined) throw new Error("scene_graph 由格子生成: on a storyboard page (NEWSROOM_LEAN_GATES=1) the runtime builds the scene graph from the panels; leave scene_graph out");
  const derived = deriveSceneGraphFromPanels(params);
  if (!derived.scene_graph) throw new Error(`scene_graph 由格子生成, and it cannot be built from these panels: ${derived.errors.join("; ")}`);
  return { ...params, scene_graph: derived.scene_graph };
}
