import { numberWordInReason } from "./number_words.mjs";
// NEWSROOM_FORM_SKILL=1 (exact "1", default off): the form-selection step (skill-draft form-selection-1012). The program, not the
// model, brings the skeleton in: a chart plan that does not carry a valid candidate list is refused with the skeleton in the message.
// The plan carries candidates, chosen, rejected_by_rule (and user_named_form / chosen_reason when they apply).
// Nothing here grants verification; all claim, render and publication gates are unchanged.

export function formSkillEnabled() {
  return process.env.NEWSROOM_FORM_SKILL === "1";
}

export const FORM_CLASSES_CHART = ["comparison", "ranking", "change", "distribution", "composition", "relation", "space", "flow"];
export const FORM_CLASSES_NONCHART = ["big_number", "table", "one_sentence", "diagram", "vs_block"];
export const FORM_CLASSES = [...FORM_CLASSES_CHART, ...FORM_CLASSES_NONCHART];
export const MIN_CANDIDATES = 3;
export const REASON_MAX = 60;

// Only the draft's three structured sample rows (thresholds as written there, the strictest source taken). `rejects`: whether a
// candidate may be dropped by this rule; heatmap-cell-numbers is a hint about the legend, not a ground for dropping a form.
export const FORM_RULES = [
  { rule_id: "pie-max-categories", forms: ["pie", "donut"], limit: 5, count: "categories", rejects: true, source: "UNHCR 2-5, EU ~5, ONS 5-6, StatCan 2-6, Urban ~5; strictest <=5", strength: "advisory" },
  { rule_id: "stacked-max-series", forms: ["stacked_bar", "stacked_bar_100"], limit: 4, count: "series", rejects: true, source: "UK Gov <=4, US Gov <=5, Urban <=5-6; strictest <=4", strength: "advisory" },
  { rule_id: "heatmap-cell-numbers", forms: ["heatmap"], limit: null, count: null, rejects: false, source: "UNHCR needs legend and cell numbers, Urban usually no numbers; needs a legend", strength: "advisory" },
];

export const FORM_SKELETON = [
  "Form selection (the runtime added this; follow it):",
  "1. Write one sentence for what this block says to the reader; the user may change it.",
  "2. Tag the sentence: compare, rank, change, distribution, composition, relation, space, flow, process or scale.",
  "3. Write what the reader should be able to do after reading; the user confirms it.",
  "4. Read the data profile the program gives; do not count or guess whether categories overlap.",
  "5. List at least three candidate forms from different classes, at least one not a chart (big number, table, one sentence, diagram, vs block), one line of reason each, no numbers in the reason.",
  "6. The program drops candidates by its rule table; do not propose dropped ones again; if fewer than three are left, add more.",
  "7. If the user named a form it stays among the candidates; you may add one you think is better and say why.",
  "8. In a product run choose one of the remaining candidates and write one line of reason; the rejected ones go into the plan. Never choose for the user and never bypass a named form.",
  "9. Then continue with that chart type's recipe; verification, render QA and publication gates are unchanged and this step grants none.",
].join("\n");

// NEWSROOM_SPEED_FIRST_TRY_ALL: the same refusal, plus the text it found (a digit run or the number word with a little context).
function nearClause(reason) {
  const digit = /\d+/.exec(reason);
  const hit = digit ? [...reason.slice(Math.max(0, digit.index - 6), digit.index + digit[0].length + 6)].join("") : numberWordInReason(reason);
  return hit ? `: near "${hit}"; reword it without any number or number word` : "";
}

const norm = (value) => String(value ?? "").trim().toLowerCase();

