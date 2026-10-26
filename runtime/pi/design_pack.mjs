// design pack (NEWSROOM_SPEED_DESIGN_PACK=1, default off): the program runs the design tools in order and drafts the
// design-stage text; the model hands in the judgement fields once and, after it has seen the page, keeps or rewrites the drafts.
// Pure: every tool call, artifact read and number fill comes in through `deps`, so the tests run it with fake tools.
// Rules it keeps:
//   - every tool runs through its own execute with all its checks; nothing here writes an artifact;
//   - a drafted number is a placeholder filled from the chart's own result rows by the claim filler; a model word with a
//     number in it is not copied; text the model writes goes through the same filler, so typed digits and number words are refused;
//   - a direction word that disagrees with the filled first and last values is refused, with the filled text echoed;
//   - a refused step is reported, never retried with changed parameters, and nothing in a Fact, Claim, SQL or Evidence is changed;
//   - the pack never says the page is complete: the model still has to look at it and call the vision critic.
// No imports: the number-word rule (knowledge group) comes in from newsroom.ts, so the cross-group ratchet sees the use there.

/** The only fields the pack drafts. Anything else is the model's. */
export const DRAFT_FIELDS = Object.freeze({
  chart: Object.freeze(["takeaway", "source_note", "title", "alt"]),
  page: Object.freeze(["title", "dek", "alt"]),
  page_module: Object.freeze(["heading", "alt", "body"]),
  publication_module: Object.freeze(["accessibility_summary", "accessibility_long_description", "text"]),
});

/** viz_plan chart_type -> how the publication page shows it. A chart type not listed is refused; nothing
 *  defaults to "statistical", and no row produces plotly with a map_ref. */
export const PUBLICATION_TYPES = Object.freeze({
  horizontal_bar: Object.freeze({ type: "static_svg" }),
  dot: Object.freeze({ type: "static_svg" }),
  line: Object.freeze({ type: "static_svg" }),
  choropleth: Object.freeze({ type: "static_svg" }),
  sankey: Object.freeze({ type: "plotly", engine: "plotly", visual_type: "sankey", mapping: Object.freeze({ source: "source_field", target: "target_field", value: "value_field" }) }),
});

/** Chart types with a drafting template. Any other chart type is not drafted. */
export const TEMPLATE_CHART_TYPES = Object.freeze(["horizontal_bar", "dot", "line", "choropleth"]);

/** NEWSROOM_NEXT=1 only (`deps.next`): the template rows, one per chart type the shape registry (src/shape_registry.rs) can pick. This is the one
 *  frozen list; the registry's Rust test reads it through node. A row names its relation (a claim_spec.relation value), the plan fields the program
 *  fills from the slice's columns, and any value the chart type fixes (a 100% stacked bar draws shares, so its unit is "%"). A pick may name the
 *  category's code scheme (category_names, checked by the viz tool); a map must. A ranking row (`ranked`) draws its bars high to low with the
 *  top and the bottom one in the accent (sort "desc", highlight_values from the series rows). With the switch off,
 *  TEMPLATE_CHART_TYPES and PUBLICATION_TYPES are the tables, unchanged. */
export const NEXT_TEMPLATE_ROWS = Object.freeze({
  horizontal_bar: Object.freeze({ relation: "rank", fields: Object.freeze(["category_field", "value_field"]), ranked: true }),
  dot: Object.freeze({ relation: "rank", fields: Object.freeze(["category_field", "value_field"]), ranked: true }),
  line: Object.freeze({ relation: "trend", fields: Object.freeze(["category_field", "value_field"]) }),
  choropleth: Object.freeze({ relation: "geography", fields: Object.freeze(["category_field", "value_field"]), names: "required" }),
  sankey: Object.freeze({ relation: "flow", fields: Object.freeze(["source_field", "target_field", "value_field"]) }),
  stacked_bar_100: Object.freeze({ relation: "composition", fields: Object.freeze(["category_field", "series_field", "value_field"]), fixed: Object.freeze({ unit: "%" }) }),
});
export const NEXT_TEMPLATE_CHART_TYPES = Object.freeze(Object.keys(NEXT_TEMPLATE_ROWS));
export const NEXT_PUBLICATION_TYPES = Object.freeze({ ...PUBLICATION_TYPES, stacked_bar_100: Object.freeze({ type: "static_svg" }) });
const templateTypes = (next) => (next ? NEXT_TEMPLATE_CHART_TYPES : TEMPLATE_CHART_TYPES);

const LIMITS = Object.freeze({ chart_title: 40, page_title: 40, dek: 120, body: 140, alt: 260, summary: 140, long: 600 });
export const MAX_SUBMISSIONS = 3;
export const MAX_REVISIONS = 2;
/** Page build: patches (patch_of + ops) the pack takes for a refused page plan, in one run. */
export const MAX_PATCHES = 4;
/** The kind the page plan carries, which the audit knows it by. */
const PAGE_PLAN_KIND = "infographic_plan";
/** Page build: the page-plan fields the program fills from the run's own artifacts; a different value from the model is refused, not overwritten. */
export const PROGRAM_PAGE_KEYS = Object.freeze(["story_graph_ref", "editorial_discovery_ref", "visual_concept_ref", "selected_concept_id", "novelty_ref", "asset_plan_ref"]);
export const PROGRAM_MODULE_KEYS = Object.freeze(["manifest_ref", "critic_ref", "claim_id"]);

export const DIRECTION_WORDS = Object.freeze({
  up: Object.freeze(["上升", "增加", "增长", "走高", "攀升", "回升", "上涨"]),
  down: Object.freeze(["下降", "减少", "下滑", "回落", "走低", "下跌"]),
  flat: Object.freeze(["持平", "基本不变"]),
});
const DIRECTION_ZH = { up: "上升", down: "下降", flat: "持平" };
const DIRECTION_EN = { up: "rose", down: "fell", flat: "held about level" };

/** A digit or a number word (`numberWordIn` is the claim filler's own number-word rule, passed in). */
export function hasNumber(text, numberWordIn) {
  const value = String(text ?? "");
  return /\p{Nd}/u.test(value) || numberWordIn(value) !== null;
}

