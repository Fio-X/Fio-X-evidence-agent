// The wording and enum edits that took `category_names` from two modes (worldbank, iso3) to four (worldbank, iso3, iso2,
// iso4217) and from three chart name fields to every field a chart prints a place or currency in.
//
// Several suites assert that a tool surface is byte-identical to an older git baseline (a4d4cb0, bc1ccfd, the integration
// head), and those baselines carry the old wording. The wording change is intended, so each of those suites compares the
// baseline with the CURRENT surface after revertNameLocalization() has put the old wording back. Everything else must still
// match byte for byte, exactly as before. The revert is strict, the way maskMeasureSemantics and APPROVED_LATER are in the
// suites that already declare an intended difference: every declared fragment has to be present the expected number of
// times in the expected tool. A change that is reverted, or that spreads to another tool, fails here instead of being
// tolerated.
//
// The edits are data below, not a regex over "anything that mentions category_names", so a new wording change to the same
// strings is a visible edit of this file.
import assert from "node:assert/strict";

// The `category_names` enum.
const ENUM = Object.freeze({ before: Object.freeze(["worldbank", "iso3"]), after: Object.freeze(["worldbank", "iso3", "iso2", "iso4217"]) });

// Fragments of the `category_names` field description (present in newsroom_viz_plan and, because the chain takes the plan's
// properties, in newsroom_viz_chain).
const DESCRIPTION_EDITS = Object.freeze([
  {
    id: "description: chart fields",
    before: "series_field for multi_line):",
    after: "series_field for multi_line, label_field for scatter, source_field and target_field for sankey/alluvial):",
  },
  {
    id: "description: modes",
    before: "'iso3' when values are exact ISO3 economy/aggregate codes. On a zh chart",
    after: "'iso3' when values are exact ISO3 economy/aggregate codes, 'iso2' when values are exact ISO 3166-1 alpha-2 economy codes, 'iso4217' when values are exact ISO 4217 currency codes (not for choropleth). On a zh chart",
  },
]);

// Fragments of two newsroom_viz_plan prompt guidelines.
const GUIDELINE_EDITS = Object.freeze([
  {
    id: "guideline: choropleth modes",
    before: "category_names='worldbank' or 'iso3'; category_field joins",
    after: "category_names='worldbank', 'iso3' or 'iso2'; category_field joins",
  },
  {
    id: "guideline: choropleth values",
    before: "an exact World Bank name or ISO3 code, never a paraphrase",
    after: "an exact World Bank name, ISO3 code or ISO2 code, never a paraphrase",
  },
  {
    id: "guideline: zh pages",
    before: "lint blocks any value that table cannot resolve.",
    after: "lint blocks any value that table cannot resolve. On zh pages a country name field is the ISO3 code column with category_names='iso3' (ISO2 codes: 'iso2') and a currency name field is the ISO 4217 code column with category_names='iso4217'; drop aggregate rows (OWID_*, regions, income groups) in SQL, and never type a translated name.",
  },
]);

// Which tool carries which edit. Any other tool must carry none (its surface is compared unchanged).
const TOOLS = Object.freeze({
  newsroom_viz_plan: { guidelines: true },
  newsroom_viz_chain: { guidelines: false },
});

export const NAME_LOCALIZATION_EDITS = Object.freeze({ enum: ENUM, description: DESCRIPTION_EDITS, guidelines: GUIDELINE_EDITS, tools: Object.keys(TOOLS) });

const sameArray = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * A copy of `tool` as it was before the name-localization edits. Other tools are returned as they are.
 *
 * `descriptions: false` is for a suite whose StringEnum stand-in drops the options object (only the enum values and the
 * prompt guidelines survive there); the description edits are then expected absent instead of present.
 * `enumValues: false` is for a suite whose stand-ins drop the enum values as well (only the prompt guidelines survive);
 * the enum edit is then expected absent instead of present.
 *
 * Throws when a declared edit is not found the expected number of times, so a reverted change cannot pass quietly.
 */
export function revertNameLocalization(tool, { descriptions = true, enumValues = true } = {}) {
  const scope = TOOLS[tool?.name];
  if (!scope) return tool;
  const found = new Map();
  const bump = (id, count) => found.set(id, (found.get(id) ?? 0) + count);
  const replaceIn = (text, edits) => {
    let out = text;
    for (const edit of edits) {
      const parts = out.split(edit.after);
      if (parts.length > 1) {
        bump(edit.id, parts.length - 1);
        out = parts.join(edit.before);
      }
    }
    return out;
  };
  const walk = (node, edits) => {
    if (typeof node === "string") return replaceIn(node, edits);
    if (Array.isArray(node)) {
      if (sameArray(node, ENUM.after)) {
        bump("enum", 1);
        return [...ENUM.before];
      }
      return node.map((item) => walk(item, edits));
    }
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, edits)]));
    return node;
  };
  const reverted = { ...tool, parameters: walk(tool.parameters, DESCRIPTION_EDITS) };
  if (tool.promptGuidelines !== undefined) reverted.promptGuidelines = walk(tool.promptGuidelines, GUIDELINE_EDITS);
  const expected = new Map([["enum", enumValues ? 1 : 0]]);
  for (const edit of DESCRIPTION_EDITS) expected.set(edit.id, descriptions ? 1 : 0);
  for (const edit of GUIDELINE_EDITS) expected.set(edit.id, scope.guidelines ? 1 : 0);
  for (const [id, count] of expected) {
    assert.equal(found.get(id) ?? 0, count, `name localization: ${tool.name} carries the declared edit '${id}' ${found.get(id) ?? 0} time(s), expected ${count} (see scripts/lib_name_localization_baseline.mjs)`);
  }
  return reverted;
}
