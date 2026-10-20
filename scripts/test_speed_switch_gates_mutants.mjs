// Mutation check for scripts/test_speed_switch_gates.mjs: each gate below is weakened once, in a temp copy, and the one matrix cell that
// should notice is run (--only=<case> --config=<name>). A mutant counts as caught only when the run is red AND prints that mutant's own
// reason text. `equivalent:` marks a mutant no test can see today; the reason says who covers it, or that it is a known gap.
// A gap mark must be dropped in the same commit that adds the assertion (the lib fails a mark that a test catches).
// Each control run must print the targeted cell as P (a skipped cell is not a control).
import { runMutants } from "./mutant_lib.mjs";

const TEST = "test_speed_switch_gates.mjs";
const esc = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
// the unmutated run must show every selected cell of this case as P (no s, F, p or .; case 10 below is the exception)
// (case 10 prints p, "pass with a skipped sub-case": two phase/profile pairs do not register newsroom_viz_plan by design; s, F and . still fail)
const cellsPass = (n, ok = "P") => new RegExp(`^\\s+${n}(\\s+[${ok}])+\\s{3}\\S`, "m");
const group = ({ only, config, target, mutants }) => {
  console.log(`-- case ${only} [${config}]${target ? ` target ${target}` : ""}`);
  runMutants({ test: TEST, args: [`--only=${only}`, `--config=${config}`], controlMustSay: cellsPass(only, only === 10 ? "Pp" : "P"), controlMustNotSay: /SKIP case|FAIL case|DISAGREE/, target, mutants });
};
const GAP = (what) => `GAP, no assertion reads it yet (${what})`;

// the two source checks in the claim recorder, written once so V and V+R3 share them
const V1 = { find: `const sourceRefs = await normalizeArtifactRefs(input.source_refs, "source");\n  await validateSourceEvidence(sourceRefs);`, replace: `const sourceRefs = await normalizeArtifactRefs(input.source_refs, "source");` };
const V2 = { find: `no claim was recorded");\n  await validateSourceEvidence(sourceRefs);\n  const path = await appendArtifact("claims.jsonl", record);`, replace: `no claim was recorded");\n  const path = await appendArtifact("claims.jsonl", record);` };
const R3 = { find: `if (input.status === "supported" && computationRefs.length) await replayComputationEvidence(computationRefs, sourceRefs, signal);`, replace: `;` };
const R1 = { find: `if (hashRows(replayed) !== recordedResultHash) {`, replace: `if (false) {` };
const R2 = { find: `if (JSON.stringify(derived.read_inputs) !== JSON.stringify(computation.read_inputs) || derived.input_binding !== computation.input_binding) {`, replace: `if (false) {` };

// Class 1: record_claim cannot be talked into "verified"
group({ only: 1, config: "off", mutants: [
  { name: "C1a status taken from the request, not the verification", find: `status: verification.publishable ? "verified" : input.status,`, replace: `status: "verified",`, mustSay: esc("recorded as verified from model fields") },
  { name: "C1b computation_replayed always true", find: `computation_replayed: computationRefs.length > 0 && input.status === "supported",`, replace: `computation_replayed: true,`, mustSay: esc("recorded as verified from model fields") },
  { name: "C1c evidence-backed status check removed", find: `assertEvidenceBackedStatus(input.status, input.source_refs, input.computation_refs);`, replace: `;`, mustSay: esc("recorded as verified from model fields") },
  { name: "harmless comment", find: `async function recordClaimArtifact(`, replace: `// harmless\nasync function recordClaimArtifact(`, mustSay: null },
] });

// Class 2: the system verifies, not the model's word
group({ only: 2, config: "off", target: "runtime/pi/evidence_gate.mjs", mutants: [
  { name: "C2a isSystemVerifiedClaim trusts claim.status alone", find: `  return claim?.status === "verified"
    && verification?.authority === "system"
    && verification?.rule_id === SYSTEM_VERIFICATION_RULE_ID
    && verification?.source_resolved === true
    && verification?.extraction_passed === true
    && verification?.computation_replayed === true
    && verification?.claim_supported === true
    && verification?.publishable === true;`, replace: `  return claim?.status === "verified";`, mustSay: esc("forged_status_only: plan came out publishable") },
] });
group({ only: 2, config: "off", mutants: [
  { name: "C2b verified-claim id list not filtered", find: `.filter(([, claim]) => isSystemVerifiedClaim(claim)).map(([id]) => id)`, replace: `.filter(() => true).map(([id]) => id)`, mustSay: null, equivalent: "a third isSystemVerifiedClaim (the verified-claim map) still guards every plan" },
  { name: "C2b+C2b2 both lists not filtered", edits: [
    { find: `.filter(([, claim]) => isSystemVerifiedClaim(claim)).map(([id]) => id)`, replace: `.filter(() => true).map(([id]) => id)` },
    { find: `if (isSystemVerifiedClaim(claim)) out.set(id, claim);`, replace: `out.set(id, claim);` },
  ], mustSay: null, equivalent: "a third isSystemVerifiedClaim still guards every plan" },
] });

