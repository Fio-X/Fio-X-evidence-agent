// Mutation check for NEWSROOM_SPEED_FILL_PUBLICATION_COPIED: each mutant below must turn scripts/test_trim_outputs.mjs or scripts/test_render_qa_tool_path.mjs red.
import { runMutants } from "./mutant_lib.mjs";

const SW = `process.env.NEWSROOM_SPEED_FILL_PUBLICATION_COPIED === "1"`;
runMutants({
  test: ["test_trim_outputs.mjs", "test_render_qa_tool_path.mjs"],
  mutants: [
    { name: "switch always on", find: `return ${SW};`, replace: "return true;", mustSay: /publication copy switch: the three fields optional on/ },
    { name: "switch never on", find: `return ${SW};`, replace: "return false;", mustSay: /publication copy switch: the three fields optional on/ },
    { name: "given values are overwritten from the plan", find: `filter((field) => params?.[field] === undefined);`, replace: `filter(() => true);`, mustSay: /reader_question must exactly match/ },
    { name: "a plan lacking the field is not refused", find: `if (empty.length) throw preflightError("newsroom_publication_plan"`, replace: `if (false) throw preflightError("newsroom_publication_plan"`, mustSay: /story_graph_ref is missing and could not be derived[\s\S]*visual_thesis is missing/ },
    { name: "a blank plan field counts as present", find: `|| !String(infographic[field]).trim());`, replace: `);`, mustSay: /visual_thesis is missing and could not be derived/ },
    { name: "fields stay required with the switch on", find: `const optionalWhenFillPublication = (schema: any) => (fillPublicationCopiedEnabled() ? Type.Optional(schema) : schema);`, replace: `const optionalWhenFillPublication = (schema: any) => schema;`, mustSay: /publication copy switch: the three fields optional on/ },
    { name: "every field is copied from reader_question", find: `String(infographic[field])])`, replace: `String(infographic.reader_question)])`, mustSay: /Artifact path must be under editorial\/story-graphs\// },
    { name: "approval check skipped when the switch is on", find: `await assertApprovedInfographicLineage(params.infographic_plan_ref);`, replace: `if (!fillPublicationCopiedEnabled()) await assertApprovedInfographicLineage(params.infographic_plan_ref);`, mustSay: /no top-level, non-rejected infographic manifest/ },
    { name: "copy step runs with nothing missing", find: `if (missing.length) params = `, replace: `if (true) params = `, mustSay: /./, equivalent: "spreading an empty list changes nothing" },
    { name: "harmless comment", find: "function fillPublicationCopiedEnabled() {", replace: "// harmless\nfunction fillPublicationCopiedEnabled() {", mustSay: null },
  ],
});