/** The plan's selection fields, all in one pass. Returns messages; the caller adds the skeleton. */
export function formSelectionBlockers(params, opts = {}) {
  const out = [];
  const candidates = params?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    out.push("candidates is required: a list of {class, form, one_line_reason}");
    return out;
  }
  const forms = [];
  const classes = new Set();
  candidates.forEach((c, i) => {
    const form = norm(c?.form), cls = norm(c?.class), reason = String(c?.one_line_reason ?? "").trim();
    if (!form) out.push(`candidates[${i}] has no form`);
    else if (forms.includes(form)) out.push(`candidates[${i}] repeats the form '${form}'`);
    else forms.push(form);
    if (!FORM_CLASSES.includes(cls)) out.push(`candidates[${i}] class '${c?.class ?? ""}' must be one of ${FORM_CLASSES.join(", ")}`);
    else classes.add(cls);
    if (!reason) out.push(`candidates[${i}] needs one_line_reason`);
    else if ([...reason].length > REASON_MAX) out.push(`candidates[${i}] one_line_reason is over ${REASON_MAX} characters`);
    else if (/\d/.test(reason) || numberWordInReason(reason) !== null) out.push(`candidates[${i}] one_line_reason must not carry a number or number word${opts.nameHit ? nearClause(reason) : ""}`);
  });
  if (candidates.length < MIN_CANDIDATES) out.push(`at least ${MIN_CANDIDATES} candidates are required; got ${candidates.length}`);
  if (classes.size < 2) out.push("candidates must come from at least two different classes");
  if (![...classes].some((c) => FORM_CLASSES_NONCHART.includes(c))) out.push(`at least one candidate must not be a chart (${FORM_CLASSES_NONCHART.join(", ")})`);

  const chosen = norm(params.chosen);
  if (!chosen) out.push("chosen is required: one of the candidate forms");
  else if (!forms.includes(chosen)) out.push(`chosen '${params.chosen}' is not among the candidates`);
  else if (params.chart_type !== undefined && chosen !== norm(params.chart_type)) out.push(`chosen '${params.chosen}' must be the chart_type being planned ('${params.chart_type}'); a non-chart choice belongs in the page plan, not in a chart plan`);

  const named = norm(params.user_named_form);
  if (named) {
    if (!forms.includes(named)) out.push(`user_named_form '${params.user_named_form}' must stay among the candidates; it is the floor, not the ceiling`);
    if (chosen && chosen !== named && !String(params.chosen_reason ?? "").trim()) out.push(`chosen differs from user_named_form '${params.user_named_form}'; say why in chosen_reason (one line) so the user is told`);
  }
  if (params.chosen_reason !== undefined && [...String(params.chosen_reason)].length > REASON_MAX) out.push(`chosen_reason is over ${REASON_MAX} characters`);

  const rejected = params.rejected_by_rule ?? [];
  if (!Array.isArray(rejected)) out.push("rejected_by_rule must be a list of {form, rule_id}");
  else rejected.forEach((r, i) => {
    const rule = FORM_RULES.find((x) => x.rule_id === r?.rule_id);
    const form = norm(r?.form);
    if (!rule) out.push(`rejected_by_rule[${i}] rule_id '${r?.rule_id ?? ""}' is not in the rule table (${FORM_RULES.map((x) => x.rule_id).join(", ")})`);
    else if (!rule.rejects) out.push(`rejected_by_rule[${i}] rule '${rule.rule_id}' is a hint only and cannot drop a form`);
    else if (!rule.forms.includes(form)) out.push(`rejected_by_rule[${i}] rule '${rule.rule_id}' applies to ${rule.forms.join(", ")}, not '${r?.form ?? ""}'`);
    if (form && form === chosen) out.push(`rejected_by_rule[${i}] drops '${r.form}', which is also the chosen form`);
    if (named && form === named) out.push(`rejected_by_rule[${i}] drops the user-named form '${r.form}'; a user-named form is never dropped by a rule`);
  });
  return out;
}

/** Advisory hints for a form against a data profile {categories, series}; a hint never blocks. */
export function formRuleHints(form, profile = {}) {
  const f = norm(form), hints = [];
  for (const rule of FORM_RULES) {
    if (!rule.forms.includes(f)) continue;
    if (rule.limit !== null && Number.isFinite(profile[rule.count]) && profile[rule.count] > rule.limit) hints.push(`${rule.rule_id}: ${profile[rule.count]} ${rule.count} is over ${rule.limit} (${rule.source})`);
    if (rule.rule_id === "heatmap-cell-numbers") hints.push(`${rule.rule_id}: draw a legend (${rule.source})`);
  }
  return hints;
}

/** The refusal text: the problems, then the skeleton. Null when the plan's selection is fine. */
export function formSelectionRefusal(params, opts = {}) {
  const problems = formSelectionBlockers(params, opts);
  return problems.length ? `FORM_SELECTION: ${problems.join("; ")}\n${FORM_SKELETON}` : null;
}
