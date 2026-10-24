// Page skeleton and frozen choice lists (runtime/pi/page_skeleton.mjs). Offline, node only.
// 1. every value the program lists passes the existing validators; a value not listed is flagged by the list check and by the validator;
// 2. the lists are the existing constants (no copy that can drift): channel, goal and priority sets are compared with newsroom.ts and editorial_validators.mjs;
// 3. the skeleton holds program-owned leaves only, each with an origin by path, none of them a judgement field;
// 4. the lists are frozen (sha256) and carry no preselect, status or source-type field;
// 5. mutation: the consistency checks of 2 go red when the validator's accurate-channel list or the TS enum changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { INFOGRAPHIC_MODULE_TYPES, INFOGRAPHIC_STORY_ROLES, validateInfographicSpec } from "../runtime/pi/infographic.mjs";
import { COGNITIVE_GOALS, visualChannelOwnerValidator } from "../runtime/pi/editorial_validators.mjs";
import * as S from "../runtime/pi/page_skeleton.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TS = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const EV = readFileSync(join(ROOT, "runtime/pi/editorial_validators.mjs"), "utf8");
const FROZEN = { choices: "542d66c1e7a397d67a8b9b500e9b68970211e6a1c188e64f8789bf817d4506fa", judgment_field_paths: "b6fffb3a5ba27ccfd1321e164ac6bca4c9a61fa39c44668f2584e6c8bda2b0a4", rule_codes: "9ce6514ca7c12ae95b5c32403d3de48ccf9c6f12170670b22125fb902142b4ab", all: "e200ac3b8712ca94aa94c0ebf8659c1e5e9fc350118fd35a7948f2994e3ac42c" };
const results = [];
const ok = (name, f) => { f(); results.push(name); console.log(`  ok  ${name}`); };
const listOf = (source, re) => JSON.parse(`[${re.exec(source)[1]}]`.replace(/'/g, '"'));

// A spec the validator accepts apart from the field under test.
const specWith = (module) => ({ schema_version: "1.5.0", title: "t", dek: "d", alt: "a".repeat(40), intent: "i", primary_message: "p", story_arc: "problem_solution", audience: "general", quality_target: "publishable", modules: [module, { id: "b", type: "section_header", heading: "h" }, { id: "c", type: "section_header", heading: "h" }] });
const errorsOn = (field, module) => validateInfographicSpec(specWith({ id: "a", type: "section_header", heading: "h", ...module })).filter((e) => e.includes(`module 'a'`) && e.includes(field));

ok("1a every listed type, story_role and priority raises no error on its own field in validateInfographicSpec", () => {
  for (const type of S.offeredValues("type")) assert.deepEqual(errorsOn("unsupported type", { type, heading: "h", manifest_ref: "x", body: "b", claim_ids: ["c"], claim_id: "c", value: "1", label: "l", text: "t", asset_ref: "a", alt: "a".repeat(30), credit: "c", story_node_ids: ["n"], visual_grammar: "rank" }), [], type);
  for (const story_role of S.offeredValues("story_role")) assert.deepEqual(errorsOn("story_role", { story_role }), [], story_role);
  for (const priority of S.offeredValues("priority")) assert.deepEqual(errorsOn("priority", { priority }), [], String(priority));
});
ok("1b a value that is not listed is flagged by choiceProblems and by the validator", () => {
  assert.equal(S.choiceProblems({ type: "chart" }).length, 1);
  assert.equal(errorsOn("unsupported type", { type: "chart" }).length, 1);
  assert.equal(S.choiceProblems({ story_role: "ending" }).length, 1);
  assert.equal(errorsOn("story_role", { story_role: "ending" }).length, 1);
  for (const priority of [0, 6]) { assert.equal(S.choiceProblems({ priority }).length, 1); assert.equal(errorsOn("priority", { priority }).length, 1); }
  assert.equal(S.choiceProblems({ cognitive_goals: ["ORIENT", "WONDER"] }).length, 1);
  assert.equal(S.choiceProblems({ visual_channels: [{ channel: "hue", field: "f", role: "categorical" }] }).length, 1);
  assert.equal(S.choiceProblems({ claim_ids: ["claim-aaa", "claim-zzz"] }, ["claim-aaa"]).length, 1);
  assert.deepEqual(S.choiceProblems({ type: "visual", story_role: "hook", priority: 1, cognitive_goals: ["ORIENT"], claim_ids: ["claim-aaa"], visual_channels: [{ channel: "length", field: "f" }] }, ["claim-aaa"]), []);
});
ok("1c visual channels: single use of a listed channel is accepted; only colour-like channels for a quantity are refused, as the rule sentence says", () => {
  const rules = (channel) => visualChannelOwnerValidator(specWith({ id: "a", type: "visual", visual_channels: [{ channel, field: "v", role: "quantitative" }] })).map((i) => i.rule_id);
  for (const channel of S.offeredValues("visual_channels")) {
    const got = rules(channel);
    assert.ok(!got.includes("visual_channel.single_owner") && !got.includes("visual_channel.owner_required"), channel);
    assert.equal(got.includes("visual_channel.color_only_quantity"), !S.ACCURATE_CHANNELS.includes(channel), channel);
  }
  assert.ok(visualChannelOwnerValidator(specWith({ id: "a", type: "visual" })).some((i) => i.rule_id === "visual_channel.owner_required"), "empty channel list is refused");
  assert.ok(visualChannelOwnerValidator(specWith({ id: "a", type: "visual", visual_channels: [{ channel: "length", field: "x", role: "quantitative" }, { channel: "length", field: "y", role: "categorical" }] })).some((i) => i.rule_id === "visual_channel.single_owner"));
  for (const code of S.RULE_CODES) assert.ok(EV.includes(`'${code}'`), `${code} is a rule code of editorial_validators.mjs`);
});

const channelsConsistent = (tsSource, evSource) => {
  const tsChannels = listOf(tsSource, /const VISUAL_CHANNEL_NAMES = \[([^\]]*)\]/);
  const accurate = listOf(evSource, /const accurate = quantitative\.some\(\(owner\) => \[([^\]]*?)(?:, \.\.\.\(process)/);
  assert.deepEqual(S.VISUAL_CHANNELS, tsChannels, "channel list = VISUAL_CHANNEL_NAMES");
  assert.deepEqual(S.ACCURATE_CHANNELS, accurate, "accurate channels = the validator's");
};
const goalsConsistent = (tsSource) => {
  const tsGoals = listOf(tsSource, /cognitive_goals: leanGrammar \? Type\.Optional\(Type\.Array\(StringEnum\(\[([^\]]*)\] as const/);
  assert.deepEqual([...S.offeredValues("cognitive_goals")], tsGoals);
};
ok("2 the lists are the existing constants (TS channel enum, accurate channels of the validator, goals, types, roles, priority 1..5)", () => {
  channelsConsistent(TS, EV);
  goalsConsistent(TS);
  assert.deepEqual(S.offeredValues("type"), INFOGRAPHIC_MODULE_TYPES);
  assert.deepEqual(S.offeredValues("story_role"), INFOGRAPHIC_STORY_ROLES);
  assert.deepEqual(S.offeredValues("cognitive_goals"), COGNITIVE_GOALS);
  assert.match(TS, /priority: Type\.Optional\(Type\.Integer\(\{ minimum: 1, maximum: 5 \}\)\)/);
  assert.deepEqual(S.offeredValues("priority"), [1, 2, 3, 4, 5]);
});

const CHARTS = [{ id: "m1", chart_type: "horizontal_bar", manifest_ref: "visualizations/a.json", critic_ref: "visualizations/a-critic.json" }, { id: "m2", chart_type: "sankey", manifest_ref: "visualizations/b.json" }, { id: "m3", chart_type: "choropleth", manifest_ref: "visualizations/c.json", critic_ref: "visualizations/c-critic.json" }];
const REFS = { story_graph_ref: "infographics/story.json", discovery_ref: "editorial/d.json", concept_ref: "editorial/c.json", novelty_ref: "editorial/n.json" };
ok("3 skeleton: program-owned leaves only, each with an origin by path, no judgement field, mark_semantics only for the four table rows", () => {
  const { params, origin } = S.buildSkeleton({ refs: REFS, charts: CHARTS });
  const leaves = S.skeletonLeafPaths(params);
  assert.ok(leaves.length >= 10);
  for (const leaf of leaves) { assert.ok(origin[leaf], `no origin for ${leaf}`); assert.ok(!S.isJudgmentPath(leaf), `${leaf} is a judgement field`); }
  assert.deepEqual(Object.keys(origin).filter((p) => !leaves.includes(p)), [], "origin lists only leaves");
  assert.equal(params.modules[0].quantitative_encoding.mark_semantics, "length");
  assert.equal(params.modules[1].quantitative_encoding, undefined, "sankey: the model decides");
  assert.equal(params.modules[2].quantitative_encoding.mark_semantics, "color");
  assert.match(origin["/modules/0/quantitative_encoding/mark_semantics"], /^table:/);
  assert.match(origin["/modules/0/manifest_ref"], /^artifact:/);
  assert.equal(params.asset_requirements_ref, undefined, "a ref that was not given is not made up");
  for (const forbidden of ["type", "story_role", "priority", "claim_ids", "visual_channels", "visual_grammar", "title", "dek", "alt"]) assert.ok(!JSON.stringify(params.modules).includes(`"${forbidden}"`) && !(forbidden in params), forbidden);
});

ok("4 frozen: sha256 of the choice list, the judgement paths and the rule codes; no preselect, status or source-type field", () => {
  const frozen = S.frozenSha256();
  assert.deepEqual(frozen, FROZEN, "the lists changed: this is a new freeze and needs review");
  const text = JSON.stringify(S.frozenForm());
  for (const word of ["default", "selected", "preselect", "recommended", "status", "source_type", "verified_by", "origin"]) assert.ok(!new RegExp(`"${word}`, "i").test(text.replace(/per request: the verified claim ids/, "")), word);
  for (const field of S.JUDGMENT_FIELD_PATHS) assert.deepEqual(Object.keys(field), ["path", "kind"]);
  assert.ok(S.JUDGMENT_FIELD_PATHS.every((f) => ["choice", "judgment", "text"].includes(f.kind)));
});

ok("5 request sheet: R3 lists the claims and the six lists, no value is preselected; R4/R6 carry patch_of written by the program", () => {
  const skeleton = S.buildSkeleton({ refs: REFS, charts: CHARTS });
  const claims = [{ id: "claim-aaa", summary: "A is 3 times B" }, { id: "claim-bbb", summary: "C fell in 2020" }];
  const r3 = S.requestSheet({ round: "R3", skeleton, claims });
  for (const question of S.CHOICE_QUESTIONS) assert.ok(r3.includes(`- ${question.id}:`), question.id);
  assert.ok(r3.includes("claim-aaa") && r3.includes("claim-bbb"));
  assert.ok(r3.includes(JSON.stringify(skeleton.params)));
  assert.ok(!/patch_of/.test(r3));
  const choiceBytes = S.CHOICE_QUESTIONS.map((q) => `- ${q.id}: ${q.question} [${S.offeredValues(q.id, claims.map((c) => c.id)).join(" | ")}]`).join("\n");
  console.log(`      R3 request sheet ${Buffer.byteLength(r3)} bytes (skeleton ${Buffer.byteLength(JSON.stringify(skeleton.params))}, choice list ${Buffer.byteLength(choiceBytes)}), for ${CHARTS.length} charts and ${claims.length} claims`);
  const ref = `infographics/chain-rejections/${"ab".repeat(32)}.json`;
  for (const round of ["R4", "R6"]) {
    const sheet = S.requestSheet({ round, rejectionRef: ref, refusal: "params.dek is required" });
    assert.ok(sheet.includes(`patch_of=${ref}`) && sheet.includes("newsroom_infographic_chain_patch") && sheet.includes("params.dek is required"));
  }
  for (const bad of ["", "infographics/chain-rejections/x.json", "../chain-rejections/" + "ab".repeat(32) + ".json", `infographics/chain-rejections/${"ab".repeat(32)}.json/../x`]) assert.throws(() => S.requestSheet({ round: "R4", rejectionRef: bad }), /REQUEST_SHEET_PATCH_OF/);
  assert.throws(() => S.requestSheet({ round: "R5" }), /REQUEST_SHEET_ROUND/);
});

ok("6 mutation: the consistency checks go red when the validator's accurate list, the TS channel enum or the TS goal enum changes", () => {
  assert.throws(() => channelsConsistent(TS, EV.replace("['position', 'length', 'area', 'size', 'angle', ...(process", "['position', 'length', 'area', 'size', ...(process")), /accurate channels/);
  assert.throws(() => channelsConsistent(TS.replace('"opacity", "shape", "connection"] as const;', '"opacity", "shape"] as const;'), EV), /channel list/);
  assert.throws(() => goalsConsistent(TS.replace('["ORIENT", "ZOOM", "EXPLAIN", "MEASURE", "COMPARE", "CONSEQUENCE"] as const', '["ORIENT", "ZOOM", "EXPLAIN", "MEASURE", "COMPARE"] as const')));
});
console.log(`\n${results.length} checks passed`);
