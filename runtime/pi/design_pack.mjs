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

const LIMITS = Object.freeze({ chart_title: 40, page_title: 40, dek: 120, body: 140, alt: 260, summary: 140, long: 600 });
export const MAX_SUBMISSIONS = 3;
export const MAX_REVISIONS = 2;

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

function chartName(chartType, zh) {
  const names = zh
    ? { horizontal_bar: "条形图", dot: "圆点图", line: "折线图", choropleth: "地图" }
    : { horizontal_bar: "Bar chart", dot: "Dot chart", line: "Line chart", choropleth: "Map" };
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

/** The text before the SQL runs: title from the model's own measure words (dropped when they hold a number), and the L1 line. */
export function draftBeforeRows(plan, numberWordIn) {
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
  const l1 = l1Line(plan, zh);
  if (l1 && !hasNumber(l1, numberWordIn)) out.l1 = l1;
  return out;
}

function l1Line(plan, zh) {
  const type = String(plan?.chart_type ?? "");
  const name = chartName(type, zh);
  if (!name) return null;
  const value = String(measureOf(plan)?.phenomenon ?? plan?.value_field ?? "").trim();
  const category = String(plan?.category_field ?? "").trim();
  const time = String(plan?.time_field ?? "").trim();
  if (type === "line") return time && value ? (zh ? `${name}，${time}对${value}` : `${name} of ${value} by ${time}`) : null;
  if (type === "choropleth") return category && value ? (zh ? `${name}，按${category}着色，色值为${value}` : `${name} shaded by ${value} for each ${category}`) : null;
  return category && value ? (zh ? `${name}，按${category}列出${value}` : `${name} of ${value} for each ${category}`) : null;
}

/** Templates with placeholders over the chart's own rows (L2, and L3 for an evenly spaced time series). */
export function rowTemplates(plan, rows, numberWordIn) {
  const zh = plan?.language !== "en";
  const type = String(plan?.chart_type ?? "");
  if (!TEMPLATE_CHART_TYPES.includes(type)) return null;
  const value = String(plan?.value_field ?? "").trim();
  if (!value) return null;
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
export function publicationModuleFor(plan, refs) {
  const type = String(plan?.chart_type ?? "");
  const row = Object.prototype.hasOwnProperty.call(PUBLICATION_TYPES, type) ? PUBLICATION_TYPES[type] : null;
  if (!row) throw new Error(`DESIGN_PACK_NO_PUBLICATION_TYPE: chart type '${type}' has no publication counterpart (known: ${Object.keys(PUBLICATION_TYPES).join(", ")}); the pack does not fall back to a statistical chart`);
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
  try { filled = await deps.fill(value, ctx.rows, ctx.plan); } catch (error) { return { problem: `${path}: ${error?.message ?? error}` }; }
  const direction = directionProblem(filled.text, ctx.direction);
  if (direction) return { problem: `${path}: ${direction}` };
  return { text: filled.text, audit: { path, origin: "model", rewritten: true, template: value, computation_ref: ctx.computationRef ?? null, bindings: filled.bindings, direction: ctx.direction ?? null } };
}

/** Fill a drafted template; a template the filler refuses (a tie, a missing column) leaves the field undrafted, with the reason. */
async function drafted(deps, path, template, ctx, extra = {}) {
  try {
    const filled = await deps.fill(template, ctx.rows, ctx.plan);
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
export async function runDesignPack(deps, params, state) {
  const problems = [];
  const notes = [];
  const audit = [];
  const drafts = {};
  const refs = {};
  let pack = params ?? {};
  let revise = null;
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
  }
  const part = pack.part ?? "both";
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
    problems.push({ step: "needs_compute", message: `DESIGN_PACK_NEEDS_COMPUTE: stopped before newsroom_viz_plan. Record these first with duckdb_query and record_claim, then send the pack again: ${missing.join("; ")}` });
    return finish();
  }

  // ---- charts ----
  const charts = Array.isArray(pack.charts) ? pack.charts : [];
  if (!charts.length) { problems.push({ step: "charts", message: "DESIGN_PACK_NO_CHARTS: charts lists the newsroom_viz_plan judgement of each chart" }); return finish(); }
  const chartOut = [];
  for (let index = 0; index < charts.length; index += 1) chartOut.push(await chart(index, charts[index]));
  if (chartOut.some((out) => !out)) return finish();

  // ---- page plan through the infographic chain ----
  const page = await pagePlan(chartOut);
  if (!page) return finish();

  // ---- publication plan, render, QA ----
  await publication(page, chartOut);
  state.lastPack = { ...pack, revise: undefined };
  state.lastDrafts = { ...drafts };
  return finish();

  // -------------------------------------------------------------------------------------------------------------------
  function stop(code, message) {
    return { status: "STOPPED", code, problems: [{ step: "pack", message: `${code}: ${message}` }], notes: [], refs: {}, drafts: {}, audit: [], images: [] };
  }

  function schemaHintFor(tool) {
    try { return typeof deps.schemaOf === "function" ? schemaHint(tool, deps.schemaOf(tool)) : ""; } catch { return ""; }
  }

  async function step(tool, toolParams, label = tool) {
    if (!deps.enabled(tool)) { problems.push({ step: label, message: `TOOL_NOT_ENABLED: ${tool} is not enabled in this phase/profile` }); return null; }
    try { return await deps.call(tool, toolParams, label); } catch (error) { problems.push({ step: label, message: `${String(error?.message ?? error)}${schemaHintFor(tool)}` }); return null; }
  }

  async function firstHalf() {
    const skipped = (label, cause) => problems.push({ step: label, message: `not run: ${cause} was refused` });
    const discovery = await step("newsroom_editorial_discovery", pack.discovery ?? {});
    if (discovery) refs.discoveryRef = discovery.details?.discoveryRef;
    const story = await step("newsroom_story_graph", pack.story_graph ?? {});
    if (story) refs.storyGraphRef = story.details?.storyGraphRef;
    let concepts = null;
    if (discovery) {
      concepts = await step("newsroom_visual_concepts", { ...(pack.visual_concepts ?? {}), discovery_ref: refs.discoveryRef });
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
    const templated = TEMPLATE_CHART_TYPES.includes(String(plan.chart_type ?? ""));
    const before = templated ? draftBeforeRows(plan, deps.numberWordIn) : {};
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
    try { publicationRefs = publicationModuleFor(vizPlan, { desktopSvgRef: manifest?.variants?.desktop ?? null, computationRef: String(st.computationRef) }); } catch (error) { problems.push({ step: label, message: String(error?.message ?? error) }); return null; }
    const ctx = { rows, plan: vizPlan, computationRef: String(st.computationRef), direction: null };
    const templates = templated ? rowTemplates(vizPlan, rows, deps.numberWordIn) : null;
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
    const planParams = { ...pageIn, story_graph_ref: refs.storyGraphRef, editorial_discovery_ref: refs.discoveryRef, visual_concept_ref: refs.conceptRef, selected_concept_id: pageIn.selected_concept_id ?? refs.selectedConceptId, novelty_ref: refs.noveltyRef, asset_plan_ref: refs.assetPlanRef };
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
      const names = [...new Set(chartOut.map((out) => chartName(out.plan.chart_type, zh)).filter(Boolean))];
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
    const outcome = await deps.runChain("infographic", planParams, "page");
    if (outcome.status !== "COMPLETE") { problems.push({ step: "page", message: chainStopText(outcome) }); return null; }
    refs.infographicPlanRef = outcome.state?.planRef;
    refs.infographicManifestRef = outcome.state?.manifestRef;
    refs.infographicCriticRef = outcome.state?.criticRef;
    refs.previewRef = outcome.state?.previewRef;
    return { params: planParams, modules: outModules, images: outcome.images ?? [] };
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
      reader_question: page.params.reader_question,
      visual_thesis: page.params.visual_thesis,
      ...(page.params.language ? { language: page.params.language } : {}),
      ...(pubIn.style_profile !== undefined ? { style_profile: pubIn.style_profile } : {}),
      ...(pubIn.source_note !== undefined ? { source_note: pubIn.source_note } : {}),
      modules,
    };
    const planned = await step("newsroom_publication_plan", planParams);
    if (!planned) return;
    refs.publicationPlanRef = planned.details?.planRef;
    const rendered = await step("newsroom_publication_render", { plan_ref: refs.publicationPlanRef });
    if (!rendered) return;
    refs.publicationHtmlRef = rendered.details?.htmlRef;
    refs.publicationManifestRef = rendered.details?.manifestRef;
    const qa = await step("newsroom_publication_qa", { plan_ref: refs.publicationPlanRef, manifest_ref: refs.publicationManifestRef });
    if (!qa) return;
    refs.publicationQaRef = qa.details?.reportRef;
    // A browser that did not start judged nothing: that is not a pass.
    if (qa.details?.judged === false) problems.push({ step: "newsroom_publication_qa", message: "DESIGN_PACK_QA_NOT_JUDGED: the browser check did not judge the page, so it has not passed" });
    else if (qa.details?.passed !== true) problems.push({ step: "newsroom_publication_qa", message: `DESIGN_PACK_QA_FAILED: ${textResultOf(qa).slice(0, 400)}` });
    state.pageImages = page.images;
    state.qaImage = problems.length ? null : await deps.screenshot(qa);
  }

  function setDraft(path, text, row) {
    drafts[path] = text;
    audit.push({ ...row, path });
  }

  function setField(target, key, path, text, row) {
    target[key] = text;
    setDraft(path, text, row);
  }

  function finish() {
    const complete = !problems.length && part !== "first" && Boolean(refs.publicationQaRef);
    const images = complete ? [...(state.pageImages ?? []), ...[state.qaImage].filter(Boolean)] : [];
    return { status: problems.length ? "STOPPED" : part === "first" ? "FIRST_HALF_DONE" : "RENDERED", problems, notes, refs, drafts, audit, images, submissions: state.submissions ?? 0, revisions: state.revisions ?? 0 };
  }
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
  } else if (out.status === "FIRST_HALF_DONE") {
    lines.push(`FIRST_HALF_DONE: discovery, story graph, concepts, novelty and assets passed. Now send part "second" with charts, page and publication. Refs: ${Object.entries(out.refs).filter(([, value]) => typeof value === "string").map(([key, value]) => `${key}=${value}`).join(" ")}`);
  } else {
    lines.push(`STOPPED: ${out.problems.length} problem(s); nothing was retried or changed. Fix them and send the pack again (${out.submissions}/${MAX_SUBMISSIONS} sends used).`);
    out.problems.forEach((problem, index) => lines.push(`(${index + 1}) [${problem.step}] ${problem.message}`));
  }
  for (const note of out.notes) lines.push(`Note: ${note}`);
  const placeholders = out.audit.filter((row) => row.origin === "placeholder").length;
  const copied = out.audit.filter((row) => row.origin === "copied_model_text").length;
  const rewritten = out.audit.filter((row) => row.rewritten).length;
  lines.push(`Drafted text audit: ${placeholders} field(s) with numbers filled from placeholders; ${copied} copied from your own words (none with a number); ${rewritten} rewritten by you. This is a record of where each number came from, not a check.`);
  return lines.join("\n");
}
