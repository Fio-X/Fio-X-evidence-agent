// Mutation check for NEWSROOM_SPEED_FILL_COPIED_REFS: each mutant below must turn scripts/test_fill_copied_refs.mjs red.
import { runMutants } from "./mutant_lib.mjs";

const SW = `process.env.NEWSROOM_SPEED_FILL_COPIED_REFS === "1"`;
runMutants({
  test: "test_fill_copied_refs.mjs",
  mutants: [
    { name: "switch always on", find: `return ${SW};`, replace: "return true;", mustSay: /a\.plan\.includes\("story_graph_ref"\)/ },
    { name: "switch never on", find: `return ${SW};`, replace: "return false;", mustSay: /!b\.plan\.includes\("story_graph_ref"\)/ },
    { name: "a given story_graph_ref is overwritten", find: "if (!fillCopiedEnabled() || params?.story_graph_ref !== undefined) return params;", replace: "if (!fillCopiedEnabled()) return params;", mustSay: /story-graphs\/other\.json/ },
    { name: "several candidates: the first is taken", find: "if (found.found.length === 1) return found.found[0];", replace: "if (found.found.length >= 1) return found.found[0];", mustSay: /2 candidates/ },
    { name: "truncated scan is not refused", find: "if (found.truncated) throw preflightError(tool, [", replace: "if (false) throw preflightError(tool, [", mustSay: /more than 200 artifacts to scan/ },
    { name: "a given lint plan_ref is overwritten", find: "fillCopiedEnabled() && givenParams?.plan_ref === undefined", replace: "fillCopiedEnabled()", mustSay: /plans\/nope\.json/ },
    { name: "plan_ref stays required with the switch on", find: "const optionalWhenFillCopied = (schema: any) => (fillCopiedEnabled() ? Type.Optional(schema) : schema);", replace: "const optionalWhenFillCopied = (schema: any) => schema;", mustSay: /!b\.plan\.includes\("story_graph_ref"\)/ },
    { name: "harmless comment", find: "function fillCopiedEnabled() {", replace: "// harmless\nfunction fillCopiedEnabled() {", mustSay: null },
  ],
});