/** Sign of last - first; within 1% of |first| is flat. Null when either value is not a finite number. */
export function directionOf(first, last) {
  const a = Number(first), b = Number(last);
  if (first === null || last === null || first === undefined || last === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const delta = b - a;
  if (a === 0 ? delta === 0 : Math.abs(delta) / Math.abs(a) < 0.01) return "flat";
  return delta > 0 ? "up" : "down";
}

/** The direction classes whose words appear in the text. Known gaps, not covered: negations ("no longer rising"), comparisons with the
 *  previous period ("more than last period"), and piecewise descriptions ("falls, then rises"), which the first/last rule may refuse. */
export function directionWordsIn(text) {
  const value = String(text ?? "");
  const found = new Set();
  for (const [kind, words] of Object.entries(DIRECTION_WORDS)) if (words.some((word) => value.includes(word))) found.add(kind);
  return [...found];
}

/** A refusal message when the text names a direction other than `expected`, echoing the filled text; null otherwise. */
export function directionProblem(filledText, expected) {
  if (!expected) return null;
  const wrong = directionWordsIn(filledText).filter((kind) => kind !== expected);
  if (!wrong.length) return null;
  return `DESIGN_PACK_DIRECTION: the text says ${wrong.map((kind) => DIRECTION_ZH[kind]).join("/")} but the filled values go ${DIRECTION_ZH[expected]} (last vs first row, 1% counts as level). Filled text: "${filledText}"`;
}

const clip = (text, limit) => [...String(text ?? "")].length <= limit ? String(text ?? "") : null;
const firstSentence = (text) => String(text ?? "").split(/(?<=[。！？.!?])/u)[0].trim();
const firstClause = (text) => String(text ?? "").split(/[，,；;。.!?！？]/u)[0].trim();

function measureOf(plan) {
  const measures = Array.isArray(plan?.measure_semantics) ? plan.measure_semantics : [];
  return measures.find((measure) => measure?.field && measure.field === plan.value_field) ?? measures[0] ?? null;
}

/** A chart type's name, for the types with a drafting template on this route only. */
function chartName(chartType, zh, types = TEMPLATE_CHART_TYPES) {
  if (!types.includes(chartType)) return null;
  const names = zh
    ? { horizontal_bar: "条形图", dot: "圆点图", line: "折线图", choropleth: "地图", sankey: "桑基图", stacked_bar_100: "百分比堆积条形图" }
    : { horizontal_bar: "Bar chart", dot: "Dot chart", line: "Line chart", choropleth: "Map", sankey: "Sankey diagram", stacked_bar_100: "Stacked share bar chart" };
  return names[chartType] ?? null;
}

/** Times are evenly spaced, ascending numbers or ISO dates, at least three of them. */
export function evenlySpaced(values) {
  if (!Array.isArray(values) || values.length < 3) return false;
  const numbers = values.map((value) => {
    if (typeof value === "number") return value;
    const text = String(value ?? "").trim();
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    const time = /^\d{4}-\d{2}(-\d{2})?/.test(text) ? Date.parse(text.length === 7 ? `${text}-01` : text) : NaN;
    return time;
  });
  if (numbers.some((number) => !Number.isFinite(number))) return false;
  const step = numbers[1] - numbers[0];
  if (!(step > 0)) return false;
  // Months and years are not equal in milliseconds; allow 4 days of slack for dates.
  const slack = Math.abs(step) > 86_400_000 ? 4 * 86_400_000 : 1e-9;
  return numbers.every((number, index) => index === 0 || Math.abs(number - numbers[index - 1] - step) <= slack);
}

/** The text before the SQL runs: title from the model's own measure words (dropped when they hold a number), and the L1 line.
 *  `types` is the list with drafting templates (NEXT_TEMPLATE_CHART_TYPES on the new route). */
export function draftBeforeRows(plan, numberWordIn, types = TEMPLATE_CHART_TYPES) {
  const zh = plan?.language !== "en";
  const out = {};
  const measure = measureOf(plan);
  const phenomenon = String(measure?.phenomenon ?? "").trim();
  const scope = String(measure?.scope ?? "").trim();
  if (phenomenon && !hasNumber(phenomenon, numberWordIn)) {
    const withScope = Boolean(scope) && !hasNumber(scope, numberWordIn);
    const full = withScope ? `${phenomenon}${zh ? "：" : ": "}${scope}` : phenomenon;
    const whole = clip(full, LIMITS.chart_title);
    const title = whole ?? clip(phenomenon, LIMITS.chart_title);
    if (title) out.title = { text: title, origin: "copied_model_text", from: withScope && whole !== null ? ["measure_semantics.phenomenon", "measure_semantics.scope"] : ["measure_semantics.phenomenon"] };
  }
  const l1 = l1Line(plan, zh, types);
  if (l1 && !hasNumber(l1, numberWordIn)) out.l1 = l1;
  return out;
}

function l1Line(plan, zh, types) {
  const type = String(plan?.chart_type ?? "");
  const name = chartName(type, zh, types);
  if (!name) return null;
  const value = String(measureOf(plan)?.phenomenon ?? plan?.value_field ?? "").trim();
  const category = String(plan?.category_field ?? "").trim();
  const time = String(plan?.time_field ?? "").trim();
  if (type === "sankey") {
    const source = String(plan?.source_field ?? "").trim(), target = String(plan?.target_field ?? "").trim();
    return source && target && value ? (zh ? `${name}，从${source}流向${target}，线宽为${value}` : `${name} of ${value} from ${source} to ${target}`) : null;
  }
  if (type === "stacked_bar_100") {
    const series = String(plan?.series_field ?? "").trim();
    return category && series && value ? (zh ? `${name}，每个${category}一条，按${series}分段，段长为占${value}的比例` : `${name}: one bar for each ${category}, split by ${series} into shares of ${value}`) : null;
  }
  if (type === "line") return time && value ? (zh ? `${name}，${time}对${value}` : `${name} of ${value} by ${time}`) : null;
  if (type === "choropleth") return category && value ? (zh ? `${name}，按${category}着色，色值为${value}` : `${name} shaded by ${value} for each ${category}`) : null;
  return category && value ? (zh ? `${name}，按${category}列出${value}` : `${name} of ${value} for each ${category}`) : null;
}

/** Templates with placeholders over the chart's own rows (L2, and L3 for an evenly spaced time series). A sankey names its largest link;
 *  a stacked share bar its largest and smallest segment. */
export function rowTemplates(plan, rows, numberWordIn, types = TEMPLATE_CHART_TYPES) {
  const zh = plan?.language !== "en";
  const type = String(plan?.chart_type ?? "");
  if (!types.includes(type)) return null;
  const value = String(plan?.value_field ?? "").trim();
  if (!value) return null;
  if (type === "sankey") {
    const source = String(plan?.source_field ?? "").trim(), target = String(plan?.target_field ?? "").trim();
    if (!source || !target) return null;
    const l2 = zh
      ? `最大一股：{max.${value}.${source}}到{max.${value}.${target}}（{max.${value}}）`
      : `Largest flow: {max.${value}.${source}} to {max.${value}.${target}} ({max.${value}})`;
    return { l2, l3: null, direction: null };
  }
  if (type === "stacked_bar_100") {
    const category = String(plan?.category_field ?? "").trim(), series = String(plan?.series_field ?? "").trim();
    if (!category || !series) return null;
    const l2 = zh
      ? `占比最高：{max.${value}.${category}}的{max.${value}.${series}}（{max.${value}}），最低：{min.${value}.${category}}的{min.${value}.${series}}（{min.${value}}）`
      : `Largest share: {max.${value}.${series}} in {max.${value}.${category}} ({max.${value}}); smallest: {min.${value}.${series}} in {min.${value}.${category}} ({min.${value}})`;
    return { l2, l3: null, direction: null };
  }
  const label = type === "line" ? String(plan?.time_field ?? "").trim() : String(plan?.category_field ?? "").trim();
  if (!label) return null;
  const l2 = zh
    ? `最高：{max.${value}.${label}}（{max.${value}}），最低：{min.${value}.${label}}（{min.${value}}）`
    : `Highest: {max.${value}.${label}} ({max.${value}}); lowest: {min.${value}.${label}} ({min.${value}})`;
  const out = { l2, l3: null, direction: null };
  if (type === "line" && Array.isArray(rows) && evenlySpaced(rows.map((row) => row?.[label]))) {
    const direction = directionOf(rows[0]?.[value], rows[rows.length - 1]?.[value]);
    if (direction) {
      const measure = String(measureOf(plan)?.phenomenon ?? "").trim();
      const subject = measure && !hasNumber(measure, numberWordIn) ? measure : "";
      out.direction = direction;
      out.l3 = zh
        ? `从{first.${label}}到{last.${label}}，${subject}${DIRECTION_ZH[direction]}，最高在{max.${value}.${label}}`
        : `From {first.${label}} to {last.${label}}${subject ? ` ${subject}` : ""} ${DIRECTION_EN[direction]}, peaking in {max.${value}.${label}}`;
    }
  }
  return out;
}

/** The publication module for a chart, by the table only. Throws for a chart type with no publication counterpart. */
export function publicationModuleFor(plan, refs, table = PUBLICATION_TYPES) {
  const type = String(plan?.chart_type ?? "");
  const row = Object.prototype.hasOwnProperty.call(table, type) ? table[type] : null;
  if (!row) throw new Error(`DESIGN_PACK_NO_PUBLICATION_TYPE: chart type '${type}' has no publication counterpart (known: ${Object.keys(table).join(", ")}); the pack does not fall back to a statistical chart`);
  if (row.type === "static_svg") {
    if (!refs?.desktopSvgRef) throw new Error(`DESIGN_PACK_NO_PUBLICATION_TYPE: chart type '${type}' publishes its rendered SVG, but the visualization manifest has no desktop variant`);
    return { type: "static_svg", asset_ref: refs.desktopSvgRef };
  }
  const mapping = {};
  for (const [key, field] of Object.entries(row.mapping)) {
    const column = String(plan?.[field] ?? "").trim();
    if (!column) throw new Error(`DESIGN_PACK_NO_PUBLICATION_TYPE: chart type '${type}' publishes as plotly ${row.visual_type}, which needs the plan's ${field}`);
    mapping[key] = column;
  }
  return { type: row.type, engine: row.engine, visual_type: row.visual_type, computation_ref: refs.computationRef, field_mapping_json: JSON.stringify(mapping) };
}

const CHART_DRAFT_KEYS = new Set(DRAFT_FIELDS.chart);
const PUBLICATION_TABLE_KEYS = ["type", "engine", "visual_type", "asset_ref", "computation_ref", "field_mapping_json", "view_spec_json", "map_ref"];

function textResultOf(result) {
  return (Array.isArray(result?.content) ? result.content : []).filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n");
}
// A stopped chain: its code and step, then the chain's own report (every executed step's text) so the model sees what to fix.
function chainStopText(outcome) {
  const head = `${outcome.code ?? "STOPPED"} at ${outcome.failedAt ?? "?"}: ${outcome.message ?? ""}`;
  return outcome.report ? `${head}\n${outcome.report}` : head;
}

/** Model text for a drafted field: "=" keeps the draft; anything else goes through the claim filler over `rows` (typed digits,
 *  number words and bad placeholders are refused there) and the direction check. Returns {text, audit} or {problem}. */
async function modelText(deps, path, value, ctx) {
  if (value === "=") return null;
  if (typeof value !== "string" || !value.trim()) return { problem: `${path}: write "=" to keep the draft or the new text` };
  if (!ctx.rows?.length) {
    // No rows to fill from (a page field before any chart has rows): plain text only.
    if (/[{}]/.test(value)) return { problem: `${path}: there are no result rows here to fill a placeholder from` };
    if (hasNumber(value, deps.numberWordIn)) return { problem: `${path}: every number must be a placeholder over a chart's result rows; this field has none, so write it without numbers` };
    return { text: value, audit: { path, origin: "model", rewritten: true, template: value, bindings: [] } };
  }
  let filled;
  try { filled = await deps.fill(value, ctx.rows, ctx.plan, ctx.names); } catch (error) { return { problem: `${path}: ${error?.message ?? error}` }; }
  const direction = directionProblem(filled.text, ctx.direction);
  if (direction) return { problem: `${path}: ${direction}` };
  return { text: filled.text, audit: { path, origin: "model", rewritten: true, template: value, computation_ref: ctx.computationRef ?? null, bindings: filled.bindings, direction: ctx.direction ?? null } };
}

/** Fill a drafted template; a template the filler refuses (a tie, a missing column) leaves the field undrafted, with the reason. */
async function drafted(deps, path, template, ctx, extra = {}) {
  try {
    const filled = await deps.fill(template, ctx.rows, ctx.plan, ctx.names);
    return { text: filled.text, audit: { path, origin: "placeholder", template, computation_ref: ctx.computationRef ?? null, bindings: filled.bindings, direction: extra.direction ?? null } };
  } catch (error) {
    return { skipped: `${path}: not drafted (${String(error?.message ?? error).replace(/^CLAIM_TEMPLATE_ERROR: /, "")})` };
  }
}

// ---- what a refused step tells the model: the sub-tool's own field table, read from its schema (never copied by hand) ----
const HINT_LIMIT = 1600;
const typeText = (schema, depth) => {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map(String).join(" | ")}`;
  if (schema.type === "array") {
    const range = schema.minItems !== undefined || schema.maxItems !== undefined ? ` (${schema.minItems ?? 0}-${schema.maxItems ?? "any"} items)` : "";
    return `array of ${typeText(schema.items, depth + 1)}${range}`;
  }
  if (schema.type === "object" && schema.properties) return depth >= 2 ? "object" : `{${fieldsText(schema, depth + 1)}}`;
  return String(schema.type ?? "any");
};
const fieldsText = (schema, depth) => {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties ?? {}).map(([name, field]) => `${name}${required.has(name) ? "" : "?"}: ${typeText(field, depth)}`).join("; ");
};

/** A minimal value that satisfies a schema: first enum value, "..." for text, one item per array, required fields only. */
export function exampleOf(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "array") return Array.from({ length: Math.max(1, Number(schema.minItems) || 1) }, () => exampleOf(schema.items));
  if (schema.type === "object") {
    const out = {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) out[name] = exampleOf(schema.properties?.[name]);
    return out;
  }
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  return "...";
}

/** The sentence a refused sub-tool step carries after its own message: its fields with the allowed values, and one shape that passes the type check.
 *  Empty when the tool has no object schema. Text only: it changes nothing about what is accepted. */
export function schemaHint(tool, schema) {
  if (!schema || schema.type !== "object" || !schema.properties) return "";
  const fields = fieldsText(schema, 0);
  const example = JSON.stringify(exampleOf(schema));
  const text = `\nFields of ${tool} (from its own schema; a name ending in ? is optional): ${fields}\nOne shape that passes the type check: ${example}`;
  return text.length > HINT_LIMIT ? `${text.slice(0, HINT_LIMIT)} ...` : text;
}

/** A sub-tool's own parameter schema as the pack takes it: the named fields dropped (the pack supplies them) and the named fields made optional (the pack
 *  defaults them). Plain JSON-schema copy, so the pack's table can never drift from the sub-tool's. Null when the sub-tool has no object schema. */
export function derivedSchema(schema, { omit = [], optional = [] } = {}) {
  if (!schema || schema.type !== "object" || !schema.properties) return null;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !omit.includes(key)));
  const required = (Array.isArray(schema.required) ? schema.required : []).filter((key) => key in properties && !optional.includes(key));
  const copy = { type: "object", properties };
  if (schema.additionalProperties !== undefined) copy.additionalProperties = schema.additionalProperties;
  if (required.length) copy.required = required;
  if (typeof schema.description === "string") copy.description = schema.description;
  return copy;
}

// TWIN: candidateCallBook in runtime/pi/claim_candidates.mjs (knowledge group) copies this function; test_page_build_wiring.mjs compares the two.
/** Call ids and the finished-step list for the tools the pack runs one after the other inside its one outer call. A step reads what the steps
 *  before it staged only when its sixth execute argument names them ({ chainDone }), so every call gets the list of the calls finished so far;
 *  a chain tool's list ends in ":*" because its own steps sit in folders under its id. `ok(call)` records a call that returned. */
export function innerCallBook(outerId) {
  let seq = 0;
  const finished = [];
  return {
    next(tool, { nested = false } = {}) {
      seq += 1;
      const suffix = `s${seq}:${tool}`;
      return { callId: `${outerId}:${suffix}`, suffix, finished: [...finished], nested };
    },
    ok(call) { finished.push(call.nested ? `${call.suffix}:*` : call.suffix); },
    get seq() { return seq; },
  };
}

/** The inner steps, in order, that the completion check reads from a RENDERED pack: the page chain, then the publication. */
export const INNER_STEP_TOOLS = [
  "newsroom_infographic_plan", "newsroom_infographic_lint", "newsroom_infographic_render", "newsroom_infographic_critic", "newsroom_infographic_preview",
  "newsroom_publication_plan", "newsroom_publication_render", "newsroom_publication_qa",
];

/**
 * Run the pack. `deps`:
 *   call(tool, params, label) -> tool result ({content, details}); throws when the tool refuses
 *   enabled(tool) -> boolean
 *   runChain(kind, planParams, label) -> runToolChain outcome plus `images` (the steps' image blocks) and, when stopped, `report`
 *     (the chain's own text); a first step that throws comes back as a STOPPED outcome, never thrown; kind "viz" or "infographic"
 *   claim(claimId) -> verified claim record or null
 *   sourceNote(sourceRefs, language) -> string or null
 *   rows(computationRef) -> result rows
 *   readJson(ref, prefix) -> artifact JSON
 *   fill(template, rows, plan) -> {text, bindings}, async: the visual group's own filler behind newsroom_design_pack_draft
 *   screenshot(qaResult) -> the desktop QA screenshot as an image block, or null
 *   numberWordIn(text) -> the first number word or null (number_words.mjs)
 * `state` lives for one CLI run: submissions, revisions, the last pack and the first half's refs.
 */
// Page fields that hold written text (the text fields of JUDGMENT_FIELD_PATHS in page_skeleton.mjs, plus the plan's subtitle and note); a test compares the two.
export const PATCH_TEXT_KEYS = Object.freeze(["title", "dek", "alt", "intent", "primary_message", "body", "heading", "subtitle", "note"]);
// Keys whose strings are ids, references or listed values, never written text (a claim id "c1" or a module id "n1" is not a number in text).
export const PATCH_LISTED_KEYS = Object.freeze(["id", "type", "story_role", "channel", "scale_type", "quantity_kind", "baseline_policy", "mark_semantics", "claim_ids", "story_node_ids", "cognitive_goals", "priority", "field", "visual_grammar", "visual_channels", "quantitative_encoding", "editorial_grammar", "pattern", "primary_cognitive_goal", "story_arc", "audience", "schema_version"]);
const isListedKey = (key) => PATCH_LISTED_KEYS.includes(key) || /(_ref|_id|_ids)$/.test(key);
// Every string a patch value brings in, as [path, text]: text keys always, and any other key that is not an id, a reference or a listed value
// (a new module, an object that replaces one, a field the text key list does not know such as caption). `key` is the key the value sits under.
export function patchTextLeaves(value, path, key = String(path).split("/").pop()) {
  if (isListedKey(key) && !PATCH_TEXT_KEYS.includes(key)) return [];
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => patchTextLeaves(item, `${path}/${index}`, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => patchTextLeaves(v, `${path}/${k}`, k));
  return [];
}

// Chart fields the sheet fills from the series computation and the chart-form table; the model never sends a different value.
const SHEET_CHART_KEYS = ["claim_id", "chart_type", "sql", "category_field", "value_field", "category_names"];

export async function runDesignPack(deps, params, state) {
  const problems = [];
  const notes = [];
  const audit = [];
  const drafts = {};
  const refs = {};
  const innerRecord = { page: null, publication: null };
  let runStop = null;
  let pack = params ?? {};
  // Declared here, not at the first use: the continuation and the sheet reach finish() before the part is read below.
  let part = "both";
  let revise = null;
  // New route: set when the second half stopped after the page preview, for the image-aware critic.
  let previewed = false;
  // Page build: the refused page plan is patched here (patch_of + ops), then the page chain, publication and finish run again.
  if (typeof deps.patch === "function" && (pack.patch_of !== undefined || pack.ops !== undefined)) return continuePage();
  // Page build: the sheet is pure program (verified claims, series computations, the matcher's chart forms); no tool runs and no send is used.
  if (deps.pageBuild && pack.part === "sheet") return sheetPart();
  // New route: after the image-aware critic looked at the previewed page, the publication of that same page; nothing else is taken.
  if (deps.next === true && deps.pageBuild && pack.part === "publish") return publishPart();
  if (pack.revise !== undefined) {
    if (!state.lastPack) return stop("DESIGN_PACK_NO_PAGE", "revise needs a pack this run has already rendered; send the judgement pack first");
    if ((state.revisions ?? 0) >= MAX_REVISIONS) return stop("DESIGN_PACK_REVISION_LIMIT", `the page was revised ${MAX_REVISIONS} times already; it stays unfinished. Report what is still missing in the final answer`);
    if (!pack.revise || typeof pack.revise !== "object" || Array.isArray(pack.revise)) return stop("DESIGN_PACK_REVISE_INVALID", "revise maps a drafted field path to \"=\" or new text");
    const unknown = Object.keys(pack.revise).filter((path) => !(path in (state.lastDrafts ?? {})));
    if (unknown.length) return stop("DESIGN_PACK_REVISE_INVALID", `revise names field(s) the pack did not draft: ${unknown.slice(0, 6).join(", ")}; drafted: ${Object.keys(state.lastDrafts ?? {}).join(", ")}`);
    state.revisions = (state.revisions ?? 0) + 1;
    revise = { ...(state.revise ?? {}), ...pack.revise };
    state.revise = revise;
    pack = state.lastPack;
  } else {
    if ((state.submissions ?? 0) >= MAX_SUBMISSIONS) return stop("DESIGN_PACK_SUBMISSION_LIMIT", `the judgement pack was sent ${MAX_SUBMISSIONS} times; it is not run again. Report what is still missing in the final answer`);
    state.submissions = (state.submissions ?? 0) + 1;
    state.revise = null;
    state.revisions = 0;
    state.pageOps = [];
    state.rejected = null;
  }
  part = pack.part ?? "both";
  if (!["first", "second", "both"].includes(part)) return stop("DESIGN_PACK_PART_INVALID", "part is first, second, or omitted for both");

  // ---- first half: discovery, story, concepts, novelty, assets (+ reference patterns and basemap when asked) ----
  if (part === "second") {
    if (!state.first?.complete) return stop("DESIGN_PACK_FIRST_HALF_MISSING", "send part \"first\" (discovery, story graph, concepts, novelty, assets) before part \"second\"");
    Object.assign(refs, state.first.refs);
  } else if (!revise) {
    await firstHalf();
    state.first = { complete: !problems.length, refs: { ...refs } };
  } else {
    Object.assign(refs, state.first?.refs ?? {});
  }
  if (part === "first") return finish();
  if (problems.length) return finish();

  // ---- a claim the charts need that is not recorded yet: stop before any chart ----
  const missing = Array.isArray(pack.needs_compute) ? pack.needs_compute.filter((item) => String(item ?? "").trim()) : [];
  if (missing.length) {
    if (deps.pageBuild) {
      problems.push({ step: "needs_compute", message: `DESIGN_PACK_NEEDS_COMPUTE: stopped before any chart; these results are not recorded as verified claims, so the page cannot use them: ${missing.join("; ")}. The run ends here.` });
      runStop = { reason: "needs_compute", step: "design_pack" };
      return finish();
    }
    problems.push({ step: "needs_compute", message: `DESIGN_PACK_NEEDS_COMPUTE: stopped before newsroom_viz_plan. Record these first with duckdb_query and record_claim, then send the pack again: ${missing.join("; ")}` });
    return finish();
  }

  // ---- charts ----
  let charts = Array.isArray(pack.charts) ? pack.charts : [];
  if (deps.pageBuild && state.sheet) {
    const merged = mergeSheetCharts(charts);
    if (!merged) return finish();
    charts = merged;
  }
  if (!charts.length) { problems.push({ step: "charts", message: "DESIGN_PACK_NO_CHARTS: charts lists the newsroom_viz_plan judgement of each chart" }); return finish(); }
  const chartOut = [];
  for (let index = 0; index < charts.length; index += 1) chartOut.push(await chart(index, charts[index]));
  if (chartOut.some((out) => !out)) return finish();

  // ---- page plan through the infographic chain ----
  const page = await pagePlan(chartOut);
  if (!page) return finish();

  // New route: publication needs the image-aware critic's record on this page (assertApprovedInfographicLineage), so the page stops here
  // with its preview images; the flow has the critic look at them and sends part "publish".
  if (deps.next === true && deps.pageBuild) {
    state.previewed = { page, chartOut, refs: { ...refs }, drafts: { ...drafts }, audit: [...audit], innerPage: innerRecord.page, pack: { ...pack, revise: undefined } };
    state.pageImages = page.images;
    previewed = true;
    return finish();
  }

  // ---- publication plan, render, QA ----
  await publication(page, chartOut);
  state.lastPack = { ...pack, revise: undefined };
  state.lastDrafts = { ...drafts };
  return finish();

  // -------------------------------------------------------------------------------------------------------------------
  function stop(code, message) {
    return { status: "STOPPED", code, problems: [{ step: "pack", message: `${code}: ${message}` }], notes: [], refs: {}, drafts: {}, audit: [], images: [], ...nextOf("STOPPED") };
  }

  // The pack never fills source_refs: a source is only true if the run registered the artifact, so the refusal says what to do instead.
  function assetSourceHint(error, toolParams) {
    const index = Number(/available requirement (\d+) requires source_refs/.exec(String(error?.message ?? error))?.[1]);
    if (!Number.isInteger(index)) return "";
    const items = Array.isArray(toolParams?.requirements) ? toolParams.requirements : [];
    const lacking = items.map((item, i) => [i + 1, item]).filter(([, item]) => item?.available === true && !(Array.isArray(item?.source_refs) && item.source_refs.length));
    const named = lacking.map(([n, item]) => `${n} (${String(item?.asset_class ?? "?")})`).join(", ");
    return `\nAvailable assets with no source_refs: requirement ${named || index}. Only two kinds of file can be a source_refs entry. For a map (published_gis, geographic_coordinates): the output of newsroom_basemap_prepare, maps/basemaps/<name>.json. For a diagram or illustration we draw ourselves (verified_diagram, vector_illustration, human_scale_reference): the illustration manifest that newsroom_explainer_render wrote in this run, visualizations/illustrations/<name>.json. Run the tool first, then cite its output. Nothing else is a source: not a data file the claims cite, not a chart, map, page or plan file, and not any other file of the run. For every other class (photos, portraits, series, expert material), or when the file does not exist, set available to false for that requirement. That has a price: a required requirement that is not available makes the asset plan REVISE and a blocking one makes it RESEARCH_MORE, and the infographic plan is then refused. Do not change status to get past it. The pack does not fill source_refs.`;
  }

  function schemaHintFor(tool) {
    try { return typeof deps.schemaOf === "function" ? schemaHint(tool, deps.schemaOf(tool)) : ""; } catch { return ""; }
  }

  async function step(tool, toolParams, label = tool) {
    if (!deps.enabled(tool)) { problems.push({ step: label, message: `TOOL_NOT_ENABLED: ${tool} is not enabled in this phase/profile` }); return null; }
    try { return await deps.call(tool, toolParams, label); } catch (error) { problems.push({ step: label, message: `${String(error?.message ?? error)}${tool === "newsroom_asset_requirements" ? assetSourceHint(error, toolParams) : ""}${schemaHintFor(tool)}` }); return null; }
  }

  async function firstHalf() {
    const skipped = (label, cause) => problems.push({ step: label, message: `not run: ${cause} was refused` });
    const discovery = await step("newsroom_editorial_discovery", pack.discovery ?? {});
    if (discovery) refs.discoveryRef = discovery.details?.discoveryRef;
    const story = await step("newsroom_story_graph", pack.story_graph ?? {});
    if (story) refs.storyGraphRef = story.details?.storyGraphRef;
    let concepts = null;
    if (discovery) {
      // Drafting point: with no concepts in the call, a run that wires `deps.draftConcepts` (off unless a switch turns it on; the model writes them otherwise)
      // supplies the list. Its answer goes through the same tool and the same checks as a model's list.
      const drafted = pack.visual_concepts === undefined && typeof deps.draftConcepts === "function" ? await deps.draftConcepts({ pack, refs }) : null;
      concepts = await step("newsroom_visual_concepts", { ...(drafted ?? pack.visual_concepts ?? {}), discovery_ref: refs.discoveryRef });
      if (concepts) { refs.conceptRef = concepts.details?.conceptRef; refs.selectedConceptId = concepts.details?.selectedConceptId; }
    } else skipped("newsroom_visual_concepts", "newsroom_editorial_discovery");
    if (concepts) {
      const novelty = await step("newsroom_semantic_novelty", { ...(pack.semantic_novelty ?? {}), concept_ref: refs.conceptRef });
      if (novelty) refs.noveltyRef = novelty.details?.noveltyRef;
      const assets = await step("newsroom_asset_requirements", { ...(pack.asset_requirements ?? {}), concept_ref: refs.conceptRef, concept_id: pack.asset_requirements?.concept_id ?? refs.selectedConceptId });
      if (assets) refs.assetPlanRef = assets.details?.assetPlanRef;
    } else {
      skipped("newsroom_semantic_novelty", "newsroom_visual_concepts");
      skipped("newsroom_asset_requirements", "newsroom_visual_concepts");
    }
    // Conditional steps: run only when the pack asks for them.
    if (pack.reference_patterns) {
      const reference = await step("newsroom_reference_patterns", pack.reference_patterns);
      if (reference) refs.referenceRef = reference.details?.referenceRef;
    }
    if (pack.basemap) {
      const basemap = await step("newsroom_basemap_prepare", pack.basemap);
      if (basemap) refs.basemap = basemap.details ?? null;
    }
  }

  async function chart(index, input) {
    const label = `charts[${index}]`;
    if (!input || typeof input !== "object" || Array.isArray(input)) { problems.push({ step: label, message: `${label} is the newsroom_viz_plan judgement of one chart` }); return null; }
    const plan = { ...input };
    const types = templateTypes(deps.next === true);
    const templated = types.includes(String(plan.chart_type ?? ""));
    const before = templated ? draftBeforeRows(plan, deps.numberWordIn, types) : {};
    const ctxNoRows = { rows: null, plan };
    // takeaway: the recorded claim's own sentence, copied verbatim (a claim template in `claim` is filled by the plan tool itself).
    const claim = plan.claim === undefined && plan.claim_id ? await deps.claim(String(plan.claim_id)) : null;
    if (plan.takeaway === undefined && claim?.claim) { plan.takeaway = String(claim.claim); setDraft(`${label}.takeaway`, plan.takeaway, { path: `${label}.takeaway`, origin: "claim", claim_id: String(plan.claim_id) }); }
    // source line: from the data files the recorded claim cites (its source_refs), written by the visual group's own reader.
    if (plan.source_note === undefined && Array.isArray(claim?.source_refs) && claim.source_refs.length) {
      const note = await deps.sourceNote(claim.source_refs.map(String), plan.language);
      if (note) { plan.source_note = note; setDraft(`${label}.source_note`, note, { path: `${label}.source_note`, origin: "source_record" }); }
    }
    if (plan.title === undefined && before.title) { plan.title = before.title.text; setDraft(`${label}.title`, plan.title, { path: `${label}.title`, origin: before.title.origin, from: before.title.from }); }
    if (plan.alt === undefined && before.l1 && plan.takeaway) {
      const alt = clip(`${before.l1}${plan.language === "en" ? ". " : "。"}${plan.takeaway}`, LIMITS.alt) ?? clip(before.l1, LIMITS.alt);
      if (alt) { plan.alt = alt; setDraft(`${label}.alt`, alt, { path: `${label}.alt`, origin: "template", parts: ["l1", "claim"] }); }
    }
    // Model text for these fields, sent now or in a revision, is checked like any rewrite; a chart has no rows yet, so no placeholders.
    for (const key of CHART_DRAFT_KEYS) {
      const path = `${label}.${key}`;
      const rewrite = revise?.[path];
      if (rewrite === undefined) continue;
      const checked = await modelText(deps, path, rewrite, ctxNoRows);
      if (!checked) continue;
      if (checked.problem) { problems.push({ step: label, message: checked.problem }); return null; }
      plan[key] = checked.text; audit.push(checked.audit); drafts[path] = checked.text;
    }
    if (!templated) notes.push(`${label}: chart type '${plan.chart_type}' has no drafting template; its title, alt and captions are the model's`);
    const outcome = await deps.runChain("viz", plan, label);
    if (outcome.status !== "COMPLETE") { problems.push({ step: label, message: chainStopText(outcome) }); return null; }
    const st = outcome.state ?? {};
    const vizPlan = await deps.readJson(String(st.planRef), "visualizations/plans/");
    const manifest = await deps.readJson(String(st.manifestRef), "visualizations/");
    const rows = await deps.rows(String(st.computationRef));
    let publicationRefs;
    try { publicationRefs = publicationModuleFor(vizPlan, { desktopSvgRef: manifest?.variants?.desktop ?? null, computationRef: String(st.computationRef) }, deps.next === true ? NEXT_PUBLICATION_TYPES : PUBLICATION_TYPES); } catch (error) { problems.push({ step: label, message: String(error?.message ?? error) }); return null; }
    // New route: text names a place only by the program's names for this chart's codes (its template's `names`; none for a chart
    // without a code column), never through the visual group's table.
    const ctx = { rows, plan: vizPlan, computationRef: String(st.computationRef), direction: null, ...(deps.next === true ? { names: state.names?.[plan.claim_id] ?? {} } : {}) };
    const templates = templated ? rowTemplates(vizPlan, rows, deps.numberWordIn, types) : null;
    const out = { index, label, plan: vizPlan, refs: { planRef: st.planRef, manifestRef: st.manifestRef, criticRef: st.criticRef, computationRef: st.computationRef }, publication: publicationRefs, ctx, l1: before.l1 ?? null, l2: null, l3: null, images: outcome.images ?? [] };
    if (templates) {
      ctx.direction = templates.direction;
      const l2 = await drafted(deps, `${label}.l2`, templates.l2, ctx);
      if (l2.text) { out.l2 = l2; } else notes.push(l2.skipped);
      if (templates.l3) {
        const l3 = await drafted(deps, `${label}.l3`, templates.l3, ctx, { direction: templates.direction });
        if (l3.text) { out.l3 = l3; } else notes.push(l3.skipped);
      }
      // The plan's own note (a caveat such as "categories overlap") is copied after L2 when it holds no number.
      const note = String(vizPlan.note ?? "").trim();
      if (note && out.l2 && !hasNumber(note, deps.numberWordIn)) out.note = note;
    }
    return out;
  }

  async function pagePlan(chartOut) {
    const pageIn = pack.page && typeof pack.page === "object" && !Array.isArray(pack.page) ? pack.page : null;
    if (!pageIn) { problems.push({ step: "page", message: "DESIGN_PACK_NO_PAGE: page is the newsroom_infographic_plan judgement (modules name their chart by index in charts)" }); return null; }
    const zh = (pageIn.language ?? chartOut[0]?.plan?.language) !== "en";
    const firstCtx = chartOut[0]?.ctx ?? { rows: null };
    if (deps.pageBuild) {
      const wrong = programFieldProblems(pageIn, chartOut, refs);
      if (wrong.length) { problems.push({ step: "page", message: `DESIGN_PACK_PROGRAM_FIELD: the program fills ${wrong.map((item) => item.path).join(", ")}; you sent a different value. Leave ${wrong.length > 1 ? "them" : "it"} out of page.` }); return null; }
    }
    let planParams = { ...pageIn, story_graph_ref: refs.storyGraphRef, editorial_discovery_ref: refs.discoveryRef, visual_concept_ref: refs.conceptRef, selected_concept_id: pageIn.selected_concept_id ?? refs.selectedConceptId, novelty_ref: refs.noveltyRef, asset_plan_ref: refs.assetPlanRef };
    // The audit knows the page plan by its kind and by the asset plan it names (editorial.asset_plan_ref): the one this step received.
    planParams.kind = PAGE_PLAN_KIND;
    if (planParams.asset_plan_ref !== undefined) planParams.editorial = { ...(pageIn.editorial && typeof pageIn.editorial === "object" && !Array.isArray(pageIn.editorial) ? pageIn.editorial : {}), asset_plan_ref: planParams.asset_plan_ref };
    const modules = Array.isArray(pageIn.modules) ? pageIn.modules : [];
    const outModules = [];
    for (const module of modules) {
      if (!module || typeof module !== "object") { outModules.push(module); continue; }
      const { chart: chartIndex, ...rest } = module;
      if (chartIndex === undefined) { outModules.push(rest); continue; }
      const source = chartOut[Number(chartIndex)];
      if (!source) { problems.push({ step: "page", message: `page module '${module.id}' names chart ${JSON.stringify(chartIndex)}, which is not in charts` }); return null; }
      const base = `page.modules.${module.id}`;
      const filled = { ...rest, type: rest.type ?? "visual", manifest_ref: source.refs.manifestRef, critic_ref: source.refs.criticRef, ...(source.plan.claim_id ? { claim_id: String(source.plan.claim_id) } : {}) };
      if (filled.heading === undefined && source.plan.title) setField(filled, "heading", `${base}.heading`, source.plan.title, { origin: "copied", from: `${source.label}.title` });
      if (filled.alt === undefined && source.plan.alt) setField(filled, "alt", `${base}.alt`, source.plan.alt, { origin: "copied", from: `${source.label}.alt` });
      if (filled.body === undefined && source.plan.takeaway) {
        const withTrend = source.l3 ? clip(`${source.plan.takeaway}${zh ? "" : " "}${source.l3.text}${zh ? "。" : "."}`, LIMITS.body) : null;
        const body = withTrend ?? clip(source.plan.takeaway, LIMITS.body);
        if (body) setField(filled, "body", `${base}.body`, body, { origin: source.l3 && withTrend ? "placeholder" : "claim", from: `${source.label}.takeaway`, ...(source.l3 && withTrend ? { template: source.l3.audit.template, bindings: source.l3.audit.bindings, computation_ref: source.ctx.computationRef, direction: source.ctx.direction } : {}) });
      }
      for (const key of DRAFT_FIELDS.page_module) {
        const path = `${base}.${key}`;
        const value = revise?.[path] ?? (module[key] !== undefined && !(path in drafts) ? module[key] : undefined);
        if (value === undefined || (revise?.[path] === undefined && module[key] === undefined)) continue;
        const checked = await modelText(deps, path, value, source.ctx);
        if (!checked) continue;
        if (checked.problem) { problems.push({ step: "page", message: checked.problem }); return null; }
        filled[key] = checked.text; audit.push(checked.audit); drafts[path] = checked.text;
      }
      outModules.push(filled);
    }
    planParams.modules = outModules;
    // Page title: the first clause of the story's visual thesis (never a new opinion); else the first chart's title.
    if (pageIn.title === undefined) {
      const thesis = firstClause(pageIn.visual_thesis ?? pack.story_graph?.visual_thesis ?? "");
      const title = thesis && !hasNumber(thesis, deps.numberWordIn) ? clip(thesis, LIMITS.page_title) : null;
      const fallback = chartOut[0]?.plan?.title ? clip(chartOut[0].plan.title, LIMITS.page_title) : null;
      if (title) setField(planParams, "title", "page.title", title, { origin: "copied_model_text", from: "visual_thesis" });
      else if (fallback) setField(planParams, "title", "page.title", fallback, { origin: "copied", from: "charts[0].title" });
    }
    if (pageIn.dek === undefined) {
      const lead = firstSentence(pageIn.primary_message ?? "");
      const line = chartOut.find((out) => out.plan.chart_type === "line" && out.l3);
      let span = null;
      if (line) {
        const t = String(line.plan.time_field);
        const spanDraft = await drafted(deps, "page.dek", zh ? `从{first.${t}}到{last.${t}}` : `From {first.${t}} to {last.${t}}`, line.ctx);
        if (spanDraft.text) span = spanDraft;
      }
      const leadText = lead && !hasNumber(lead, deps.numberWordIn) ? lead : "";
      const dek = clip([leadText, span?.text ?? ""].filter(Boolean).join(zh ? "" : " "), LIMITS.dek);
      if (dek) setField(planParams, "dek", "page.dek", dek, { origin: span ? "placeholder" : "copied_model_text", from: "primary_message", ...(span ? { template: span.audit.template, bindings: span.audit.bindings, computation_ref: line.ctx.computationRef } : {}) });
    }
    if (pageIn.alt === undefined) {
      const names = [...new Set(chartOut.map((out) => chartName(out.plan.chart_type, zh, templateTypes(deps.next === true))).filter(Boolean))];
      const head = names.length ? (zh ? `本页包含${names.join("、")}。` : `This page has a ${names.join(", ")}.`) : "";
      const parts = [head, ...chartOut.map((out) => out.l2?.text).filter(Boolean)];
      let alt = "";
      for (const part of parts) { const next = alt ? `${alt}${zh ? "" : " "}${part}${zh && !/[。]$/.test(part) ? "。" : ""}` : part; if ([...next].length > LIMITS.alt) break; alt = next; }
      if (alt) setField(planParams, "alt", "page.alt", alt, { origin: "placeholder", parts: chartOut.filter((out) => out.l2).map((out) => ({ template: out.l2.audit.template, bindings: out.l2.audit.bindings, computation_ref: out.ctx.computationRef })) });
    }
    for (const key of DRAFT_FIELDS.page) {
      const path = `page.${key}`;
      const value = revise?.[path] ?? pageIn[key];
      if (value === undefined || (revise?.[path] === undefined && pageIn[key] === undefined)) continue;
      const checked = await modelText(deps, path, value, firstCtx);
      if (!checked) continue;
      if (checked.problem) { problems.push({ step: "page", message: checked.problem }); return null; }
      planParams[key] = checked.text; audit.push(checked.audit); drafts[path] = checked.text;
    }
    // Page build: changes the model made to an earlier refused plan stay on the plan when its text is revised.
    if (deps.applyOps && state.pageOps?.length) {
      try { planParams = deps.applyOps(planParams, state.pageOps); } catch (error) { problems.push({ step: "page", message: `DESIGN_PACK_PATCH_REFUSED: the earlier patch no longer applies to the revised page plan: ${String(error?.message ?? error)}` }); return null; }
    }
    return runPageChain(planParams, Array.isArray(planParams.modules) ? planParams.modules : outModules, chartOut);
  }

  // The page chain call, shared by the first run and a patched run. A refusal whose record was kept becomes the one patch_of the pack accepts next.
  async function runPageChain(planParams, modules, chartOut) {
    const outcome = await deps.runChain("infographic", planParams, "page");
    if (outcome.status !== "COMPLETE") {
      problems.push({ step: "page", message: chainStopText(outcome) });
      state.rejected = deps.patch && outcome.rejectionRef ? { ref: String(outcome.rejectionRef), chartOut, refs: { ...refs }, drafts: { ...drafts }, audit: [...audit], pack: { ...pack, revise: undefined }, protectedPaths: programPaths(planParams, drafts) } : null;
      return null;
    }
    state.rejected = null;
    refs.infographicPlanRef = outcome.state?.planRef;
    refs.infographicManifestRef = outcome.state?.manifestRef;
    refs.infographicCriticRef = outcome.state?.criticRef;
    refs.previewRef = outcome.state?.previewRef;
    innerRecord.page = recordedSteps(outcome.steps);
    return { params: planParams, modules, images: outcome.images ?? [] };
  }

  // Page build: the page plan as the pack built it, for the checks on a model's patch.
  function programPaths(planParams, draftedNow) {
    const paths = new Set();
    for (const key of PROGRAM_PAGE_KEYS) if (planParams[key] !== undefined) paths.add(`/${key}`);
    paths.add("/kind");
    if (planParams.editorial?.asset_plan_ref !== undefined) paths.add("/editorial/asset_plan_ref");
    (planParams.modules ?? []).forEach((module, index) => {
      for (const key of PROGRAM_MODULE_KEYS) if (module?.[key] !== undefined) paths.add(`/modules/${index}/${key}`);
    });
    for (const path of Object.keys(draftedNow)) {
      const page = /^page\.(title|dek|alt)$/.exec(path);
      if (page) { paths.add(`/${page[1]}`); continue; }
      const mod = /^page\.modules\.([^.]+)\.(heading|alt|body)$/.exec(path);
      if (mod) (planParams.modules ?? []).forEach((module, index) => { if (String(module?.id) === mod[1]) paths.add(`/modules/${index}/${mod[2]}`); });
    }
    return [...paths];
  }

  // Page build: the model's own page fields the program also fills, where the model sent another value.
  function programFieldProblems(pageIn, chartOut, filledRefs) {
    const program = { story_graph_ref: filledRefs.storyGraphRef, editorial_discovery_ref: filledRefs.discoveryRef, visual_concept_ref: filledRefs.conceptRef, selected_concept_id: filledRefs.selectedConceptId, novelty_ref: filledRefs.noveltyRef, asset_plan_ref: filledRefs.assetPlanRef };
    const wrong = [];
    for (const key of PROGRAM_PAGE_KEYS) if (pageIn[key] !== undefined && String(pageIn[key]) !== String(program[key])) wrong.push({ path: `page.${key}` });
    if (pageIn.kind !== undefined && pageIn.kind !== PAGE_PLAN_KIND) wrong.push({ path: "page.kind" });
    if (pageIn.editorial !== undefined && (!pageIn.editorial || typeof pageIn.editorial !== "object" || Array.isArray(pageIn.editorial))) wrong.push({ path: "page.editorial" });
    else if (pageIn.editorial?.asset_plan_ref !== undefined && String(pageIn.editorial.asset_plan_ref) !== String(program.asset_plan_ref)) wrong.push({ path: "page.editorial.asset_plan_ref" });
    for (const module of Array.isArray(pageIn.modules) ? pageIn.modules : []) {
      if (!module || typeof module !== "object" || module.chart === undefined) continue;
      const source = chartOut[Number(module.chart)];
      if (!source) continue;
      const own = { manifest_ref: source.refs.manifestRef, critic_ref: source.refs.criticRef, claim_id: source.plan.claim_id ? String(source.plan.claim_id) : undefined };
      for (const key of PROGRAM_MODULE_KEYS) if (module[key] !== undefined && String(module[key]) !== String(own[key])) wrong.push({ path: `page.modules.${module.id}.${key}` });
    }
    return wrong;
  }

  async function publishPart() {
    const held = state.previewed;
    if (!held) return stop("DESIGN_PACK_NOT_PREVIEWED", "part \"publish\" needs the page this run last previewed; send part \"second\" first");
    const stray = Object.keys(pack).filter((key) => key !== "part");
    if (stray.length) return stop("DESIGN_PACK_PUBLISH_INVALID", `part "publish" takes nothing else; also sent: ${stray.slice(0, 6).join(", ")}`);
    state.previewed = null;
    Object.assign(refs, held.refs);
    Object.assign(drafts, held.drafts);
    audit.push(...held.audit);
    innerRecord.page = held.innerPage;
    pack = held.pack;
    part = "publish";
    await publication(held.page, held.chartOut);
    state.lastPack = { ...pack, revise: undefined };
    state.lastDrafts = { ...drafts };
    return finish();
  }

  async function continuePage() {
    const last = state.rejected;
    if (!last) return stop("DESIGN_PACK_NO_REJECTION", "no page plan was refused in this run that can still be patched; send the judgement pack");
    if (pack.patch_of !== last.ref) return stop("DESIGN_PACK_PATCH_BASE", `patch_of must be ${last.ref}, the latest refused page plan`);
    if (!Array.isArray(pack.ops) || !pack.ops.length) return stop("DESIGN_PACK_PATCH_INVALID", "ops is a non-empty list of RFC 6902 ops on the refused page plan");
    const stray = Object.keys(pack).filter((key) => key !== "patch_of" && key !== "ops");
    if (stray.length) return stop("DESIGN_PACK_PATCH_INVALID", `a patch is patch_of and ops only; also sent: ${stray.slice(0, 6).join(", ")}`);
    if ((state.patches ?? 0) >= MAX_PATCHES) return stop("DESIGN_PACK_PATCH_LIMIT", `the page plan was patched ${MAX_PATCHES} times already; it stays unfinished. Report what is still missing in the final answer`);
    const touched = pack.ops.filter((op) => op?.op !== "test").map((op) => String(op?.path ?? "")).filter((path) => last.protectedPaths.some((own) => own === path || own.startsWith(`${path}/`) || path.startsWith(`${own}/`)));
    if (touched.length) return stop("DESIGN_PACK_PROGRAM_FIELD", `the program fills ${[...new Set(touched)].join(", ")}; a patch cannot change it. To change drafted text use revise`);
    // Only written text is searched for numbers; a listed value ("zero" as a baseline policy) or an id ("n1") is not text.
    const numbered = pack.ops.flatMap((op) => (op?.op === "test" ? [] : patchTextLeaves(op?.value, String(op?.path ?? "")))).filter(([, text]) => hasNumber(text, deps.numberWordIn)).map(([path]) => path);
    if (numbered.length) return stop("DESIGN_PACK_PATCH_NUMBER", `a patch cannot put a number in text (${numbered.slice(0, 4).join(", ")}); numbers come from the recorded claims`);
    state.patches = (state.patches ?? 0) + 1;
    const sentOps = pack.ops;
    let patched;
    try { patched = await deps.patch(pack.patch_of, pack.ops); } catch (error) { return stop("DESIGN_PACK_PATCH_REFUSED", String(error?.message ?? error)); }
    Object.assign(refs, last.refs);
    Object.assign(drafts, last.drafts);
    audit.push(...last.audit);
    pack = last.pack;
    part = pack.part ?? "both";
    revise = state.revise ?? null;
    const page = await runPageChain(patched, Array.isArray(patched.modules) ? patched.modules : [], last.chartOut);
    if (!page) return finish();
    state.pageOps = [...(state.pageOps ?? []), ...sentOps];
    await publication(page, last.chartOut);
    state.lastPack = { ...pack, revise: undefined };
    state.lastDrafts = { ...drafts };
    return finish();
  }

  async function publication(page, chartOut) {
    const pubIn = pack.publication && typeof pack.publication === "object" && !Array.isArray(pack.publication) ? pack.publication : {};
    const overrides = new Map((Array.isArray(pubIn.modules) ? pubIn.modules : []).filter((m) => m && typeof m === "object").map((m) => [String(m.id), m]));
    const zh = (page.params.language ?? chartOut[0]?.plan?.language) !== "en";
    const modules = [];
    for (const module of page.modules) {
      if (!module || typeof module !== "object") continue;
      const id = String(module.id);
      const base = `publication.modules.${id}`;
      const override = overrides.get(id) ?? {};
      const source = module.manifest_ref ? chartOut.find((out) => out.refs.manifestRef === module.manifest_ref) : null;
      const claimIds = [module.claim_id, ...(Array.isArray(module.claim_ids) ? module.claim_ids : [])].filter(Boolean).map(String);
      let out;
      if (source) {
        const forbidden = PUBLICATION_TABLE_KEYS.filter((key) => override[key] !== undefined);
        if (forbidden.length) { problems.push({ step: "publication", message: `DESIGN_PACK_PUBLICATION_TYPE_FIXED: module '${id}' takes ${forbidden.join(", ")} from the chart-type table, not from the call` }); return; }
        out = { id, ...source.publication, story_node_ids: module.story_node_ids, explanatory_dimension: module.explanatory_dimension, ...(claimIds.length ? { claim_ids: claimIds } : {}), ...(module.heading ? { title: module.heading } : {}) };
        const sep = zh ? "。" : ". ";
        const l1 = source.l1 ?? "";
        const l2 = source.l2?.text ?? "";
        const summary = clip([l1, l2].filter(Boolean).join(sep), LIMITS.summary) ?? clip(l1, LIMITS.summary);
        if (summary) setField(out, "accessibility_summary", `${base}.accessibility_summary`, summary, { origin: l2 && summary.includes(l2) ? "placeholder" : "template", ...(source.l2 && summary.includes(l2) ? { template: source.l2.audit.template, bindings: source.l2.audit.bindings, computation_ref: source.ctx.computationRef } : {}) });
        const long = clip([l1, l2, source.note ?? "", source.l3?.text ?? ""].filter(Boolean).join(sep), LIMITS.long);
        if (long) setField(out, "accessibility_long_description", `${base}.accessibility_long_description`, long, { origin: "placeholder", parts: [source.l2, source.l3].filter(Boolean).map((part) => ({ template: part.audit.template, bindings: part.audit.bindings })), computation_ref: source.ctx.computationRef, ...(source.note ? { copied_model_text: "viz_plan.note" } : {}) });
      } else if (module.type === "text") {
        out = { id, type: "text", story_node_ids: module.story_node_ids, explanatory_dimension: module.explanatory_dimension, ...(claimIds.length ? { claim_ids: claimIds } : {}), ...(module.heading ? { title: module.heading } : {}) };
        if (module.body) setField(out, "text", `${base}.text`, module.body, { origin: "copied", from: `page.modules.${id}.body` });
      } else {
        // Any other page module is the model's to publish: it sends the whole publication module.
        if (!overrides.has(id)) { problems.push({ step: "publication", message: `module '${id}' (${module.type}) has no chart and is not text; send its publication module in publication.modules` }); return; }
        out = {};
      }
      const merged = { ...out, ...override, id };
      for (const key of DRAFT_FIELDS.publication_module) {
        const path = `${base}.${key}`;
        const value = revise?.[path] ?? override[key];
        if (value === undefined) continue;
        const checked = await modelText(deps, path, value, source?.ctx ?? chartOut[0]?.ctx ?? { rows: null });
        if (!checked) { if (out[key] !== undefined) merged[key] = out[key]; continue; }
        if (checked.problem) { problems.push({ step: "publication", message: checked.problem }); return; }
        merged[key] = checked.text; audit.push(checked.audit); drafts[path] = checked.text;
      }
      modules.push(merged);
    }
    const planParams = {
      infographic_plan_ref: refs.infographicPlanRef,
      story_graph_ref: refs.storyGraphRef,
      title: page.params.title,
      dek: page.params.dek,
      reader_question: page.params.reader_question ?? (deps.pageBuild ? pack.story_graph?.reader_question : undefined),
      visual_thesis: page.params.visual_thesis ?? (deps.pageBuild ? pack.story_graph?.visual_thesis : undefined),
      ...(page.params.language ? { language: page.params.language } : {}),
      ...(pubIn.style_profile !== undefined ? { style_profile: pubIn.style_profile } : {}),
      ...(pubIn.source_note !== undefined ? { source_note: pubIn.source_note } : {}),
      modules,
    };
    // New route: the second pack carries no story graph, so a question or thesis still missing is copied verbatim from the page plan
    // this publication binds (which took them from the story graph); the publication check compares against that same plan.
    if (deps.next === true && (planParams.reader_question === undefined || planParams.visual_thesis === undefined) && refs.infographicPlanRef) {
      const bound = await deps.readJson(String(refs.infographicPlanRef), "infographics/plans/");
      if (planParams.reader_question === undefined && typeof bound?.reader_question === "string") planParams.reader_question = bound.reader_question;
      if (planParams.visual_thesis === undefined && typeof bound?.visual_thesis === "string") planParams.visual_thesis = bound.visual_thesis;
    }
    innerRecord.publication = [];
    const planned = await step("newsroom_publication_plan", planParams);
    if (!planned) return;
    recordPublicationStep("newsroom_publication_plan", planParams, planned);
    refs.publicationPlanRef = planned.details?.planRef;
    const rendered = await step("newsroom_publication_render", { plan_ref: refs.publicationPlanRef });
    if (!rendered) return;
    recordPublicationStep("newsroom_publication_render", { plan_ref: refs.publicationPlanRef }, rendered);
    refs.publicationHtmlRef = rendered.details?.htmlRef;
    refs.publicationManifestRef = rendered.details?.manifestRef;
    const qa = await step("newsroom_publication_qa", { plan_ref: refs.publicationPlanRef, manifest_ref: refs.publicationManifestRef });
    if (!qa) return;
    recordPublicationStep("newsroom_publication_qa", { plan_ref: refs.publicationPlanRef, manifest_ref: refs.publicationManifestRef }, qa);
    refs.publicationQaRef = qa.details?.reportRef;
    // A browser that did not start judged nothing: that is not a pass.
    if (qa.details?.judged === false) problems.push({ step: "newsroom_publication_qa", message: "DESIGN_PACK_QA_NOT_JUDGED: the browser check did not judge the page, so it has not passed" });
    else if (qa.details?.passed !== true) problems.push({ step: "newsroom_publication_qa", message: `DESIGN_PACK_QA_FAILED: ${textResultOf(qa).slice(0, 400)}` });
    state.pageImages = page.images;
    state.qaImage = problems.length ? null : await deps.screenshot(qa);
  }

  // ---- sheet mode (page build) ----
  // The program's share of each chart: claim, series SQL, chart form and fields. The model sends only the judgement of a chart (unit,
  // reader_task, measure_semantics, claim_spec text fields); a program field it sends with another value is refused by name.

  async function sheetPart() {
    if (typeof deps.sheetData !== "function" || typeof deps.chartForm !== "function") return stop("DESIGN_PACK_SHEET_UNAVAILABLE", "the sheet needs the verified claims and the chart-form table, and this run has neither");
    const items = (await deps.sheetData()).filter((item) => item?.verified === true && item.series?.sql);
    if (!items.length) return stop("DESIGN_PACK_SHEET_NO_CLAIMS", "no verified claim has a series computation (computation_refs[1]); record claims with the candidate lists first, or send needs_compute");
    const chartsOut = [];
    const gaps = [];
    const seen = new Set();
    // New route: the program sends the registry's pick for each claim (`templates`); the old matcher is not asked.
    const picks = deps.next === true && pack.templates !== undefined ? pack.templates : null;
    if (picks && !Array.isArray(picks)) return stop("DESIGN_PACK_SHEET_TEMPLATE", "templates lists one {claim_id, chart_type, fields} per claim");
    for (const item of items) {
      // Claims drawn from one series share one chart: the first claim names it, the others stay available to the modules. New route: one
      // chart per series and template, so a claim the program put on another template of the same series draws that second chart.
      const pick = picks ? picks.find((entry) => entry?.claim_id === item.claim_id) : null;
      const key = picks ? `${item.series.sql}\u0000${pick?.chart_type ?? ""}` : item.series.sql;
      if (seen.has(key)) continue;
      seen.add(key);
      if (picks) {
        const own = templateChart(item, picks);
        if (typeof own === "string") gaps.push(`${item.claim_id}: ${own}`); else chartsOut.push(own);
        continue;
      }
      const shape = await sheetShape(item.series, deps.codeScheme);
      const hit = await deps.chartForm(shape.need);
      if (!hit.ok) { gaps.push(`${item.claim_id}: ${hit.message}`); continue; }
      const relation = hit.relations.find((name) => shape.need.relations.includes(name));
      chartsOut.push({ claim_id: item.claim_id, chart_type: hit.chart_type, sql: item.series.sql, category_field: shape.dimension, value_field: shape.value, ...(shape.scheme && (hit.chart_type === "choropleth" || shape.named) ? { category_names: shape.scheme } : {}), claim_spec: { claim_id: item.claim_id, relation } });
    }
    if (gaps.length) return stop("DESIGN_PACK_SHEET_NO_FORM", gaps.join(" | "));
    state.sheet = { charts: chartsOut, claims: items.map((item) => ({ id: item.claim_id, summary: String(item.claim ?? "") })) };
    const sheetText = typeof deps.sheetText === "function" ? await deps.sheetText({ refs: state.first?.refs ?? {}, charts: chartsOut, claims: state.sheet.claims }) : "";
    return { status: "SHEET", problems: [], notes: [], refs: {}, drafts: {}, audit: [], images: [], sheetText, sheet: state.sheet, submissions: state.submissions ?? 0, revisions: 0, steps: null, ...nextOf("SHEET") };
  }

  /** New route: one chart from the registry's pick, read against its template row. Every field the row names is given and is a column of the
   *  series; nothing else is filled. Returns the chart or the reason it was refused. */
  function templateChart(item, list) {
    const pick = list.find((entry) => entry && typeof entry === "object" && entry.claim_id === item.claim_id);
    if (!pick) return "the program sent no template for this claim";
    const unknown = Object.keys(pick).filter((key) => !["claim_id", "chart_type", "fields", "category_names", "names"].includes(key));
    if (unknown.length) return `a template takes claim_id, chart_type, fields, category_names and names, not ${unknown.join(", ")}`;
    const type = String(pick.chart_type ?? "");
    const row = Object.prototype.hasOwnProperty.call(NEXT_TEMPLATE_ROWS, type) ? NEXT_TEMPLATE_ROWS[type] : null;
    if (!row) return `chart type '${type}' has no template row (known: ${NEXT_TEMPLATE_CHART_TYPES.join(", ")})`;
    const fields = pick.fields && typeof pick.fields === "object" && !Array.isArray(pick.fields) ? pick.fields : {};
    const extra = Object.keys(fields).filter((key) => !row.fields.includes(key));
    if (extra.length) return `${type} takes ${row.fields.join(", ")}, not ${extra.join(", ")}`;
    const columns = Array.isArray(item.series.columns) ? item.series.columns.map(String) : [];
    const bad = row.fields.filter((key) => typeof fields[key] !== "string" || !columns.includes(fields[key]));
    if (bad.length) return `${type} needs ${bad.map((key) => `${key} (${fields[key] === undefined ? "not given" : `'${fields[key]}' is not a series column`})`).join(", ")}; columns: ${columns.join(", ")}`;
    const names = pick.category_names;
    if (names !== undefined && (typeof names !== "string" || !names.trim())) return "category_names is the code scheme of the category column, as text";
    if (names === undefined && row.names === "required") return `${type} needs category_names (the code scheme of '${fields.category_field}')`;
    const zh = pick.names;
    if (zh !== undefined && (!zh || typeof zh !== "object" || Array.isArray(zh) || Object.values(zh).some((name) => typeof name !== "string" || !name.trim()))) return "names maps each code of the category column to its Chinese name, as text";
    if (zh !== undefined && names === undefined) return "names comes with category_names";
    state.names = { ...(state.names ?? {}), [item.claim_id]: zh ?? {} };
    return { claim_id: item.claim_id, chart_type: type, sql: item.series.sql, ...Object.fromEntries(row.fields.map((key) => [key, fields[key]])), ...(names !== undefined ? { category_names: names } : {}), ...(row.fixed ?? {}), ...(row.ranked ? rankedEmphasis(item.series.rows, fields.category_field, fields.value_field) : {}), claim_spec: { claim_id: item.claim_id, relation: row.relation } };
  }

  /** A ranking's order and emphasis from its own rows: high to low, and the categories of the highest and the lowest value (the first row
   *  of each, in row order) in the accent. Fewer than two numeric rows, or all equal: the order only. */
  function rankedEmphasis(rows, category, value) {
    const numeric = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r[value] === "number" && Number.isFinite(r[value]) && r[category] !== undefined && r[category] !== null);
    if (numeric.length < 2) return { sort: "desc" };
    const top = numeric.reduce((a, b) => (b[value] > a[value] ? b : a));
    const bottom = numeric.reduce((a, b) => (b[value] < a[value] ? b : a));
    return top[value] === bottom[value] ? { sort: "desc" } : { sort: "desc", highlight_values: [String(top[category]), String(bottom[category])] };
  }

  /** The data shape the matcher needs, from the series columns and rows alone. An entity column the candidate SQL named country_iso2 or country_iso3
   *  (claim_candidates ENTITY_ALIASES, new route only) carries its code scheme in its name, and every chart of it names the codes (`named`). */
  async function sheetShape(series, codeScheme) {
    const columns = Array.isArray(series.columns) ? series.columns.map(String) : [];
    const rows = Array.isArray(series.rows) ? series.rows : [];
    const value = columns.includes("change") ? "change" : "value";
    const entity = ["country_iso2", "country_iso3"].find((name) => columns.includes(name)) ?? "name";
    const names = [...new Set(rows.map((row) => String(row?.[entity] ?? "")))];
    const timeAxis = columns.includes("year") && names.length === 1 && rows.length > 1;
    const named = entity !== "name" && !timeAxis;
    const scheme = named ? entity.slice("country_".length) : !timeAxis && typeof codeScheme === "function" ? await codeScheme(names) : null;
    const kind = timeAxis ? "time" : scheme ? "geo_code" : "category";
    const relations = timeAxis ? ["trend"] : value === "change" ? ["comparison"] : scheme ? ["rank", "geography"] : ["rank"];
    return { dimension: timeAxis ? "year" : entity, value, scheme, named, need: { relations, kind, rows: rows.length, resolvable: Boolean(scheme) } };
  }

  /** The model's charts (judgement only, matched to the sheet by claim_id or position) plus the program fields; null when a program field was changed. */
  function mergeSheetCharts(sent) {
    const wrong = [];
    const merged = state.sheet.charts.map((own, index) => {
      const mine = sent.find((item) => item && typeof item === "object" && item.claim_id === own.claim_id) ?? (sent.length === state.sheet.charts.length && !sent.some((item) => item?.claim_id) ? sent[index] : null) ?? {};
      // New route: every field the sheet filled from a template row is the program's too (source, target and series fields, a fixed unit).
      const keys = deps.next === true ? [...new Set([...SHEET_CHART_KEYS, ...Object.keys(own).filter((key) => key !== "claim_spec")])] : SHEET_CHART_KEYS;
      for (const key of keys) if (mine[key] !== undefined && JSON.stringify(mine[key]) !== JSON.stringify(own[key])) wrong.push(`charts[${index}].${key}`);
      for (const key of Object.keys(own.claim_spec)) if (mine.claim_spec?.[key] !== undefined && mine.claim_spec[key] !== own.claim_spec[key]) wrong.push(`charts[${index}].claim_spec.${key}`);
      return { ...mine, ...own, claim_spec: { ...(mine.claim_spec ?? {}), ...own.claim_spec } };
    });
    if (wrong.length) { problems.push({ step: "charts", message: `DESIGN_PACK_PROGRAM_FIELD: the sheet fills ${wrong.join(", ")}; you sent a different value. Leave ${wrong.length > 1 ? "them" : "it"} out of charts.` }); return null; }
    return merged;
  }

  function setDraft(path, text, row) {
    drafts[path] = text;
    audit.push({ ...row, path });
  }

  function setField(target, key, path, text, row) {
    target[key] = text;
    setDraft(path, text, row);
  }

  /** The steps the chain tool really ran, as it reported them: tool, params and details of each, nothing rebuilt from refs. */
  function recordedSteps(steps) {
    return Array.isArray(steps) ? steps.filter((entry) => entry && typeof entry === "object").map((entry) => ({ tool: entry.tool, params: entry.params, details: entry.details })) : [];
  }

  // The browser report carries the screenshots; the audit reads the report from disk, so the record leaves it out.
  function recordPublicationStep(tool, params, result) {
    const { report: _report, ...details } = result?.details ?? {};
    innerRecord.publication.push({ tool, params, details });
  }

  /** The inner steps of the last page and publication that went through, only when the whole pack is RENDERED; otherwise null. */
  function innerSteps(status) {
    if (status !== "RENDERED") return null;
    const steps = [...(innerRecord.page ?? []), ...(innerRecord.publication ?? [])];
    return steps.length === INNER_STEP_TOOLS.length && steps.every((entry, index) => entry.tool === INNER_STEP_TOOLS[index]) ? steps : null;
  }

  function finish() {
    const complete = !problems.length && part !== "first" && Boolean(refs.publicationQaRef);
    const images = complete ? [...(state.pageImages ?? []), ...[state.qaImage].filter(Boolean)] : previewed && !problems.length ? [...(state.pageImages ?? [])] : [];
    const status = problems.length ? "STOPPED" : part === "first" ? "FIRST_HALF_DONE" : previewed ? "PREVIEWED" : "RENDERED";
    return { status, problems, notes, refs, drafts, audit, images, submissions: state.submissions ?? 0, revisions: state.revisions ?? 0, steps: complete ? innerSteps(status) : null, ...(runStop ? { runStop } : {}), ...nextOf(status) };
  }

  /** Page build: every result ends with the one next step, so the model never has to guess it. */
  function nextOf(status) {
    if (!deps.pageBuild) return {};
    if (status === "RENDERED") return { next: "Next: call newsroom_infographic_vision_critic with your own verdict on the images." };
    if (status === "SHEET") return { next: "Next: call newsroom_design_pack with your judgement (discovery, story_graph, visual_concepts, semantic_novelty, asset_requirements, charts, page, publication); the program fills the rest." };
    if (status === "FIRST_HALF_DONE") return { next: "Next: send newsroom_design_pack with part \"second\" (charts judgement, page, publication)." };
    if (status === "PREVIEWED") return { next: "Next: newsroom_infographic_vision_critic on the preview images, then newsroom_design_pack with part \"publish\"." };
    if (runStop) return { next: "Next: nothing. The run is stopped; report in the final answer what is missing." };
    if (state.rejected?.ref) return { next: `Next: call newsroom_design_pack with patch_of=${state.rejected.ref} and ops that fix the refusal, nothing else.` };
    return { next: "Next: fix the listed problem(s) and send newsroom_design_pack again." };
  }
}