// Class 3: replay catches data that changed after the computation. One gate alone is covered by the others; V+R3 together is the effective mutant.
const CHANGED = esc("claim verified on changed data");
group({ only: 3, config: "off", mutants: [
  { name: "R1 result-hash replay compare off", edits: [R1], mustSay: null, equivalent: "the read-input re-derivation (R2) and the source-bytes check (V) still refuse" },
  { name: "R2 read-input re-derivation compare off", edits: [R2], mustSay: null, equivalent: "the result-hash replay (R1) and the source-bytes check (V) still refuse" },
  { name: "R3 replay call removed from the recorder", edits: [R3], mustSay: null, equivalent: "the source-bytes check (V) still refuses changed data" },
  { name: "V both source-bytes checks removed", edits: [V1, V2], mustSay: null, equivalent: "the replay (R3) still refuses changed data" },
  { name: "R1+R2+R3 (all three replay gates) removed", edits: [R1, R2, R3], mustSay: null, equivalent: "the source-bytes check (V) still refuses changed data" },
  { name: "V+R3 source-bytes checks and replay removed", edits: [V1, V2, R3], mustSay: CHANGED },
] });

// Class 4: a PASS of plan A must not be accepted for plan B
group({ only: 4, config: "off", mutants: [
  { name: "B1 vision critic: preview/critic link not checked", find: `if (preview.manifest_ref !== params.manifest_ref || preview.deterministic_critic_ref !== params.deterministic_critic_ref) throw new Error("Preview does not belong`, replace: `if (false) throw new Error("Preview does not belong`, mustSay: null, equivalent: GAP("case 4 asserts a refusal, not its reason; the critic checks guard twice") },
  { name: "B2 vision critic: critic manifest link not checked", find: `if (!deterministicCritic.passed || deterministicCritic.manifest_ref !== params.manifest_ref) throw new Error("Image-aware`, replace: `if (!deterministicCritic.passed) throw new Error("Image-aware`, mustSay: null, equivalent: GAP("same") },
  { name: "B3 preview: critic manifest link not checked", find: `if (critic.manifest_ref !== params.manifest_ref || !critic.passed) throw new Error("A passing deterministic`, replace: `if (!critic.passed) throw new Error("A passing deterministic`, mustSay: esc("critic_A_for_B/preview: was accepted (expected a refusal)") },
  { name: "B4 critic: manifest/plan/lint link not checked", find: `if (manifest.plan_ref !== params.plan_ref || manifest.lint_ref !== params.lint_ref) throw new Error("Infographic manifest is not linked`, replace: `if (false) throw new Error("Infographic manifest is not linked`, mustSay: null, equivalent: GAP("same") },
  { name: "B5 render: lint/plan link not checked", find: `if (lint.plan_ref !== planRef) throw new Error("Infographic lint does not belong`, replace: `if (false) throw new Error("Infographic lint does not belong`, mustSay: null, equivalent: GAP("same") },
] });
group({ only: 5, config: "off", mutants: [
  { name: "B6 revise: vision critic plan link not checked", find: `if (manifest.plan_ref !== params.plan_ref) throw new Error("Vision critic does not belong to the supplied infographic plan");`, replace: `if (false) throw new Error("Vision critic does not belong to the supplied infographic plan");`, mustSay: esc("refused for another reason: vision critic contains no machine-actionable patches") },
] });

// Class 5: an edit that adds a lint blocker is refused
group({ only: 6, config: "PLAN_EDIT", mutants: [
  { name: "E1 added-blocker refusal off", find: "if (added.length) throw new Error(`Plan edit refused:", replace: "if (false) throw new Error(`Plan edit refused:", mustSay: esc("edit adding a blocker: was accepted (expected a refusal)") },
  { name: "E2 'before' blockers taken from the proposed plan", find: `const before = new Set<string>((await lintInfographicPlan(sourcePlan)).lint.blockers.map(String));`, replace: `const before = new Set<string>((await lintInfographicPlan(proposed)).lint.blockers.map(String));`, mustSay: esc("edit adding a blocker: was accepted (expected a refusal)") },
] });

// Class 6: preflight lists every unresolved ref in one error
group({ only: 7, config: "PREFLIGHT", mutants: [
  { name: "P1 preflight always off", find: `if (!preflightEnabled()) return params;`, replace: `return params;`, mustSay: esc("critic with nothing upstream @PREFLIGHT: the call report holds the earlier rows plus exactly the stated new rows") },
  { name: "P2 preflight lists only the first issue", find: `renderPrerequisiteIssues(filled.params, preflightIo, filled.unresolved);\n  if (issues.length) throw preflightError(tool, issues);`, replace: `renderPrerequisiteIssues(filled.params, preflightIo, filled.unresolved);\n  if (issues.length) throw preflightError(tool, issues.slice(0, 1));`, mustSay: esc("preflight error does not list both missing refs") },
] });

