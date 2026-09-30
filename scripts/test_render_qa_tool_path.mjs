// Drives the real newsroom_viz_render and newsroom_viz_critic tool handlers
// through the render-QA gate, end to end, without a model or a Pi process.
//
// runtime/pi/newsroom.ts is loaded from a temporary copy of runtime/ with its
// TypeScript types stripped. The two Pi packages it imports at runtime are
// replaced by inert stubs, and runRenderQa is wrapped so one case can force a
// failure regardless of how the renderer currently scores. DuckDB runs the
// visualization SQL for real (NEWSROOM_DUCKDB_BIN, default `duckdb`).
//
// Property under test: a render that fails render QA leaves nothing at the
// top level of visualizations/ (no manifest, no SVG), only evidence under
// visualizations/rejected/<key>/, so a later clean render of the same plan
// becomes the only manifest verify.rs sees.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashRows } from "../runtime/pi/viz.mjs";
import { sourceContentHash } from "../runtime/pi/provenance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "render-qa-tool-path-"));
try {
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  renameSync(join(pi, "render_qa.mjs"), join(pi, "render_qa_impl.mjs"));
  writeFileSync(join(pi, "render_qa.mjs"), `import { runRenderQa as real } from "./render_qa_impl.mjs";
export * from "./render_qa_impl.mjs";
export function runRenderQa(svgs, options) {
  const report = real(svgs, options);
  if (globalThis.__FORCE_RENDER_QA_FAILURE__) {
    report.viewports.desktop.contrast.failures.push({ rule: "text_contrast", message: "forced failure" });
    report.viewports.desktop.contrast.passed = false;
    report.viewports.desktop.passed = false;
    report.passed = false;
    report.failure_count += 1;
  }
  return report;
}
`);
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));

  const art = join(tmp, "artifact");
  for (const dir of ["visualizations/plans", "visualizations/lints", "computations"]) mkdirSync(join(art, dir), { recursive: true });
  // loadEditorialGrammarRegistry (newsroom_infographic_plan/lint) reads this
  // under the artifact root, mirroring what the Rust CLI materializes there
  // before a real investigation starts (src/runtime.rs).
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  // registerScopedTool (tool_phase_policy.mjs/tool_registry.mjs) gates tool
  // registration by profile at import time below, once, for this whole
  // process - the default "investigate" profile excludes the design-phase
  // infographic/lieflat tools this file exercises, and "visual" (used here
  // through the R1/R2 sections) excludes the publish-phase publication
  // tools the browser-QA-rejection section also needs. "full" is a superset
  // of every profile this file uses (config/tool-registry.json lists it on
  // every row that lists any other profile), so it is the only profile that
  // registers everything below in one import.
  process.env.NEWSROOM_TOOL_PROFILE = "full";

  // fixtures/complex/timeline.json is a proven-valid {spec, rows} pair; feed its
  // rows back through DuckDB as a VALUES query so the render path runs its SQL.
  const { spec, rows } = JSON.parse(readFileSync(join(ROOT, "fixtures", "complex", "timeline.json"), "utf8"));
  const columns = Object.keys(rows[0]);
  const literal = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  spec.sql = `SELECT * FROM (VALUES ${rows.map((r) => `(${columns.map((c) => literal(r[c])).join(", ")})`).join(", ")}) AS t(${columns.map((c) => `"${c}"`).join(", ")})`;
  const planRef = "visualizations/plans/plan.json";
  const lintRef = "visualizations/lints/lint.json";
  writeFileSync(join(art, planRef), JSON.stringify(spec));
  writeFileSync(join(art, "computations", "rows.json"), JSON.stringify({ rows }));
  const writeLint = (dataHash) => writeFileSync(join(art, lintRef), JSON.stringify({ passed: true, blockers: [], plan_ref: planRef, data_hash: dataHash, computation_ref: "computations/rows.json" }));

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  const render = tools.get("newsroom_viz_render");
  const critic = tools.get("newsroom_viz_critic");
  assert.ok(render && critic, "newsroom_viz_render and newsroom_viz_critic must register");

  // The render path refuses data that changed after lint; learn the hash DuckDB yields.
  writeLint("0".repeat(64));
  const learned = await render.execute("learn", { plan_ref: planRef, lint_ref: lintRef }).then(
    () => assert.fail("a lint with the wrong data hash must be refused"),
    (error) => /got ([0-9a-f]{64})/.exec(error.message)?.[1],
  );
  assert.ok(learned, "expected the data-changed-after-lint error to report the actual hash");
  writeLint(learned);

  const sha = (ref) => createHash("sha256").update(readFileSync(join(art, ref))).digest("hex");
  const topLevel = () => readdirSync(join(art, "visualizations")).filter((name) => /\.(json|svg)$/.test(name)).sort();

  // Steps 1-3 below are this suite's only coverage of newsroom_viz_render and
  // newsroom_viz_critic with the phone-facing mobile page on; addendum 2
  // turned it off by default (superseding the original "charts/illustrations
  // stay always-on" rule), so pin ON here to keep this coverage unchanged
  // from 00c01ae. Off-by-default coverage follows in its own section below.
  process.env.NEWSROOM_MOBILE_PAGES = "1";

  // 1. A render that fails QA is rejected, not written as a visualization.
  globalThis.__FORCE_RENDER_QA_FAILURE__ = true;
  const rejected = await render.execute("reject", { plan_ref: planRef, lint_ref: lintRef });
  globalThis.__FORCE_RENDER_QA_FAILURE__ = false;
  const rejectedText = rejected.content[0].text;
  assert.match(rejectedText, /^REVISE: render QA failed \(1 failure\)/);
  assert.match(rejectedText, /No manifest was written/);
  assert.deepEqual(topLevel(), [], "a rejected render must leave no manifest or SVG at the top level of visualizations/");
  assert.equal(existsSync(join(art, "visualizations", "qa")), false);
  const r = rejected.details;
  assert.equal(r.manifestRef, undefined);
  assert.equal(r.publishable, false);
  assert.equal(r.renderQaPassed, false);
  for (const ref of [r.desktopSvgRef, r.mobileSvgRef, r.renderQaRef]) {
    assert.ok(ref.startsWith("visualizations/rejected/") && existsSync(join(art, ref)), `rejected evidence must exist: ${ref}`);
  }
  const rejectedReport = JSON.parse(readFileSync(join(art, r.renderQaRef), "utf8"));
  assert.equal(rejectedReport.passed, false);
  assert.equal(rejectedReport.viewports.desktop.svg_sha256, sha(r.desktopSvgRef));
  assert.equal(rejectedReport.viewports.mobile.svg_sha256, sha(r.mobileSvgRef));
  console.log("rejected render leaves only visualizations/rejected/<key>/ evidence -- PASS");

  // 2. A clean render of the same plan afterwards becomes the only manifest.
  const passed = await render.execute("pass", { plan_ref: planRef, lint_ref: lintRef });
  assert.match(passed.content[0].text, /Render QA: PASS/);
  const p = passed.details;
  const key = p.manifestRef.replace(/^visualizations\//, "").replace(/\.json$/, "");
  assert.deepEqual(topLevel(), [`${key}.json`, `${key}.mobile.svg`, `${key}.svg`]);
  const manifest = JSON.parse(readFileSync(join(art, p.manifestRef), "utf8"));
  assert.equal(manifest.schema_version, "0.10.0");
  assert.equal(manifest.render_qa_ref, `visualizations/qa/${key}.json`);
  const report = JSON.parse(readFileSync(join(art, manifest.render_qa_ref), "utf8"));
  assert.equal(report.passed, true);
  assert.equal(report.viewports.desktop.svg_sha256, sha(manifest.variants.desktop));
  assert.equal(report.viewports.mobile.svg_sha256, sha(manifest.variants.mobile));
  console.log("clean re-render after a rejection is the only top-level manifest, hash-bound to its QA report -- PASS");

  // 3. The critic reads the bound report.
  const review = await critic.execute("critic", { plan_ref: planRef, lint_ref: lintRef, manifest_ref: p.manifestRef });
  assert.match(review.content[0].text, /^PASS: responsive visualization critic/);
  // A passing critic must never move anything: the manifest this critic
  // just reviewed is still the top-level manifest, and its critic verdict
  // never produces a manifest.json/critic.json/rejection.json under
  // rejected/<key>/. Step 1 above forced a render-QA failure under this
  // exact same plan_ref+data_hash (render QA runs before the render-QA
  // rejection key is even computed, so its rejected/<key>/ already holds an
  // unrelated desktop.svg/mobile.svg/render-qa.json from that earlier,
  // unrelated rejection) - this checks only the three critic-rejection
  // files, which only rejectCriticizedManifest ever writes.
  assert.equal(review.details.rejectedManifestRef, undefined);
  assert.equal(review.details.rejectedCriticRef, undefined);
  assert.equal(review.details.rejectionRef, undefined);
  assert.ok(topLevel().includes(`${key}.json`), "a passing critic must leave its manifest at the top level");
  for (const name of ["manifest.json", "critic.json", "rejection.json"]) {
    assert.equal(existsSync(join(art, "visualizations", "rejected", key, name)), false, `a passing critic must not write visualizations/rejected/${key}/${name}`);
  }
  console.log("critic passes with a passing render QA report and moves nothing -- PASS");

  // ==========================================================================
  // Viz, off by default: addendum 2 turns off the chart's own compact/mobile
  // SVG too (superseding the original "charts/illustrations stay always-on"
  // rule), reusing the same plan_ref/lint_ref from steps 1-3 above - safe
  // because newsroom_viz_render folds mobile_pages into its content-addressed
  // key, so the two states never collide on the same manifest path.
  // ==========================================================================
  delete process.env.NEWSROOM_MOBILE_PAGES;
  const passedOff = await render.execute("pass-off", { plan_ref: planRef, lint_ref: lintRef });
  assert.match(passedOff.content[0].text, /Rendered newsroom visualization \(desktop only/);
  assert.equal(passedOff.content[0].text.includes("Mobile SVG"), false, "off must not mention a mobile SVG");
  const pOff = passedOff.details;
  assert.equal(pOff.mobileSvgRef, undefined);
  const offKey = pOff.manifestRef.replace(/^visualizations\//, "").replace(/\.json$/, "");
  assert.equal(existsSync(join(art, "visualizations", `${offKey}.mobile.svg`)), false, "off must write no *.mobile.svg for this render");
  assert.deepEqual(topLevel().filter((name) => name.startsWith(offKey)), [`${offKey}.json`, `${offKey}.svg`]);
  const offManifest = JSON.parse(readFileSync(join(art, pOff.manifestRef), "utf8"));
  assert.deepEqual(Object.keys(offManifest.variants), ["desktop"]);
  const offReport = JSON.parse(readFileSync(join(art, offManifest.render_qa_ref), "utf8"));
  assert.deepEqual(Object.keys(offReport.viewports), ["desktop"]);
  const criticOff = await critic.execute("critic-off", { plan_ref: planRef, lint_ref: lintRef, manifest_ref: pOff.manifestRef });
  assert.match(criticOff.content[0].text, /^PASS: desktop visualization critic/);
  assert.equal(criticOff.details.mobileScore, undefined);
  console.log("viz render/critic off by default write and score desktop only, no *.mobile.svg -- PASS");

  // ==========================================================================
  // Infographic render/critic/preview/vision-critic: the same switch, tested
  // against the mobile-page-ON viz manifest (p) rendered in step 2 above -
  // loadInfographicAssets ignores that upstream manifest's own mobile key
  // when the infographic-level switch is off, so this is a valid fixture
  // either way (and its manifest is reused as the infographic's one visual
  // module).
  // ==========================================================================
  const infographicRender = tools.get("newsroom_infographic_render");
  const infographicCritic = tools.get("newsroom_infographic_critic");
  const infographicPreview = tools.get("newsroom_infographic_preview");
  const infographicVisionCritic = tools.get("newsroom_infographic_vision_critic");
  const infographicLint = tools.get("newsroom_infographic_lint");
  const infographicRevise = tools.get("newsroom_infographic_revise");
  assert.ok(
    infographicRender && infographicCritic && infographicPreview && infographicVisionCritic && infographicLint && infographicRevise,
    "infographic render, critic, preview, vision-critic, lint and revise tools must register",
  );
  for (const dir of ["infographics/plans", "infographics/lints", "infographics/previews"]) mkdirSync(join(art, dir), { recursive: true });
  // The Rust CLI normally materializes runtime/pi/rasterize_svg.py into
  // <artifact_root>/runtime/ before Pi starts (src/runtime.rs); this harness
  // has to do the same one copy for newsroom_infographic_preview to shell out
  // to it.
  mkdirSync(join(art, "runtime"), { recursive: true });
  cpSync(join(ROOT, "runtime", "pi", "rasterize_svg.py"), join(art, "runtime", "rasterize_svg.py"));

  const vizManifest = JSON.parse(readFileSync(join(art, p.manifestRef), "utf8"));
  const infographicSpec = {
    schema_version: "1.0.0",
    title: "Test infographic",
    dek: "A minimal deterministic fixture for the mobile-pages switch.",
    alt: "A section header, a hero statistic, and a bar chart visual module in a single-column feature layout.",
    modules: [
      { id: "m1", type: "section_header", span: "full", heading: "Overview" },
      { id: "m2", type: "hero_stat", span: "full", value: "42", label: "Sample metric", claim_id: "claim-1" },
      { id: "m3", type: "visual", span: "full", manifest_ref: p.manifestRef },
    ],
  };
  const infographicPlanRef = "infographics/plans/plan.json";
  writeFileSync(join(art, infographicPlanRef), JSON.stringify(infographicSpec));
  const infographicLintRef = "infographics/lints/lint.json";
  writeFileSync(join(art, infographicLintRef), JSON.stringify({
    passed: true,
    blockers: [],
    plan_ref: infographicPlanRef,
    asset_hashes: { [p.manifestRef]: { desktop_sha256: sha(vizManifest.variants.desktop), mobile_sha256: sha(vizManifest.variants.mobile) } },
  }));
  const infographicTopLevel = () => readdirSync(join(art, "infographics")).filter((name) => /\.(json|svg)$/.test(name)).sort();

  // 4. Off (default): a clean render writes only the desktop SVG, a
  //    desktop-only render QA report, and a manifest with no mobile key -
  //    and the critic that follows scores desktop alone.
  const infographicRendered = await infographicRender.execute("ig-render-off", { plan_ref: infographicPlanRef, lint_ref: infographicLintRef });
  assert.match(infographicRendered.content[0].text, /Render QA: PASS/);
  assert.equal(infographicRendered.content[0].text.includes("Mobile SVG"), false, "off must not mention a mobile SVG in the success text");
  const igOff = infographicRendered.details;
  assert.equal(igOff.mobileRef, undefined);
  const igOffKey = igOff.manifestRef.replace(/^infographics\//, "").replace(/\.json$/, "");
  assert.deepEqual(infographicTopLevel(), [`${igOffKey}.json`, `${igOffKey}.svg`], "off must write only the desktop SVG and manifest at the top level");
  const igOffManifest = JSON.parse(readFileSync(join(art, igOff.manifestRef), "utf8"));
  assert.deepEqual(Object.keys(igOffManifest.variants), ["desktop"]);
  assert.deepEqual(Object.keys(igOffManifest.hashes), ["desktop_sha256"]);
  assert.equal(igOffManifest.layout.mobile_strategy, undefined);
  const igOffRenderQa = JSON.parse(readFileSync(join(art, igOffManifest.render_qa_ref), "utf8"));
  assert.deepEqual(Object.keys(igOffRenderQa.viewports), ["desktop"]);

  const igOffCritic = await infographicCritic.execute("ig-critic-off", { plan_ref: infographicPlanRef, lint_ref: infographicLintRef, manifest_ref: igOff.manifestRef });
  assert.match(igOffCritic.content[0].text, /^PASS: magazine infographic critic/);
  const igOffCriticRef = igOffCritic.details.criticRef;
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(art, igOffCriticRef), "utf8")).viewports), ["desktop"]);
  console.log("infographic render+critic off by default write and score desktop only -- PASS");

  // A chart/illustration module narrower than "full" is rejected by the lint
  // when mobile pages are off (no compact chart variant exists to embed into
  // a narrow desktop column - see embedVisual/embedIllustration) and allowed
  // when they are on.
  const halfSpanSpec = { ...infographicSpec, modules: infographicSpec.modules.map((m) => (m.id === "m3" ? { ...m, span: "half" } : m)) };
  const halfSpanPlanRef = "infographics/plans/half-span-plan.json";
  writeFileSync(join(art, halfSpanPlanRef), JSON.stringify(halfSpanSpec));
  const halfSpanLintOff = await infographicLint.execute("half-span-lint-off", { plan_ref: halfSpanPlanRef });
  assert.equal(halfSpanLintOff.details.passed, false);
  assert.ok(
    halfSpanLintOff.details.blockers.some((b) => /visual 'm3' must use span 'full'/.test(b)),
    `off must reject a half-span visual module: ${halfSpanLintOff.details.blockers.join(" | ")}`,
  );
  process.env.NEWSROOM_MOBILE_PAGES = "1";
  const halfSpanLintOn = await infographicLint.execute("half-span-lint-on", { plan_ref: halfSpanPlanRef });
  assert.equal(
    halfSpanLintOn.details.blockers.some((b) => /must use span 'full'/.test(b)),
    false,
    `on must not apply the off-only full-span rule: ${halfSpanLintOn.details.blockers.join(" | ")}`,
  );
  delete process.env.NEWSROOM_MOBILE_PAGES;
  console.log("infographic lint rejects a half-span visual module off and allows it on -- PASS");

  // 5. Off (default): a forced render-QA failure leaves only
  //    rejected/<key>/{desktop.svg,render-qa.json} - never a mobile.svg.
  globalThis.__FORCE_RENDER_QA_FAILURE__ = true;
  const infographicRejected = await infographicRender.execute("ig-reject-off", { plan_ref: infographicPlanRef, lint_ref: infographicLintRef });
  globalThis.__FORCE_RENDER_QA_FAILURE__ = false;
  const igRejected = infographicRejected.details;
  assert.equal(igRejected.mobileSvgRef, undefined);
  assert.ok(igRejected.desktopSvgRef.startsWith("infographics/rejected/"), "rejected evidence must live under infographics/rejected/");
  const igRejectedDir = join(art, "infographics", "rejected", igRejected.desktopSvgRef.split("/")[2]);
  assert.deepEqual(readdirSync(igRejectedDir).sort(), ["desktop.svg", "render-qa.json"], "off must reject with only desktop.svg and render-qa.json");
  console.log("infographic forced render-QA failure off by default rejects with only desktop.svg and render-qa.json -- PASS");

  // 6. Vision critic: a clean desktop-only submission still passes off, but
  //    a mobile/cross_view issue or a mobile_move_before patch is rejected
  //    outright (an error, forcing resubmission) rather than silently
  //    dropped, because the phone-facing page these would describe was
  //    never rendered.
  const infographicPreviewed = await infographicPreview.execute("ig-preview-off", { manifest_ref: igOff.manifestRef, critic_ref: igOffCriticRef });
  assert.equal(infographicPreviewed.content.length, 2, "off must return exactly one text block and one image");
  assert.equal(infographicPreviewed.details.mobilePngRef, undefined);
  const igOffPreviewRef = infographicPreviewed.details.previewRef;

  const rubric = { hierarchy: 90, legibility: 90, composition: 90, visual_coherence: 90, typography: 90, source_legibility: 90, responsive_quality: 90, illustration_integration: 90, color_contrast: 90, editorial_distinctiveness: 90 };
  const cleanVisionParams = { manifest_ref: igOff.manifestRef, preview_ref: igOffPreviewRef, deterministic_critic_ref: igOffCriticRef, passed: true, score: 90, confidence: 0.9, rubric, issues: [], patches: [] };
  const cleanVision = await infographicVisionCritic.execute("vision-clean", cleanVisionParams);
  assert.match(cleanVision.content[0].text, /^PASS: image-aware infographic critic/);
  console.log("vision critic accepts a clean desktop-only submission off by default -- PASS");

  await assert.rejects(
    infographicVisionCritic.execute("vision-mobile-issue", {
      ...cleanVisionParams,
      issues: [{ severity: "warning", viewport: "mobile", code: "test_mobile_issue", evidence: "the phone layout clips a label", recommendation: "shorten the label" }],
    }),
    /viewport 'mobile'.*phone-facing mobile page is off/,
  );
  await assert.rejects(
    infographicVisionCritic.execute("vision-cross-view-issue", {
      ...cleanVisionParams,
      issues: [{ severity: "warning", viewport: "cross_view", code: "test_cross_view_issue", evidence: "desktop and phone disagree", recommendation: "reconcile" }],
    }),
    /viewport 'cross_view'.*phone-facing mobile page is off/,
  );
  await assert.rejects(
    infographicVisionCritic.execute("vision-mobile-patch", {
      ...cleanVisionParams,
      patches: [{ target_module_id: "m2", field: "mobile_move_before", value: "m1" }],
    }),
    /mobile_move_before'.*phone-facing mobile page is off/,
  );
  console.log("vision critic rejects mobile/cross_view issues and mobile_move_before patches off by default -- PASS");

  // 7. On (NEWSROOM_MOBILE_PAGES=1): both variants render exactly as they did
  //    before this switch existed. A separate visual-module-free plan avoids
  //    a second pre-existing, unrelated defect (also reported): the
  //    phone-facing infographic page embeds a chart's own mobile SVG
  //    (already calibrated for its native 640px viewBox) at a scale that
  //    pushes some of its labels below the 12px floor once placed in the
  //    narrower magazine column - orthogonal to the desktop-only path this
  //    file otherwise covers, so it is not fixed here. What this step
  //    verifies is the render/critic manifest and issue shape on both
  //    variants; it does not depend on a visual module being present (see
  //    the critic comment below for why one is deliberately absent here).
  process.env.NEWSROOM_MOBILE_PAGES = "1";
  const infographicSpecOn = {
    schema_version: "1.0.0",
    title: "Test infographic",
    dek: "A minimal deterministic fixture for the mobile-pages switch.",
    alt: "A section header and two hero statistics in a single-column feature layout.",
    modules: [
      { id: "m1", type: "section_header", span: "full", heading: "Overview" },
      { id: "m2", type: "hero_stat", span: "full", value: "42", label: "Sample metric", claim_id: "claim-1" },
      { id: "m3", type: "hero_stat", span: "full", value: "7", label: "Another metric", claim_id: "claim-1" },
    ],
  };
  const infographicPlanRefOn = "infographics/plans/plan-on.json";
  writeFileSync(join(art, infographicPlanRefOn), JSON.stringify(infographicSpecOn));
  const infographicLintRefOn = "infographics/lints/lint-on.json";
  writeFileSync(join(art, infographicLintRefOn), JSON.stringify({ passed: true, blockers: [], plan_ref: infographicPlanRefOn, asset_hashes: {} }));
  const infographicRenderedOn = await infographicRender.execute("ig-render-on", { plan_ref: infographicPlanRefOn, lint_ref: infographicLintRefOn });
  assert.match(infographicRenderedOn.content[0].text, /Mobile SVG:/);
  const igOn = infographicRenderedOn.details;
  assert.ok(igOn.mobileRef);
  const igOnManifest = JSON.parse(readFileSync(join(art, igOn.manifestRef), "utf8"));
  assert.deepEqual(Object.keys(igOnManifest.variants).sort(), ["desktop", "mobile"]);
  assert.deepEqual(Object.keys(igOnManifest.hashes).sort(), ["desktop_sha256", "mobile_sha256"]);
  // This visual-module-free plan has no `visual`-type module, so the
  // deterministic content critic's pre-existing "too_few_visuals" /
  // "visual_embedding_missing" checks correctly REVISE it on both
  // viewports (also reported, unrelated to the mobile-pages switch: a
  // `visual` module is the only kind that would dodge those checks, but
  // per infographic.mjs it is also the only module type subject to the
  // mobile-embedding font-floor defect from the comment above, so no
  // fixture currently clears both at once). What matters for this switch
  // is that the critic scored *both* viewports the same way it did before
  // the switch existed, which the viewports keys below confirm; the PASS
  // path through newsroom_infographic_preview / _vision_critic (which
  // require a passing critic) is already exercised end-to-end by the
  // off-by-default section above and is untouched by this change.
  const igOnCritic = await infographicCritic.execute("ig-critic-on", { plan_ref: infographicPlanRefOn, lint_ref: infographicLintRefOn, manifest_ref: igOn.manifestRef });
  assert.match(igOnCritic.content[0].text, /^REVISE: magazine infographic critic\nScore: 67\/100/);
  assert.match(igOnCritic.content[0].text, /desktop:blocker:visual_embedding_missing/);
  assert.match(igOnCritic.content[0].text, /mobile:blocker:visual_embedding_missing/);
  const igOnCriticReport = JSON.parse(readFileSync(join(art, igOnCritic.details.criticRef), "utf8"));
  assert.deepEqual(Object.keys(igOnCriticReport.viewports).sort(), ["desktop", "mobile"]);
  delete process.env.NEWSROOM_MOBILE_PAGES;
  console.log("infographic render/critic with NEWSROOM_MOBILE_PAGES=1 still handle both variants -- PASS");

  // ==========================================================================
  // Lieflat: the same switch, taken as an explicit mobile_pages option by
  // renderLieflatChart/renderLieflatPublication (see runtime/pi/lieflat.mjs)
  // rather than read from the environment directly.
  // ==========================================================================
  const lieflatRender = tools.get("newsroom_lieflat_render");
  assert.ok(lieflatRender, "newsroom_lieflat_render must register");
  mkdirSync(join(art, "sources"), { recursive: true });
  const lieflatSourceRef = "sources/lieflat-source.json";
  const lieflatFinalUrl = "https://example.test/lieflat-evidence";
  const lieflatSourceText = "Lieflat fixture evidence: a measured observation.";
  writeFileSync(join(art, lieflatSourceRef), JSON.stringify({
    schema_version: "0.7.0",
    final_url: lieflatFinalUrl,
    status: 200,
    content_type: "text/plain",
    truncated: false,
    content_hash: sourceContentHash({ finalUrl: lieflatFinalUrl, status: 200, contentType: "text/plain", truncated: false, text: lieflatSourceText }),
    text: lieflatSourceText,
  }));
  const lieflatRows = [{ label: "A", value: 7 }, { label: "B", value: 11 }, { label: "C", value: 13 }];
  const lieflatComputationRef = "computations/lieflat-rows.json";
  writeFileSync(join(art, lieflatComputationRef), JSON.stringify({ schema_version: "0.7.0", sql: "SELECT label, value FROM lieflat_fixture", result_hash: hashRows(lieflatRows), rows: lieflatRows }));
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ schema_version: "0.7.0", claim_id: "lieflat-claim-1", claim: "The fixture value is measured.", status: "verified", source_refs: [lieflatSourceRef], computation_refs: [lieflatComputationRef] })}\n`);
  const lieflatParams = {
    mode: "chart",
    language: "en",
    template_id: "L2",
    template_file: "templates/lupi-gallery.html",
    title: "Lieflat fixture chart",
    dek: "Bound to lieflat-source",
    modules: [{
      id: "chart-1", story_role: "hook", analytical_job: "ranking", reader_question: "Which is largest?",
      claim_ids: ["lieflat-claim-1"], source_refs: [lieflatSourceRef], chart_template_id: "L2",
      data_ref: lieflatComputationRef, title: "Lieflat fixture chart", annotation: "Bound to lieflat-source",
    }],
    claim_ids: ["lieflat-claim-1"],
    source_refs: [lieflatSourceRef],
    output_name: "index.html",
  };

  // 8. Off (default): no mobile ref/QA anywhere in the manifest or return value.
  const lieflatOff = await lieflatRender.execute("lieflat-off", lieflatParams);
  assert.equal(lieflatOff.details.mobile_ref, undefined);
  assert.equal(lieflatOff.details.mobile_qa, undefined);
  assert.equal(lieflatOff.details.desktop_qa, "PASS");
  const lieflatOffManifest = JSON.parse(readFileSync(lieflatOff.details.manifest_path, "utf8"));
  assert.deepEqual(Object.keys(lieflatOffManifest.variants), ["desktop"]);
  assert.equal(lieflatOffManifest.mobile_qa, undefined);
  console.log("lieflat chart render off by default has no mobile output -- PASS");

  // 9. On: NEWSROOM_MOBILE_PAGES=1 still renders the mobile SVG exactly as
  //    before this switch existed (a distinct pageKey - see renderLieflatChart
  //    - so this never collides with case 8's desktop-only artifacts).
  process.env.NEWSROOM_MOBILE_PAGES = "1";
  const lieflatOn = await lieflatRender.execute("lieflat-on", lieflatParams);
  assert.ok(lieflatOn.details.mobile_ref);
  assert.equal(lieflatOn.details.mobile_qa, "PASS");
  const lieflatOnManifest = JSON.parse(readFileSync(lieflatOn.details.manifest_path, "utf8"));
  assert.deepEqual(Object.keys(lieflatOnManifest.variants).sort(), ["desktop", "mobile"]);
  delete process.env.NEWSROOM_MOBILE_PAGES;
  console.log("lieflat chart render with NEWSROOM_MOBILE_PAGES=1 still renders mobile -- PASS");

  // ==========================================================================
  // Critic rejection: a manifest that reaches a top-level content-addressed
  // path (visualizations/<key>.json, visualizations/illustrations/<key>.json,
  // infographics/<key>.json) is not automatically safe forever - its critic
  // can still fail afterward. verify.rs and verify_artifact.py both scan only
  // the top level of these directories (a plain, non-recursive glob) and
  // require a passing critic for every manifest found there, so a manifest
  // with only a failing critic would block verification forever if left in
  // place (a revised plan always renders under a new content-addressed key,
  // so the abandoned manifest is never touched again). Mirroring
  // writeRejectedRender's render-QA precedent (evidence for a render that
  // never passed QA never becomes a manifest at all), a failing critic now
  // moves its already-written manifest out to <dir>/rejected/<key>/manifest.json,
  // alongside a copy of the failing critic report itself
  // (<dir>/rejected/<key>/critic.json - the original at its own critic_ref
  // location is never deleted) and a deterministic
  // <dir>/rejected/<key>/rejection.json audit record, leaving every other
  // artifact (SVGs, plan, lint, render QA report) exactly where it was. A
  // passing critic moves nothing at all (asserted directly above, at the
  // first critic PASS in this file).
  // ==========================================================================
  assert.equal(tools.get("newsroom_chart"), undefined, "newsroom_chart must not be registered under any profile, including 'full' (it is retired via agent_visible=false in config/tool-registry.json)");
  console.log("newsroom_chart is not registered under the full profile -- PASS");

  // 10. Viz critic REVISE moves the manifest to rejected/ (verifier-visible
  //     top level clean), refuses a re-render of the same plan, and a
  //     revised plan can render and pass both render QA and critique under a
  //     new key.
  {
    // A run of >95 characters with no spaces cannot be word-wrapped at all
    // and overflows the viewBox at render QA (a real, separately reported
    // geometry gap, not something to route around here); use real
    // space-separated words instead, exactly like every genuine chart title
    // elsewhere in this fixture family, so wrapText can still break it into
    // lines that fit.
    const failTitle = Array.from({ length: 20 }, () => "word").join(" ");
    assert.ok(failTitle.length > 95);
    const failSpec = {
      ...spec,
      title: failTitle,
      highlight_values: ["nonexistent-a", "nonexistent-b", "nonexistent-c", "nonexistent-d", "nonexistent-e"],
      annotations: [0, 1, 2, 3, 4].map((i) => ({ type: "point", match_field: "event", match_value: `nonexistent-${i}`, text: `Annotation ${i}`, claim_id: "claim-complex-v08" })),
    };
    const failPlanRef = "visualizations/plans/critic-fail-plan.json";
    const failLintRef = "visualizations/lints/critic-fail-lint.json";
    writeFileSync(join(art, failPlanRef), JSON.stringify(failSpec));
    writeFileSync(join(art, failLintRef), JSON.stringify({ passed: true, blockers: [], plan_ref: failPlanRef, data_hash: learned, computation_ref: "computations/rows.json" }));

    const failRendered = await render.execute("critic-fail-render", { plan_ref: failPlanRef, lint_ref: failLintRef });
    assert.match(failRendered.content[0].text, /Render QA: PASS/);
    const failManifestRef = failRendered.details.manifestRef;
    const failKey = failManifestRef.replace(/^visualizations\//, "").replace(/\.json$/, "");
    assert.ok(topLevel().includes(`${failKey}.json`), "the manifest must exist at the top level before its critic runs");
    const manifestBytesBeforeCritic = readFileSync(join(art, failManifestRef));

    const failCritic = await critic.execute("critic-fail-critic", { plan_ref: failPlanRef, lint_ref: failLintRef, manifest_ref: failManifestRef });
    const failCriticText = failCritic.content[0].text;
    assert.match(failCriticText, /^REVISE: desktop visualization critic\nScore: (\d+)\/100/);
    const failScore = Number(/Score: (\d+)\/100/.exec(failCriticText)[1]);
    assert.ok(failScore < 75, `expected a failing score below 75, got ${failScore}`);
    assert.match(failCriticText, /desktop:warning:title_too_long/);
    assert.match(failCriticText, /desktop:warning:too_many_highlights/);
    assert.match(failCriticText, /desktop:warning:annotation_density/);
    assert.equal(failCritic.details.issues.some((issue) => issue.severity === "blocker"), false, "this fixture must fail on score alone, with no blockers");
    const failRejectedManifestRef = failCritic.details.rejectedManifestRef;
    const failRejectedCriticRef = failCritic.details.rejectedCriticRef;
    const failRejectionRef = failCritic.details.rejectionRef;
    assert.ok(failRejectedManifestRef && failRejectedCriticRef && failRejectionRef, "a REVISE critic result must report where the manifest and critic report were moved");
    assert.equal(failRejectedManifestRef, `visualizations/rejected/${failKey}/manifest.json`);
    assert.equal(failRejectedCriticRef, `visualizations/rejected/${failKey}/critic.json`);
    assert.equal(failRejectionRef, `visualizations/rejected/${failKey}/rejection.json`);

    // The manifest is gone from the top level (what a verifier's top-level
    // scan would see); the rejected copies are byte-identical to what the
    // critic actually reviewed; the rejection record names the critic that
    // failed it; and every other artifact (SVG, plan, lint, the critic
    // record at its own original location) stays.
    assert.equal(existsSync(join(art, failManifestRef)), false, "a critic-rejected manifest must not remain at the top level");
    assert.equal(topLevel().includes(`${failKey}.json`), false, "verifier-visible top level of visualizations/ must be clean of the rejected key");
    assert.deepEqual(readFileSync(join(art, failRejectedManifestRef)), manifestBytesBeforeCritic, "the rejected manifest must be byte-identical to what the critic actually reviewed");
    assert.deepEqual(JSON.parse(readFileSync(join(art, failRejectedCriticRef), "utf8")).score, failScore, "the rejected critic copy must be the same failing report");
    const failRejection = JSON.parse(readFileSync(join(art, failRejectionRef), "utf8"));
    assert.deepEqual(failRejection, { reason: "critic_failed", critic_ref: failCritic.details.criticRef, manifest_ref: failManifestRef });
    assert.ok(existsSync(join(art, failCritic.details.criticRef)), "the failing critic record at its own original location must be kept, not deleted");
    assert.ok(existsSync(join(art, `visualizations/${failKey}.svg`)), "the rendered SVG must stay in place after its manifest is rejected");
    assert.ok(existsSync(join(art, failPlanRef)) && existsSync(join(art, failLintRef)), "the plan and lint must stay in place after rejection");
    console.log("a failing viz critic moves the manifest and a critic-report copy to visualizations/rejected/<key>/, verifier-visible top level clean -- PASS");

    // The same plan+lint cannot be rendered again under its rejected key.
    await assert.rejects(
      render.execute("critic-fail-rerender", { plan_ref: failPlanRef, lint_ref: failLintRef }),
      /REJECTED:.*rejected by its critic/,
    );
    console.log("re-rendering a plan whose exact output was already critic-rejected is refused -- PASS");

    // A revised plan (materially different content) renders and passes both
    // render QA and critique, becoming the only top-level manifest at its
    // own new key - moving nothing - while the abandoned rejected/ evidence
    // above is untouched.
    const revisedSpec = { ...spec, title: "Policy timeline, revised", highlight_values: [], annotations: [] };
    const revisedPlanRef = "visualizations/plans/critic-revised-plan.json";
    const revisedLintRef = "visualizations/lints/critic-revised-lint.json";
    writeFileSync(join(art, revisedPlanRef), JSON.stringify(revisedSpec));
    writeFileSync(join(art, revisedLintRef), JSON.stringify({ passed: true, blockers: [], plan_ref: revisedPlanRef, data_hash: learned, computation_ref: "computations/rows.json" }));
    const revisedRendered = await render.execute("critic-revised-render", { plan_ref: revisedPlanRef, lint_ref: revisedLintRef });
    const revisedManifestRef = revisedRendered.details.manifestRef;
    assert.notEqual(revisedManifestRef, failManifestRef, "a revised plan must render under a new content-addressed key");
    const revisedCritic = await critic.execute("critic-revised-critic", { plan_ref: revisedPlanRef, lint_ref: revisedLintRef, manifest_ref: revisedManifestRef });
    assert.match(revisedCritic.content[0].text, /^PASS: desktop visualization critic/);
    assert.equal(revisedCritic.details.rejectedManifestRef, undefined);
    assert.equal(revisedCritic.details.rejectedCriticRef, undefined);
    assert.ok(existsSync(join(art, revisedManifestRef)), "the revised manifest must be the top-level manifest after its critic passes");
    assert.ok(existsSync(join(art, failRejectedManifestRef)), "the earlier rejected evidence must remain untouched by the unrelated revised plan");
    console.log("a revised viz plan renders and passes critique as a fresh top-level manifest -- PASS");
  }

  // 11. Explainer/illustration critic REVISE moves the manifest to
  //     visualizations/illustrations/rejected/, refuses a re-render of the
  //     same plan, and a revised plan renders and passes critique under a
  //     new key. Shares the exact rejection machinery
  //     (rejectCriticizedManifest/isRejectedKey/readManifestOrRejected) with
  //     newsroom_viz_critic and newsroom_illustration_critic under the same
  //     visualizations/illustrations/ directory.
  {
    const explainerRender = tools.get("newsroom_explainer_render");
    const explainerCritic = tools.get("newsroom_explainer_critic");
    assert.ok(explainerRender && explainerCritic, "newsroom_explainer_render and newsroom_explainer_critic must register");
    mkdirSync(join(art, "visualizations/illustrations/plans"), { recursive: true });
    mkdirSync(join(art, "visualizations/illustrations/lints"), { recursive: true });

    // 8 parts (>7 triggers label_density) and 15 relationships on a system
    // view (>14 triggers relationship_density): score 100-8-8=84, below the
    // 88 pass threshold, with zero blockers (the deterministic renderer
    // always emits accessible markup and the schematic disclosure).
    const explainerParts = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, label: `Part ${i + 1}` }));
    const explainerRelationships = [];
    for (let i = 0; i < 8 && explainerRelationships.length < 15; i++) explainerRelationships.push({ source: `p${i + 1}`, target: `p${((i + 1) % 8) + 1}` });
    for (let i = 0; i < 8 && explainerRelationships.length < 15; i++) explainerRelationships.push({ source: `p${i + 1}`, target: `p${((i + 2) % 8) + 1}` });
    assert.equal(explainerRelationships.length, 15);

    const explainerFailSpec = {
      schema_version: "0.1.0",
      not_to_scale: true,
      title: "Test system explainer",
      subject: "A fabricated deterministic system for regression coverage",
      alt: "A schematic system diagram with eight labeled parts and fifteen relationships.",
      view: "system",
      source_note: "Synthetic explainer fixture",
      parts: explainerParts,
      relationships: explainerRelationships,
    };
    const explainerFailPlanRef = "visualizations/illustrations/plans/explainer-fail-plan.json";
    const explainerFailLintRef = "visualizations/illustrations/lints/explainer-fail-lint.json";
    writeFileSync(join(art, explainerFailPlanRef), JSON.stringify(explainerFailSpec));
    writeFileSync(join(art, explainerFailLintRef), JSON.stringify({ passed: true, blockers: [], plan_ref: explainerFailPlanRef }));

    const explainerFailRendered = await explainerRender.execute("explainer-fail-render", { plan_ref: explainerFailPlanRef, lint_ref: explainerFailLintRef });
    const explainerFailManifestRef = explainerFailRendered.details.manifestRef;
    const explainerFailKey = explainerFailManifestRef.replace(/^visualizations\/illustrations\//, "").replace(/\.json$/, "");
    const explainerTopLevel = () => readdirSync(join(art, "visualizations", "illustrations")).filter((name) => /\.(json|svg)$/.test(name)).sort();
    assert.ok(explainerTopLevel().includes(`${explainerFailKey}.json`), "the manifest must exist at the top level before its critic runs");

    const explainerFailCritic = await explainerCritic.execute("explainer-fail-critic", { plan_ref: explainerFailPlanRef, manifest_ref: explainerFailManifestRef });
    const explainerFailCriticText = explainerFailCritic.content[0].text;
    assert.match(explainerFailCriticText, /^REVISE: explanatory graphic critic\nScore: (\d+)\/100/);
    const explainerFailScore = Number(/Score: (\d+)\/100/.exec(explainerFailCriticText)[1]);
    assert.ok(explainerFailScore < 88, `expected a failing score below 88, got ${explainerFailScore}`);
    assert.equal(explainerFailCritic.details.issues.some((issue) => issue.severity === "blocker"), false, "this fixture must fail on score alone, with no blockers");
    const explainerFailRejectedManifestRef = explainerFailCritic.details.rejectedManifestRef;
    const explainerFailRejectedCriticRef = explainerFailCritic.details.rejectedCriticRef;
    assert.equal(explainerFailRejectedManifestRef, `visualizations/illustrations/rejected/${explainerFailKey}/manifest.json`);
    assert.equal(explainerFailRejectedCriticRef, `visualizations/illustrations/rejected/${explainerFailKey}/critic.json`);
    assert.equal(existsSync(join(art, explainerFailManifestRef)), false, "a critic-rejected explainer manifest must not remain at the top level");
    assert.equal(explainerTopLevel().includes(`${explainerFailKey}.json`), false, "verifier-visible top level of visualizations/illustrations/ must be clean of the rejected key");
    assert.ok(existsSync(join(art, explainerFailRejectedManifestRef)));
    assert.ok(existsSync(join(art, explainerFailRejectedCriticRef)), "a copy of the failing explainer critic report must travel with the rejected manifest");
    assert.ok(existsSync(join(art, explainerFailCritic.details.criticRef)), "the failing explainer critic record at its own original location must be kept");
    console.log("a failing explainer/illustration critic moves the manifest and a critic-report copy to visualizations/illustrations/rejected/<key>/ -- PASS");

    await assert.rejects(
      explainerRender.execute("explainer-fail-rerender", { plan_ref: explainerFailPlanRef, lint_ref: explainerFailLintRef }),
      /REJECTED:.*rejected by its critic/,
    );
    console.log("re-rendering an explainer plan whose exact output was already critic-rejected is refused -- PASS");

    const explainerRevisedSpec = { ...explainerFailSpec, title: "Test system explainer, revised", parts: explainerParts.slice(0, 4), relationships: explainerRelationships.slice(0, 3) };
    const explainerRevisedPlanRef = "visualizations/illustrations/plans/explainer-revised-plan.json";
    const explainerRevisedLintRef = "visualizations/illustrations/lints/explainer-revised-lint.json";
    writeFileSync(join(art, explainerRevisedPlanRef), JSON.stringify(explainerRevisedSpec));
    writeFileSync(join(art, explainerRevisedLintRef), JSON.stringify({ passed: true, blockers: [], plan_ref: explainerRevisedPlanRef }));
    const explainerRevisedRendered = await explainerRender.execute("explainer-revised-render", { plan_ref: explainerRevisedPlanRef, lint_ref: explainerRevisedLintRef });
    const explainerRevisedManifestRef = explainerRevisedRendered.details.manifestRef;
    const explainerRevisedCritic = await explainerCritic.execute("explainer-revised-critic", { plan_ref: explainerRevisedPlanRef, manifest_ref: explainerRevisedManifestRef });
    assert.match(explainerRevisedCritic.content[0].text, /^PASS: explanatory graphic critic/);
    assert.equal(explainerRevisedCritic.details.rejectedManifestRef, undefined);
    assert.equal(explainerRevisedCritic.details.rejectedCriticRef, undefined);
    assert.ok(existsSync(join(art, explainerRevisedManifestRef)));
    console.log("a revised explainer plan renders and passes critique as a fresh top-level manifest -- PASS");
  }

  // 12. Infographic deterministic critic: igOnCritic above (fixture defined
  //     for the mobile-pages-ON switch coverage) already produced a REVISE
  //     (score 67, visual_embedding_missing blockers on both viewports) as a
  //     side effect of this file's own R1 rejection wiring. Confirm that
  //     REVISE moved igOn's manifest out, then refuse a re-render of the
  //     same plan, then render+critique a revised plan (this time with a
  //     visual module, so the blocker cannot fire) as a fresh PASS.
  {
    const igOnKey = igOn.manifestRef.replace(/^infographics\//, "").replace(/\.json$/, "");
    assert.equal(igOnCritic.details.passed, false);
    const igOnRejectedManifestRef = igOnCritic.details.rejectedManifestRef;
    const igOnRejectedCriticRef = igOnCritic.details.rejectedCriticRef;
    const igOnRejectionRef = igOnCritic.details.rejectionRef;
    assert.equal(igOnRejectedManifestRef, `infographics/rejected/${igOnKey}/manifest.json`);
    assert.equal(igOnRejectedCriticRef, `infographics/rejected/${igOnKey}/critic.json`);
    assert.equal(igOnRejectionRef, `infographics/rejected/${igOnKey}/rejection.json`);
    assert.equal(existsSync(join(art, igOn.manifestRef)), false, "a critic-rejected infographic manifest must not remain at the top level");
    assert.equal(infographicTopLevel().includes(`${igOnKey}.json`), false, "verifier-visible top level of infographics/ must be clean of the rejected key");
    assert.ok(existsSync(join(art, igOnRejectedManifestRef)), "the rejected infographic manifest must exist");
    assert.ok(existsSync(join(art, igOnRejectedCriticRef)), "a copy of the failing infographic critic report must travel with the rejected manifest");
    const igOnRejection = JSON.parse(readFileSync(join(art, igOnRejectionRef), "utf8"));
    assert.deepEqual(igOnRejection, { reason: "critic_failed", critic_ref: igOnCritic.details.criticRef, manifest_ref: igOn.manifestRef });
    assert.ok(existsSync(join(art, igOnCritic.details.criticRef)), "the failing infographic critic record at its own original location must be kept");
    console.log("a failing infographic critic moves the manifest and a critic-report copy to infographics/rejected/<key>/ -- PASS");

    // igOn was originally rendered with mobile pages ON; the render key
    // folds mobilePagesEnabled() in (mobileSha is only part of the key when
    // on), so reproducing the exact same rejected key requires the same
    // switch state here too.
    process.env.NEWSROOM_MOBILE_PAGES = "1";
    await assert.rejects(
      infographicRender.execute("ig-critic-fail-rerender", { plan_ref: infographicPlanRefOn, lint_ref: infographicLintRefOn }),
      /REJECTED:.*rejected by its critic/,
    );
    delete process.env.NEWSROOM_MOBILE_PAGES;
    console.log("re-rendering an infographic plan whose exact output was already critic-rejected is refused -- PASS");

    // A revised plan - this time with a visual module, so the deterministic
    // critic's visual_embedding_missing blocker cannot fire - renders clean
    // and passes critique as a fresh top-level manifest. Mobile pages are
    // off here (unlike igOnCritic's fixture above) specifically to avoid the
    // separately reported, unrelated mobile-embedding font-floor defect
    // noted where infographicSpecOn is defined.
    const infographicSpecRevised = { ...infographicSpec, title: "Test infographic, revised" };
    const infographicPlanRefRevised = "infographics/plans/plan-revised.json";
    writeFileSync(join(art, infographicPlanRefRevised), JSON.stringify(infographicSpecRevised));
    const infographicLintRefRevised = "infographics/lints/lint-revised.json";
    writeFileSync(join(art, infographicLintRefRevised), JSON.stringify({
      passed: true,
      blockers: [],
      plan_ref: infographicPlanRefRevised,
      asset_hashes: { [p.manifestRef]: { desktop_sha256: sha(vizManifest.variants.desktop), mobile_sha256: sha(vizManifest.variants.mobile) } },
    }));
    const infographicRevisedRendered = await infographicRender.execute("ig-revised-render", { plan_ref: infographicPlanRefRevised, lint_ref: infographicLintRefRevised });
    assert.match(infographicRevisedRendered.content[0].text, /Render QA: PASS/);
    const igRevised = infographicRevisedRendered.details;
    assert.notEqual(igRevised.manifestRef, igOn.manifestRef);
    const igRevisedCritic = await infographicCritic.execute("ig-revised-critic", { plan_ref: infographicPlanRefRevised, lint_ref: infographicLintRefRevised, manifest_ref: igRevised.manifestRef });
    assert.match(igRevisedCritic.content[0].text, /^PASS: magazine infographic critic/);
    // visual_review_required is unconditionally true on every rendered
    // infographic manifest (see newsroom_infographic_render), so a passing
    // deterministic critic always steers toward the remaining vision-critic
    // gate both verify.rs and verify_artifact.py require.
    assert.match(igRevisedCritic.content[0].text, /Next: call newsroom_infographic_preview, then newsroom_infographic_vision_critic/);
    assert.equal(igRevisedCritic.details.rejectedManifestRef, undefined);
    assert.equal(igRevisedCritic.details.rejectedCriticRef, undefined);
    assert.ok(existsSync(join(art, igRevised.manifestRef)), "the revised infographic manifest must be the top-level manifest after its critic passes");
    assert.ok(existsSync(join(art, igOnRejectedManifestRef)), "the earlier rejected evidence must remain untouched by the unrelated revised plan");
    console.log("a revised infographic plan renders and passes critique as a fresh top-level manifest, steering to preview/vision-critic -- PASS");
  }

  // 13. Vision critic REVISE: passed:false is a direct model-supplied
  //     parameter, not computed from a score, so it is drivable without a
  //     live provider call. It moves the manifest the same way the
  //     deterministic infographic critic above does, even though this
  //     manifest's OWN deterministic critic already passed (igOffCritic):
  //     the vision critic is a second, independent verdict on the same
  //     manifest, and either one failing is enough to reject it.
  {
    const igOffKeyForVision = igOff.manifestRef.replace(/^infographics\//, "").replace(/\.json$/, "");
    assert.ok(existsSync(join(art, igOff.manifestRef)), "precondition: igOff.manifestRef must still be at the top level before this vision-critic failure");
    const visionFailParams = { ...cleanVisionParams, passed: false, score: 40, issues: [{ severity: "blocker", viewport: "desktop", code: "test_visible_defect", evidence: "a fabricated, deterministic test defect", recommendation: "fix the fabricated defect" }] };
    const visionFail = await infographicVisionCritic.execute("vision-fail", visionFailParams);
    assert.match(visionFail.content[0].text, /^REVISE: image-aware infographic critic/);
    const visionFailRejectedManifestRef = visionFail.details.rejectedManifestRef;
    const visionFailRejectedCriticRef = visionFail.details.rejectedCriticRef;
    const visionFailRejectionRef = visionFail.details.rejectionRef;
    assert.equal(visionFailRejectedManifestRef, `infographics/rejected/${igOffKeyForVision}/manifest.json`);
    assert.equal(visionFailRejectedCriticRef, `infographics/rejected/${igOffKeyForVision}/critic.json`);
    assert.equal(visionFailRejectionRef, `infographics/rejected/${igOffKeyForVision}/rejection.json`);
    assert.equal(existsSync(join(art, igOff.manifestRef)), false, "a vision-critic-rejected infographic manifest must not remain at the top level");
    assert.equal(infographicTopLevel().includes(`${igOffKeyForVision}.json`), false, "verifier-visible top level of infographics/ must be clean of the rejected key");
    assert.ok(existsSync(join(art, visionFailRejectedCriticRef)), "a copy of the failing vision-critic report must travel with the rejected manifest");
    const visionFailRejection = JSON.parse(readFileSync(join(art, visionFailRejectionRef), "utf8"));
    assert.equal(visionFailRejection.reason, "critic_failed");
    assert.equal(visionFailRejection.manifest_ref, igOff.manifestRef);
    assert.ok(existsSync(join(art, igOffCriticRef)), "the earlier passing deterministic critic record must still exist after the vision critic rejects the manifest");
    console.log("a failing vision critic moves the manifest and a critic-report copy to infographics/rejected/<key>/, independent of its already-passing deterministic critic -- PASS");

    await assert.rejects(
      infographicRender.execute("ig-vision-fail-rerender", { plan_ref: infographicPlanRef, lint_ref: infographicLintRef }),
      /REJECTED:.*rejected by its critic/,
    );
    console.log("re-rendering an infographic plan whose exact output was already vision-critic-rejected is refused -- PASS");
  }

  // 14. newsroom_infographic_revise is the one tool designed to consume a
  //     manifest that a failing vision critic already moved to
  //     infographics/rejected/<key>/manifest.json - applying that critic's
  //     bounded patches to produce a revised plan is exactly what it exists
  //     for, so it must read the manifest there instead of refusing it like
  //     every other manifest consumer. Drives a full, independent
  //     render -> critic -> preview -> vision-critic(FAIL, with a real
  //     patch) -> revise -> lint -> render -> critic -> preview ->
  //     vision-critic(PASS) cycle through the real handlers, on a fresh key
  //     so it cannot collide with igOff/igOn above.
  {
    // The real newsroom_infographic_lint blocks any visual module whose
    // manifest is not a system-verified, publishable visualization
    // (asset.manifest?.verification_mode === "draft" etc. -- see
    // lintInfographicSpec). p.manifestRef (reused above) is DRAFT: its
    // claim_id ("claim-complex-v08") was never recorded as verified in this
    // harness's claims.jsonl, which every earlier fixture in this file
    // dodges by hand-writing its infographic lint artifact directly instead
    // of calling newsroom_infographic_lint for real. This section calls the
    // real lint tool, so it needs a visual module backed by a genuinely
    // verified manifest instead.
    const verifiedClaimId = "claim-ig-revise-f1-verified";
    writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
      claim_id: verifiedClaimId,
      status: "verified",
      source_refs: ["sources/ig-revise-f1-source.json"],
      computation_refs: ["computations/rows.json"],
      verification: { authority: "system", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true, rule_id: "verification.source+extraction+computation+claim.v1" },
    })}\n`, { flag: "a" });
    const verifiedVizPlanRef = "visualizations/plans/plan-ig-f1-verified.json";
    const verifiedVizLintRef = "visualizations/lints/lint-ig-f1-verified.json";
    writeFileSync(join(art, verifiedVizPlanRef), JSON.stringify({ ...spec, claim_id: verifiedClaimId }));
    writeFileSync(join(art, verifiedVizLintRef), JSON.stringify({ passed: true, blockers: [], plan_ref: verifiedVizPlanRef, data_hash: learned, computation_ref: "computations/rows.json" }));
    const verifiedVizRendered = await render.execute("ig-f1-verified-viz-render", { plan_ref: verifiedVizPlanRef, lint_ref: verifiedVizLintRef });
    assert.match(verifiedVizRendered.content[0].text, /Render QA: PASS/);
    const verifiedViz = verifiedVizRendered.details;
    const verifiedVizManifest = JSON.parse(readFileSync(join(art, verifiedViz.manifestRef), "utf8"));
    assert.equal(verifiedVizManifest.publishable, true, "precondition: this visualization must be system-verified/publishable for the real infographic lint to accept it");

    // m2's claim_id ("claim-1" in the shared infographicSpec fixture) is
    // also never recorded as verified in this harness; the real lint
    // rejects an unverified hero_stat claim too, so both modules must point
    // at the one verified claim set up above.
    const infographicSpecF1 = { ...infographicSpec, modules: infographicSpec.modules.map((m) => (m.id === "m2" ? { ...m, claim_id: verifiedClaimId } : m.id === "m3" ? { ...m, manifest_ref: verifiedViz.manifestRef } : m)) };
    const revisePlanRef = "infographics/plans/plan-revise-f1.json";
    writeFileSync(join(art, revisePlanRef), JSON.stringify(infographicSpecF1));
    const reviseLintRef = "infographics/lints/lint-revise-f1.json";
    writeFileSync(join(art, reviseLintRef), JSON.stringify({
      passed: true,
      blockers: [],
      plan_ref: revisePlanRef,
      asset_hashes: { [verifiedViz.manifestRef]: { desktop_sha256: sha(verifiedVizManifest.variants.desktop) } },
    }));
    const reviseRendered = await infographicRender.execute("ig-revise-f1-render", { plan_ref: revisePlanRef, lint_ref: reviseLintRef });
    assert.match(reviseRendered.content[0].text, /Render QA: PASS/);
    const igRevise = reviseRendered.details;
    assert.notEqual(igRevise.manifestRef, igOff.manifestRef, "this fixture must render under its own fresh key, independent of igOff");

    const igReviseCritic = await infographicCritic.execute("ig-revise-f1-critic", { plan_ref: revisePlanRef, lint_ref: reviseLintRef, manifest_ref: igRevise.manifestRef });
    assert.match(igReviseCritic.content[0].text, /^PASS: magazine infographic critic/);
    const igReviseCriticRef = igReviseCritic.details.criticRef;

    const igRevisePreviewed = await infographicPreview.execute("ig-revise-f1-preview", { manifest_ref: igRevise.manifestRef, critic_ref: igReviseCriticRef });
    const igRevisePreviewRef = igRevisePreviewed.details.previewRef;

    // A real, machine-actionable patch is required: applyVisionPatches
    // throws "contains no machine-actionable patches" on an empty list, and
    // an empty-patch FAIL (like igOff's visionFail fixture above) has
    // nothing for revise to apply anyway.
    const visionFailF1Params = {
      manifest_ref: igRevise.manifestRef,
      preview_ref: igRevisePreviewRef,
      deterministic_critic_ref: igReviseCriticRef,
      passed: false,
      score: 40,
      confidence: 0.9,
      rubric,
      issues: [{ severity: "blocker", viewport: "desktop", code: "test_visible_defect_f1", evidence: "a fabricated, deterministic test defect", recommendation: "raise the sample metric's priority" }],
      patches: [{ target_module_id: "m2", field: "priority", value: "3" }],
    };
    const visionFailF1 = await infographicVisionCritic.execute("vision-fail-f1", visionFailF1Params);
    assert.match(visionFailF1.content[0].text, /^REVISE: image-aware infographic critic/);
    const visionFailF1CriticRef = visionFailF1.details.criticRef;
    assert.ok(visionFailF1.details.rejectedManifestRef, "precondition: the vision critic must reject this manifest, exactly like the R1 fixture above");
    assert.equal(existsSync(join(art, igRevise.manifestRef)), false, "precondition: the manifest must already be gone from the top level before revise runs");

    // This is the regression under test: before the fix, newsroom_infographic_revise
    // read visionCritic.manifest_ref through readManifestOrRejected and threw
    // REJECTED here, on exactly the case it exists to handle.
    const revised = await infographicRevise.execute("ig-revise-f1", { plan_ref: revisePlanRef, vision_critic_ref: visionFailF1CriticRef });
    assert.match(revised.content[0].text, /^Applied 1 bounded visual-editor patch\(es\)\./);
    assert.deepEqual(revised.details.applied, [{ target_module_id: "m2", field: "priority", value: "3" }]);
    const revisedPlanRef = revised.details.planRef;
    assert.notEqual(revisedPlanRef, revisePlanRef, "the revised plan must be a distinct, freshly content-addressed plan");
    console.log("vision-critic-rejected manifest -> newsroom_infographic_revise reads it and applies its patches -- PASS");

    // lint -> render -> critic -> preview -> vision critic, all through the
    // real handlers, on the revised plan.
    const revisedLint = await infographicLint.execute("ig-revise-f1-revised-lint", { plan_ref: revisedPlanRef });
    assert.match(revisedLint.content[0].text, /^PASS: infographic lint/);
    const revisedLintRef = revisedLint.details.lintRef;

    const revisedRendered = await infographicRender.execute("ig-revise-f1-revised-render", { plan_ref: revisedPlanRef, lint_ref: revisedLintRef });
    assert.match(revisedRendered.content[0].text, /Render QA: PASS/);
    const igRevised2 = revisedRendered.details;

    const igRevised2Critic = await infographicCritic.execute("ig-revise-f1-revised-critic", { plan_ref: revisedPlanRef, lint_ref: revisedLintRef, manifest_ref: igRevised2.manifestRef });
    assert.match(igRevised2Critic.content[0].text, /^PASS: magazine infographic critic/);
    const igRevised2CriticRef = igRevised2Critic.details.criticRef;

    const igRevised2Previewed = await infographicPreview.execute("ig-revise-f1-revised-preview", { manifest_ref: igRevised2.manifestRef, critic_ref: igRevised2CriticRef });
    const igRevised2PreviewRef = igRevised2Previewed.details.previewRef;

    const visionPassF1 = await infographicVisionCritic.execute("vision-pass-f1", {
      manifest_ref: igRevised2.manifestRef,
      preview_ref: igRevised2PreviewRef,
      deterministic_critic_ref: igRevised2CriticRef,
      passed: true,
      score: 90,
      confidence: 0.9,
      rubric,
      issues: [],
      patches: [],
    });
    assert.match(visionPassF1.content[0].text, /^PASS: image-aware infographic critic/);
    assert.equal(visionPassF1.details.rejectedManifestRef, undefined);
    assert.ok(existsSync(join(art, igRevised2.manifestRef)), "the revised-and-repassed manifest must remain at the top level");
    console.log("vision FAIL -> revise -> lint -> render -> critic PASS -> preview -> vision PASS, all through the real handlers -- PASS");
  }

  // ==========================================================================
  // Publication browser QA rejection: a rendered publication is a whole
  // directory (index.html, manifest.json, any assets/) at the verifier-
  // visible top level of publications/<key>/, not one manifest file like a
  // visualization or infographic. A FAILed newsroom_publication_qa
  // previously left that directory in place forever - the same class of
  // problem R1 fixed for critic-rejected manifests. No live browser is
  // available in this harness, but NEWSROOM_ARTIFACT_DIR/runtime/browser_qa.py
  // is a plain subprocess newsroom_publication_qa shells out to (already
  // populated above, for newsroom_infographic_preview's rasterize_svg.py, at
  // <art>/runtime/), so it is replaced here with a trivial stub controlled by
  // an environment variable - no browser, network, or real accessibility
  // audit involved.
  // ==========================================================================
  {
    writeFileSync(join(art, "runtime", "browser_qa.py"), `#!/usr/bin/env python3
import argparse, hashlib, json, os, sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--html")
parser.add_argument("--spec")
parser.add_argument("--output", required=True)
parser.add_argument("--profile", default="cpu")
args = parser.parse_args()
os.makedirs(args.output, exist_ok=True)
# Mirrors sha_file(html) in the real runtime/browser_qa.py: both a startup
# failure and a judged report record the exact-same html_sha256 for the
# exact-same --html path, which is what lets the verifiers link separate
# reports (different qaKey, same publication) by hash.
html_sha256 = hashlib.sha256(Path(args.html).read_bytes()).hexdigest() if args.html and os.path.isfile(args.html) else None

if os.environ.get("NEWSROOM_TEST_BROWSER_QA_NO_REPORT"):
    # Simulates a runner that exits without ever writing browser-qa.json at
    # all (e.g. it crashed before either write path ran).
    sys.exit(1)

if os.environ.get("NEWSROOM_TEST_BROWSER_QA_STARTUP_FAILURE"):
    # Mirrors write_startup_failure in the real runtime/browser_qa.py: a
    # missing local Playwright/Chromium dependency writes status:"FAIL"
    # with no viewports key at all - the browser never ran - but still
    # records html_sha256 whenever the html file exists.
    report = {"schema_version": "0.2.0", "profile": args.profile, "status": "FAIL", "errors": ["playwright_dependency_unavailable"]}
    if html_sha256:
        report["html_sha256"] = html_sha256
    with open(os.path.join(args.output, "browser-qa.json"), "w", encoding="utf-8") as f:
        json.dump(report, f)
    sys.exit(0)

status = os.environ.get("NEWSROOM_TEST_BROWSER_QA_STATUS", "PASS")
report = {
    "status": status,
    "profile": args.profile,
    "html_sha256": html_sha256,
    "viewports": [{"width": 1440, "status": status}],
    "external_requests": [],
    "accessibility_errors": [] if status == "PASS" else [{"code": "test_forced_failure", "message": "forced by NEWSROOM_TEST_BROWSER_QA_STATUS"}],
    "interaction_replay": {"status": "n/a"},
}
with open(os.path.join(args.output, "browser-qa.json"), "w", encoding="utf-8") as f:
    json.dump(report, f)
sys.exit(0)
`);

    mkdirSync(join(art, "editorial", "story-graphs"), { recursive: true });
    const storyGraphRef = "editorial/story-graphs/f2-story-graph.json";
    writeFileSync(join(art, storyGraphRef), JSON.stringify({ passed: true, nodes: [{ id: "n1" }, { id: "n2" }] }));

    const portablePublication = tools.get("newsroom_portable_publication");
    const publicationRender = tools.get("newsroom_publication_render");
    const publicationQa = tools.get("newsroom_publication_qa");
    assert.ok(portablePublication && publicationRender && publicationQa, "publication portable, render and qa tools must register");

    const textModules = (suffix) => [
      { id: "m1", type: "text", story_node_ids: ["n1"], explanatory_dimension: "context", text: `Fixture body one ${suffix}.` },
      { id: "m2", type: "text", story_node_ids: ["n2"], explanatory_dimension: "outcome", text: `Fixture body two ${suffix}.` },
    ];
    const portableParams = (suffix) => ({
      story_graph_ref: storyGraphRef,
      title: `Publication QA fixture ${suffix}`,
      dek: "A minimal deterministic text-only fixture for the browser QA rejection path.",
      reader_question: "Does a failed publication get rejected?",
      visual_thesis: "A failed browser QA moves the whole publication directory out of the verifier-visible tree.",
      modules: textModules(suffix),
    });

    const built = await portablePublication.execute("f2-build", portableParams("fail"));
    assert.match(built.content[0].text, /^Rendered portable evidence-bound composite publication\./);
    const { planRef, htmlRef, manifestRef } = built.details;
    const pubKey = manifestRef.replace(/^publications\//, "").replace(/\/manifest\.json$/, "");
    assert.equal(htmlRef, `publications/${pubKey}/index.html`);
    assert.ok(existsSync(join(art, htmlRef)) && existsSync(join(art, manifestRef)), "precondition: the freshly rendered publication must exist at the top level");

    process.env.NEWSROOM_TEST_BROWSER_QA_STATUS = "FAIL";
    const qaFailed = await publicationQa.execute("f2-qa-fail", { plan_ref: planRef, manifest_ref: manifestRef, profile: "cpu" });
    delete process.env.NEWSROOM_TEST_BROWSER_QA_STATUS;
    assert.match(qaFailed.content[0].text, /^FAIL: browser publication QA/);
    assert.equal(qaFailed.details.passed, false);
    const { rejectedManifestRef, rejectedQaReportRef, rejectionRef } = qaFailed.details;
    assert.equal(rejectedManifestRef, `publications/rejected/${pubKey}/manifest.json`);
    assert.equal(rejectedQaReportRef, `publications/rejected/${pubKey}/browser-qa.json`);
    assert.equal(rejectionRef, `publications/rejected/${pubKey}/rejection.json`);

    // The whole directory relocated in one piece - index.html and
    // manifest.json are both gone from the top level, and both (plus a copy
    // of the failing QA report and the rejection record) now live under
    // rejected/<key>/.
    assert.equal(existsSync(join(art, manifestRef)), false, "a QA-rejected publication manifest must not remain at the top level");
    assert.equal(existsSync(join(art, htmlRef)), false, "a QA-rejected publication's index.html must not remain at the top level");
    assert.deepEqual(
      readdirSync(join(art, "publications", "rejected", pubKey)).sort(),
      ["browser-qa.json", "index.html", "manifest.json", "rejection.json"],
      "the rejected publication directory must carry its own html/manifest plus the QA report copy and rejection record",
    );
    // The original QA report, under publications/qa/<qa-key>/, is evidence
    // and is never touched by the move.
    assert.ok(existsSync(join(art, qaFailed.details.reportRef)), "the original browser QA report at its own qa-key location must be kept");
    const rejection = JSON.parse(readFileSync(join(art, rejectionRef), "utf8"));
    assert.deepEqual(rejection, { reason: "browser_qa_failed", qa_report_ref: qaFailed.details.reportRef, manifest_ref: manifestRef });
    console.log("a failing publication browser QA moves the whole publications/<key>/ directory plus a QA-report copy to publications/rejected/<key>/, original QA report kept -- PASS");

    // A startup failure (no Playwright / no Chromium locally) writes
    // status:"FAIL" with no viewports key at all - the browser never ran,
    // so nothing was actually judged, unlike the judged FAIL moved just
    // above. This must NOT move the publication: rejecting on a local
    // environment gap would permanently sink content that never got a real
    // verdict, and the only way out would be to change content that was
    // never the problem.
    const builtStartup = await portablePublication.execute("f2b-build", portableParams("startup"));
    const { planRef: startupPlanRef, htmlRef: startupHtmlRef, manifestRef: startupManifestRef } = builtStartup.details;
    const startupKey = startupManifestRef.replace(/^publications\//, "").replace(/\/manifest\.json$/, "");
    process.env.NEWSROOM_TEST_BROWSER_QA_STARTUP_FAILURE = "1";
    const startupFailed = await publicationQa.execute("f2c-qa-startup-failure", { plan_ref: startupPlanRef, manifest_ref: startupManifestRef, profile: "cpu" });
    delete process.env.NEWSROOM_TEST_BROWSER_QA_STARTUP_FAILURE;
    assert.match(startupFailed.content[0].text, /^QA could not run: playwright_dependency_unavailable; fix the environment and re-run newsroom_publication_qa\./);
    assert.equal(startupFailed.details.passed, false);
    assert.equal(startupFailed.details.judged, false);
    assert.equal(startupFailed.details.rejectedManifestRef, undefined, "a startup failure must not move anything");
    assert.ok(existsSync(join(art, startupManifestRef)), "an unjudged publication manifest must remain at the top level");
    assert.ok(existsSync(join(art, startupHtmlRef)), "an unjudged publication's index.html must remain at the top level");
    assert.equal(existsSync(join(art, "publications", "rejected", startupKey)), false, "a startup failure must not write publications/rejected/<key>/");

    // Both verifiers link a QA report to a publication by html_sha256 alone,
    // scanning every publications/qa/**/browser-qa.json, and
    // write_startup_failure records html_sha256 whenever the html file
    // exists - which it does here. Leaving this report at browser-qa.json
    // would link it and sink the publication permanently. F2c renames it out
    // of that filename instead: browser-qa.json must be gone from this
    // qaKey's directory, and startup-failure.json must hold the same
    // evidence in its place (moved, never deleted).
    assert.match(startupFailed.details.reportRef, /^publications\/qa\/[0-9a-f]{64}\/startup-failure\.json$/, "the not-judged branch must report the renamed startup-failure.json, not browser-qa.json");
    assert.ok(startupFailed.content[0].text.includes(startupFailed.details.reportRef), "the returned text must name the renamed report");
    const startupQaDir = startupFailed.details.reportRef.replace(/\/startup-failure\.json$/, "");
    assert.equal(existsSync(join(art, startupQaDir, "browser-qa.json")), false, "browser-qa.json must be renamed away so the html_sha256 link scan never sees the stale FAIL");
    const startupFailureOnDisk = JSON.parse(readFileSync(join(art, startupFailed.details.reportRef), "utf8"));
    assert.equal(startupFailureOnDisk.status, "FAIL");
    assert.deepEqual(startupFailureOnDisk.errors, ["playwright_dependency_unavailable"]);
    console.log("a startup-failure QA report (no viewports measured) moves nothing and is renamed out of the html_sha256 link scan -- PASS");

    // A runner that crashes right under the very same qaKey right after a
    // startup failure, writing no report at all, must not resurrect the
    // renamed-away report: readFile(browser-qa.json) has to see a clean
    // ENOENT (browser-qa.json is genuinely absent now), not the stale
    // startup message read back and repeated - the bug this file's F2b
    // history had before the rename.
    process.env.NEWSROOM_TEST_BROWSER_QA_NO_REPORT = "1";
    await assert.rejects(
      publicationQa.execute("f2c-qa-startup-then-no-report", { plan_ref: startupPlanRef, manifest_ref: startupManifestRef, profile: "cpu" }),
      /ENOENT/,
    );
    delete process.env.NEWSROOM_TEST_BROWSER_QA_NO_REPORT;
    assert.ok(existsSync(join(art, startupManifestRef)), "a publication whose QA runner wrote no report must remain at the top level");
    assert.ok(existsSync(join(art, startupHtmlRef)), "a publication whose QA runner wrote no report must keep its index.html at the top level");
    assert.equal(existsSync(join(art, "publications", "rejected", startupKey)), false, "a QA runner that wrote no report must not write publications/rejected/<key>/");
    console.log("a QA runner that crashes right after a startup failure (no report, same qaKey) rejects with ENOENT and moves nothing -- PASS");

    // A PASS under a *different* profile gets a distinct qaKey/path (profile
    // is part of the hash) and never touches the renamed startup-failure.json
    // above. Check the file-level invariant the way the verifier checks it:
    // scan every publications/qa/**/browser-qa.json for this publication's
    // html_sha256 - none linked by that hash may be non-PASS, and at least
    // one linked report must PASS.
    process.env.NEWSROOM_TEST_BROWSER_QA_STATUS = "PASS";
    const startupGpuPassed = await publicationQa.execute("f2c-qa-startup-gpu-pass", { plan_ref: startupPlanRef, manifest_ref: startupManifestRef, profile: "gpu" });
    delete process.env.NEWSROOM_TEST_BROWSER_QA_STATUS;
    assert.match(startupGpuPassed.content[0].text, /^PASS: browser publication QA/);
    assert.match(startupGpuPassed.details.reportRef, /\/browser-qa\.json$/);
    const startupHtmlSha256 = JSON.parse(readFileSync(join(art, startupGpuPassed.details.reportRef), "utf8")).html_sha256;
    assert.ok(startupHtmlSha256, "the judged report must carry html_sha256 for the verifier's link scan");
    const qaRoot = join(art, "publications", "qa");
    const linkedByHtmlHash = readdirSync(qaRoot)
      .map(dir => join(qaRoot, dir, "browser-qa.json"))
      .filter(existsSync)
      .map(p => JSON.parse(readFileSync(p, "utf8")))
      .filter(r => r.html_sha256 === startupHtmlSha256);
    assert.ok(linkedByHtmlHash.length > 0, "at least one browser-qa.json must be linked by this publication's html_sha256");
    assert.ok(linkedByHtmlHash.every(r => r.status === "PASS"), "every browser-qa.json linked by html_sha256 must be PASS - the renamed startup-failure.json must not appear in this scan");
    console.log("a PASS under a different profile leaves no non-PASS browser-qa.json linked by html_sha256 -- PASS");

    // A retry under the *same* profile (same qaKey/directory as the
    // original startup failure) still passes normally, reporting
    // browser-qa.json: it writes a fresh report beside the renamed
    // startup-failure.json (which stays, never deleted), not blocked by it.
    process.env.NEWSROOM_TEST_BROWSER_QA_STATUS = "PASS";
    const startupRetried = await publicationQa.execute("f2c-qa-startup-retry", { plan_ref: startupPlanRef, manifest_ref: startupManifestRef, profile: "cpu" });
    delete process.env.NEWSROOM_TEST_BROWSER_QA_STATUS;
    assert.match(startupRetried.content[0].text, /^PASS: browser publication QA/);
    assert.equal(startupRetried.details.judged, true);
    assert.equal(startupRetried.details.passed, true);
    assert.match(startupRetried.details.reportRef, /\/browser-qa\.json$/, "a judged retry must report browser-qa.json, not startup-failure.json");
    assert.equal(startupRetried.details.reportRef.replace(/\/browser-qa\.json$/, ""), startupQaDir, "a same-profile retry must land in the same qaKey directory as the original startup failure");
    assert.ok(existsSync(join(art, startupFailed.details.reportRef)), "the renamed startup-failure.json must still exist untouched after a later same-profile retry");
    assert.equal(JSON.parse(readFileSync(join(art, startupRetried.details.reportRef), "utf8")).status, "PASS");
    console.log("a same-profile retry after a startup failure still passes, reporting browser-qa.json -- PASS");

    // Re-rendering the exact same publication (byte-identical HTML -> the
    // same content-addressed key) is refused.
    await assert.rejects(
      portablePublication.execute("f2-portable-rerender", portableParams("fail")),
      /REJECTED:.*rejected by its browser QA/,
    );
    console.log("re-rendering a publication whose exact output was already QA-rejected is refused (portable) -- PASS");

    // Any tool resolving a rejected publication's manifest_ref - here,
    // newsroom_publication_qa's own read of the manifest it is about to
    // re-verify - reports REJECTED clearly instead of a bare missing-file
    // error, exactly like readManifestOrRejected does for every other
    // artifact kind.
    await assert.rejects(
      publicationQa.execute("f2-qa-on-rejected", { plan_ref: planRef, manifest_ref: manifestRef, profile: "cpu" }),
      /REJECTED:.*failed its browser QA/,
    );
    console.log("reading an already QA-rejected publication manifest reports REJECTED clearly -- PASS");

    // newsroom_publication_render's own move/refusal cycle, independent of
    // portable: it cannot simply reuse portable's plan_ref above verbatim -
    // the persisted plan file carries content_hash/portable_fallback keys
    // that portable's own in-memory render call never sees (they are added
    // only when writeArtifactIfAbsent(planRef, ...) writes the file), and
    // bootstrapJs embeds the *entire* spec object verbatim
    // (`const SPEC=${stableJson({...spec,modules})}`), so reading that file
    // back unstripped and rendering it through newsroom_publication_render
    // would embed those extra keys and produce yet another key. Dropping
    // them is necessary, but for this text-only fixture (no evidence_binding
    // branch to create any other asymmetry) it is also sufficient to make
    // newsroom_publication_render's output byte-identical to portable's -
    // i.e. the same publication, correctly colliding with the already-
    // rejected pubKey above. Give this fixture its own distinguishing title
    // so it is a genuinely different publication, to exercise
    // newsroom_publication_render's own independent build -> QA FAIL -> move
    // -> refusal cycle instead of tripping over portable's rejected key.
    const { content_hash: _droppedContentHash, portable_fallback: _droppedPortableFallback, ...renderSpecBase } = JSON.parse(readFileSync(join(art, planRef), "utf8"));
    const renderSpec = { ...renderSpecBase, title: `${renderSpecBase.title} (trusted render fixture)` };
    const renderPlanRef = "publications/plans/f2-render-plan.json";
    writeFileSync(join(art, renderPlanRef), JSON.stringify(renderSpec));
    const renderBuilt = await publicationRender.execute("f2-render-build", { plan_ref: renderPlanRef });
    assert.match(renderBuilt.content[0].text, /^Rendered trusted browser publication\./);
    const renderManifestRef = renderBuilt.details.manifestRef;
    const renderKey = renderManifestRef.replace(/^publications\//, "").replace(/\/manifest\.json$/, "");
    assert.notEqual(renderKey, pubKey, "this fixture must render under its own distinct key from the portable one above");

    process.env.NEWSROOM_TEST_BROWSER_QA_STATUS = "FAIL";
    const renderQaFailed = await publicationQa.execute("f2-render-qa-fail", { plan_ref: renderPlanRef, manifest_ref: renderManifestRef, profile: "cpu" });
    delete process.env.NEWSROOM_TEST_BROWSER_QA_STATUS;
    assert.match(renderQaFailed.content[0].text, /^FAIL: browser publication QA/);
    assert.equal(renderQaFailed.details.rejectedManifestRef, `publications/rejected/${renderKey}/manifest.json`);
    assert.equal(existsSync(join(art, renderManifestRef)), false, "a QA-rejected newsroom_publication_render output must not remain at the top level");

    await assert.rejects(
      publicationRender.execute("f2-render-rerender", { plan_ref: renderPlanRef }),
      /REJECTED:.*rejected by its browser QA/,
    );
    console.log("re-rendering a publication whose exact output was already QA-rejected is refused (newsroom_publication_render) -- PASS");

    // A passing browser QA moves nothing at all.
    const builtPass = await portablePublication.execute("f2-build-pass", portableParams("pass"));
    const passManifestRef = builtPass.details.manifestRef;
    const passKey = passManifestRef.replace(/^publications\//, "").replace(/\/manifest\.json$/, "");
    assert.notEqual(passKey, pubKey, "the passing fixture must render under its own distinct key");
    process.env.NEWSROOM_TEST_BROWSER_QA_STATUS = "PASS";
    const qaPassed = await publicationQa.execute("f2-qa-pass", { plan_ref: builtPass.details.planRef, manifest_ref: passManifestRef, profile: "cpu" });
    delete process.env.NEWSROOM_TEST_BROWSER_QA_STATUS;
    assert.match(qaPassed.content[0].text, /^PASS: browser publication QA/);
    assert.equal(qaPassed.details.passed, true);
    assert.equal(qaPassed.details.rejectedManifestRef, undefined);
    assert.ok(existsSync(join(art, passManifestRef)), "a passing publication QA must leave its manifest at the top level");
    assert.equal(existsSync(join(art, "publications", "rejected", passKey)), false, "a passing publication QA must not write publications/rejected/<key>/");
    console.log("a passing publication browser QA moves nothing -- PASS");
  }

  // ==========================================================================
  // Publication upstream lineage gate (fix/publication-upstream):
  // newsroom_publication_plan must bind infographic_plan_ref only to a plan
  // whose rendered page is (a) still a top-level, non-rejected
  // infographics/<key>.json manifest, (b) has a passing
  // infographics/critics/*.json critic linked to it by manifest_ref, and
  // (c) - since visual_review_required is unconditionally true on every
  // rendered infographic manifest - has a passing
  // infographics/vision-critics/*.json vision critic linked the same way.
  // Before this gate, the tool only checked that the plan file existed,
  // which stayed true even after every page ever rendered from it was
  // rejected by a critic - the exact africa-01 dev-run shape this closes.
  // Fresh, self-contained fixtures throughout: the shared infographicSpec-
  // family fixtures above never set story_graph_ref/reader_question/
  // visual_thesis, which newsroom_publication_plan requires to match a real
  // StoryGraph artifact.
  // ==========================================================================
  {
    const publicationPlan = tools.get("newsroom_publication_plan");
    assert.ok(publicationPlan, "newsroom_publication_plan must register");

    mkdirSync(join(art, "editorial", "story-graphs"), { recursive: true });
    const pubGateStoryGraphRef = "editorial/story-graphs/pub-gate-story-graph.json";
    const pubGateReaderQuestion = "What does the pub-gate fixture demonstrate?";
    const pubGateVisualThesis = "The pub-gate fixture demonstrates a bounded lineage check.";
    writeFileSync(join(art, pubGateStoryGraphRef), JSON.stringify({
      passed: true,
      reader_question: pubGateReaderQuestion,
      visual_thesis: pubGateVisualThesis,
      nodes: [{ id: "n1" }, { id: "n2" }],
    }));

    const buildPubGateInfographicPlan = (label) => {
      const spec = {
        schema_version: "1.0.0",
        title: `Publication lineage fixture (${label})`,
        dek: "Publication-lineage-gate fixture.",
        alt: "A section header, a hero statistic, and a bar chart visual module in a single-column feature layout.",
        story_graph_ref: pubGateStoryGraphRef,
        reader_question: pubGateReaderQuestion,
        visual_thesis: pubGateVisualThesis,
        modules: [
          { id: "m1", type: "section_header", span: "full", heading: "Overview" },
          { id: "m2", type: "hero_stat", span: "full", value: "42", label: "Sample metric", claim_id: "claim-1" },
          { id: "m3", type: "visual", span: "full", manifest_ref: p.manifestRef },
        ],
      };
      const planRef = `infographics/plans/pub-gate-${label}.json`;
      writeFileSync(join(art, planRef), JSON.stringify(spec));
      const lintRef = `infographics/lints/pub-gate-${label}.json`;
      writeFileSync(join(art, lintRef), JSON.stringify({
        passed: true,
        blockers: [],
        plan_ref: planRef,
        asset_hashes: { [p.manifestRef]: { desktop_sha256: sha(vizManifest.variants.desktop), mobile_sha256: sha(vizManifest.variants.mobile) } },
      }));
      return { planRef, lintRef };
    };

    const publicationPlanParams = (infographicPlanRef, suffix) => ({
      infographic_plan_ref: infographicPlanRef,
      story_graph_ref: pubGateStoryGraphRef,
      title: `Publication lineage gate test ${suffix}`,
      dek: "A minimal deterministic fixture for the publication upstream lineage gate.",
      reader_question: pubGateReaderQuestion,
      visual_thesis: pubGateVisualThesis,
      modules: [
        { id: "m1", type: "text", story_node_ids: ["n1"], explanatory_dimension: "context", text: `Fixture body one ${suffix}.` },
        { id: "m2", type: "text", story_node_ids: ["n2"], explanatory_dimension: "outcome", text: `Fixture body two ${suffix}.` },
      ],
    });

    // (a) Rejected: render -> critic PASS -> preview -> vision critic FAIL
    // moves the manifest to infographics/rejected/<key>/, leaving no
    // top-level manifest bound to this plan_ref at all - exactly the
    // africa-01 dev-run evidence this gate closes (both publications bound
    // to a plan whose only rendered page was rejected by the vision critic).
    const { planRef: rejectPlanRef, lintRef: rejectLintRef } = buildPubGateInfographicPlan("rejected");
    const rejectRendered = await infographicRender.execute("pub-gate-reject-render", { plan_ref: rejectPlanRef, lint_ref: rejectLintRef });
    assert.match(rejectRendered.content[0].text, /Render QA: PASS/);
    const rejectIg = rejectRendered.details;
    const rejectCritic = await infographicCritic.execute("pub-gate-reject-critic", { plan_ref: rejectPlanRef, lint_ref: rejectLintRef, manifest_ref: rejectIg.manifestRef });
    assert.match(rejectCritic.content[0].text, /^PASS: magazine infographic critic/);
    const rejectCriticRef = rejectCritic.details.criticRef;
    const rejectPreviewed = await infographicPreview.execute("pub-gate-reject-preview", { manifest_ref: rejectIg.manifestRef, critic_ref: rejectCriticRef });
    const rejectVision = await infographicVisionCritic.execute("pub-gate-reject-vision", {
      manifest_ref: rejectIg.manifestRef,
      preview_ref: rejectPreviewed.details.previewRef,
      deterministic_critic_ref: rejectCriticRef,
      passed: false,
      score: 40,
      confidence: 0.9,
      rubric,
      issues: [{ severity: "blocker", viewport: "desktop", code: "test_visible_defect_pub_gate", evidence: "a fabricated, deterministic test defect", recommendation: "fix the fabricated defect" }],
      patches: [],
    });
    assert.match(rejectVision.content[0].text, /^REVISE: image-aware infographic critic/);
    assert.ok(rejectVision.details.rejectedManifestRef, "precondition: the vision critic must reject this manifest");
    assert.equal(existsSync(join(art, rejectIg.manifestRef)), false, "precondition: the rejected manifest must not remain at the top level");

    await assert.rejects(
      publicationPlan.execute("pub-gate-reject-plan", publicationPlanParams(rejectPlanRef, "reject")),
      /no top-level, non-rejected infographic manifest/,
    );
    console.log("newsroom_publication_plan refuses an infographic_plan_ref whose only rendered page was rejected by its vision critic -- PASS");

    // (b) Critic missing: render only, never critiqued - a real, reachable
    // state (the manifest is written at the top level before its critic
    // ever runs).
    const { planRef: noCriticPlanRef, lintRef: noCriticLintRef } = buildPubGateInfographicPlan("no-critic");
    const noCriticRendered = await infographicRender.execute("pub-gate-no-critic-render", { plan_ref: noCriticPlanRef, lint_ref: noCriticLintRef });
    assert.match(noCriticRendered.content[0].text, /Render QA: PASS/);
    assert.ok(existsSync(join(art, noCriticRendered.details.manifestRef)), "precondition: the never-critiqued manifest must exist at the top level");

    await assert.rejects(
      publicationPlan.execute("pub-gate-no-critic-plan", publicationPlanParams(noCriticPlanRef, "no-critic")),
      /has no passing critic \(missing or failed\)/,
    );
    console.log("newsroom_publication_plan refuses an infographic_plan_ref whose rendered page has no critic yet -- PASS");

    // (c) Vision critic missing: render -> critic PASS, never previewed or
    // vision-critiqued.
    const { planRef: noVisionPlanRef, lintRef: noVisionLintRef } = buildPubGateInfographicPlan("no-vision");
    const noVisionRendered = await infographicRender.execute("pub-gate-no-vision-render", { plan_ref: noVisionPlanRef, lint_ref: noVisionLintRef });
    assert.match(noVisionRendered.content[0].text, /Render QA: PASS/);
    const noVisionIg = noVisionRendered.details;
    const noVisionCritic = await infographicCritic.execute("pub-gate-no-vision-critic", { plan_ref: noVisionPlanRef, lint_ref: noVisionLintRef, manifest_ref: noVisionIg.manifestRef });
    assert.match(noVisionCritic.content[0].text, /^PASS: magazine infographic critic/);
    assert.ok(existsSync(join(art, noVisionIg.manifestRef)), "precondition: the manifest must remain at the top level after a passing deterministic critic");

    await assert.rejects(
      publicationPlan.execute("pub-gate-no-vision-plan", publicationPlanParams(noVisionPlanRef, "no-vision")),
      /image-aware vision critic \(missing or failed\)/,
    );
    console.log("newsroom_publication_plan refuses an infographic_plan_ref whose rendered page has no image-aware vision critic yet -- PASS");

    // (d) Approved: render -> critic PASS -> preview -> vision critic PASS
    // is accepted and produces a real PublicationSpec 0.3 plan.
    const { planRef: approvedPlanRef, lintRef: approvedLintRef } = buildPubGateInfographicPlan("approved");
    const approvedRendered = await infographicRender.execute("pub-gate-approved-render", { plan_ref: approvedPlanRef, lint_ref: approvedLintRef });
    assert.match(approvedRendered.content[0].text, /Render QA: PASS/);
    const approvedIg = approvedRendered.details;
    const approvedCritic = await infographicCritic.execute("pub-gate-approved-critic", { plan_ref: approvedPlanRef, lint_ref: approvedLintRef, manifest_ref: approvedIg.manifestRef });
    assert.match(approvedCritic.content[0].text, /^PASS: magazine infographic critic/);
    const approvedCriticRef = approvedCritic.details.criticRef;
    const approvedPreviewed = await infographicPreview.execute("pub-gate-approved-preview", { manifest_ref: approvedIg.manifestRef, critic_ref: approvedCriticRef });
    const approvedVision = await infographicVisionCritic.execute("pub-gate-approved-vision", {
      manifest_ref: approvedIg.manifestRef,
      preview_ref: approvedPreviewed.details.previewRef,
      deterministic_critic_ref: approvedCriticRef,
      passed: true,
      score: 92,
      confidence: 0.9,
      rubric,
      issues: [],
      patches: [],
    });
    assert.match(approvedVision.content[0].text, /^PASS: image-aware infographic critic/);
    assert.ok(existsSync(join(art, approvedIg.manifestRef)), "precondition: the approved manifest must remain at the top level");

    const accepted = await publicationPlan.execute("pub-gate-approved-plan", publicationPlanParams(approvedPlanRef, "approved"));
    assert.match(accepted.content[0].text, /^PublicationSpec 0\.3 recorded\./);
    assert.ok(existsSync(join(art, accepted.details.planRef)), "an accepted publication plan must be written to disk");
    const acceptedSpec = JSON.parse(readFileSync(join(art, accepted.details.planRef), "utf8"));
    assert.equal(acceptedSpec.infographic_plan_ref, approvedPlanRef);
    console.log("newsroom_publication_plan accepts an infographic_plan_ref whose rendered page has a passing critic and passing vision critic -- PASS");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("render QA tool path: PASS");