/**
 * What the call's details carry for the completion check: the chain name, COMPLETE and the recorded inner steps, only when the pack is RENDERED and
 * the outcome holds exactly the eight steps in order. Anything else (stopped, half done, no record, a record that is short or out of order, a status
 * that is not RENDERED) carries nothing, so the check never reads a partial or invented record.
 */
export function innerRecordOf(out) {
  if (out?.status !== "RENDERED" || !Array.isArray(out.steps)) return {};
  const whole = out.steps.length === INNER_STEP_TOOLS.length && out.steps.every((entry, index) => entry?.tool === INNER_STEP_TOOLS[index]);
  return whole ? { chain: "newsroom_design_pack", chainStatus: "COMPLETE", steps: out.steps } : {};
}

/** The text the model reads back. It never says the page is complete. */
export function designPackText(out) {
  const lines = [];
  if (out.status === "RENDERED") {
    lines.push("RENDERED: the page plan, page render and checks, publication plan, render and browser QA all passed. The page is NOT complete: look at the images, then call newsroom_infographic_vision_critic with your own verdict.");
    lines.push(`Refs: ${Object.entries(out.refs).filter(([, value]) => typeof value === "string").map(([key, value]) => `${key}=${value}`).join(" ")}`);
    lines.push("Drafted text (keep with \"=\" or rewrite through newsroom_design_pack revise; numbers only as placeholders over that chart's rows):");
    for (const [path, text] of Object.entries(out.drafts)) lines.push(`- ${path}: ${text}`);
    lines.push(`Revisions used: ${out.revisions}/${MAX_REVISIONS}.`);
  } else if (out.status === "SHEET") {
    lines.push(out.sheetText || "SHEET: the program filled the charts; send the judgement.");
    if (out.next) lines.push(out.next);
    return lines.join("\n");
  } else if (out.status === "PREVIEWED") {
    lines.push(`PREVIEWED: the page plan, page render, checks and preview passed; nothing is published yet. Refs: ${Object.entries(out.refs).filter(([, value]) => typeof value === "string").map(([key, value]) => `${key}=${value}`).join(" ")}`);
  } else if (out.status === "FIRST_HALF_DONE") {
    lines.push(`FIRST_HALF_DONE: discovery, story graph, concepts, novelty and assets passed. Now send part "second" with charts, page and publication. Refs: ${Object.entries(out.refs).filter(([, value]) => typeof value === "string").map(([key, value]) => `${key}=${value}`).join(" ")}`);
  } else {
    lines.push(`STOPPED: ${out.problems.length} problem(s); nothing was retried or changed. Fix them and send the pack again (${out.submissions}/${MAX_SUBMISSIONS} sends used).`);
    out.problems.forEach((problem, index) => lines.push(`(${index + 1}) [${problem.step}] ${problem.message}`));
  }
  for (const note of out.notes) lines.push(`Note: ${note}`);
  if (out.next) lines.push(out.next);
  const placeholders = out.audit.filter((row) => row.origin === "placeholder").length;
  const copied = out.audit.filter((row) => row.origin === "copied_model_text").length;
  const rewritten = out.audit.filter((row) => row.rewritten).length;
  lines.push(`Drafted text audit: ${placeholders} field(s) with numbers filled from placeholders; ${copied} copied from your own words (none with a number); ${rewritten} rewritten by you. This is a record of where each number came from, not a check.`);
  return lines.join("\n");
}