// Class 7: publication QA, FAIL is not delivered and unjudged is never PASS
const UNJUDGED = esc("an unjudged QA run was not reported as undetermined");
group({ only: 8, config: "off", mutants: [
  { name: "Q1 every QA run counts as judged", find: `const judged = Array.isArray(report.viewports) && report.viewports.length > 0;`, replace: `const judged = true;`, mustSay: UNJUDGED },
  { name: "Q2 a FAILed publication is not rejected", find: `const rejected = report.status === "PASS" ? null : await rejectPublicationFor(pubKey, params.manifest_ref, report, reportRef);`, replace: `const rejected = null;`, mustSay: esc("a FAILed publication is still at publications/k1/") },
  { name: "Q3 details.passed always true", find: `passed: code === 0 && report.status === "PASS", judged: true`, replace: `passed: true, judged: true`, mustSay: null, equivalent: GAP("details.passed is not read in the FAIL case") },
  { name: "Q4 unjudged branch skipped", find: `if (!judged) {`, replace: `if (false) {`, mustSay: UNJUDGED },
] });

// Class 8: inline claim (the INLINE_CLAIM config; inline-alone has the switch off and would not reach these gates)
group({ only: 10, config: "INLINE_CLAIM", mutants: [
  { name: "S1 viz plan not registered in the design phase although the policy enables it", find: `if (!toolEnabled(name,{phase,profile})) return;\n  if (lieflatHidden()`, replace: `if (!toolEnabled(name,{phase,profile}) || (name === "newsroom_viz_plan" && phase === "design")) return;\n  if (lieflatHidden()`, mustSay: esc("full|design: newsroom_viz_plan is missing although the policy enables it") },
  { name: "I1 unknown/forged fields accepted", find: "if (unknown.length) throw new Error(`INLINE_CLAIM_FIELD_NOT_ACCEPTED", replace: "if (false) throw new Error(`INLINE_CLAIM_FIELD_NOT_ACCEPTED", mustSay: esc("forged_status: was accepted (expected a refusal)") },
  { name: "I2 claim and claim_id together accepted", find: `if (rawParams.claim_id !== undefined) throw new Error("INLINE_CLAIM_EXCLUSIVE`, replace: `if (false) throw new Error("INLINE_CLAIM_EXCLUSIVE`, mustSay: esc("claim_and_claim_id: was accepted (expected a refusal)") },
  { name: "I3 missing claim_kind not refused as missing", find: "if (claimKind === undefined || claimKind === null || claimKind === \"\") throw new Error(`INLINE_CLAIM_KIND_REQUIRED", replace: "if (false) throw new Error(`INLINE_CLAIM_KIND_REQUIRED", mustSay: esc("kind_missing: refused for another reason: INLINE_CLAIM_KIND_INVALID") },
  { name: "I4 invalid claim_kind accepted", find: "if (!(CLAIM_KINDS as readonly string[]).includes(String(claimKind))) throw new Error(`INLINE_CLAIM_KIND_INVALID", replace: "if (false) throw new Error(`INLINE_CLAIM_KIND_INVALID", mustSay: null, equivalent: GAP("no forged input names an invalid claim_kind") },
  { name: "I5 claim without source evidence accepted", find: `if (derived.input_binding !== "source_bound" || !effective.length) throw new Error("INLINE_CLAIM_EVIDENCE_REQUIRED`, replace: `if (false) throw new Error("INLINE_CLAIM_EVIDENCE_REQUIRED`, mustSay: esc("no_source @INLINE_CLAIM: the call report holds the earlier rows plus exactly the stated new rows") },
  { name: "I6 unsupported claim wording accepted", find: "if (!support.passed || !rawSupport.passed) throw new Error(`INLINE_CLAIM_NOT_VERIFIED", replace: "if (false) throw new Error(`INLINE_CLAIM_NOT_VERIFIED", mustSay: esc("causal_wording @INLINE_CLAIM: the call report holds the earlier rows plus exactly the stated new rows") },
  { name: "I7 typed number accepted in the inline claim", find: "if (typed !== null) throw claimTemplateError(`the claim has a typed number", replace: "if (false) throw claimTemplateError(`the claim has a typed number", mustSay: esc("typed_number: was accepted (expected a refusal)") },
  { name: "I7b typed number in the record_claim template validator", find: "if (typed !== null) problems.push(`the claim has a typed number", replace: "if (false) problems.push(`the claim has a typed number", mustSay: null, equivalent: "another function, not on the inline path; the inline refusal (I7) is the one case 10 reaches" },
] });
