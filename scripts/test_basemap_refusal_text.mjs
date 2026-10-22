// Basemap provenance refusal wording (#263): only the words of five refusals changed. The same specs go through validateVizSpec of main
// (7ea386d9, `git archive`) and of the working tree: refused-or-allowed and the list of refusals must be the same, each new line equal to the old
// one once its new words are mapped back (toOld). The new words never print a registry value, say the program fills the fields, and the
// [refusal] row of the basemap_id line now carries field basemap_id. Mutation proofs run the same checks on a mutated copy and must go red.
// The words are also tied to behaviour: every refused cell whose refusal says "leave it out" is changed as the sentence says (the named
// provenance fields dropped, basemap_id set to the id the sentence names), run through the same fill as the product (newsroom.ts
// basemapProvenanceDefaults / symbolMapProvenanceFill; one cell per chart type and sentence goes through the real newsroom_viz_plan), and
// validateVizSpec must then show no basemap provenance or basemap_id refusal.
// LIFETIME: this is a proof for a wording-only change. The old side is the whole runtime and config tree of MAIN_SHA (git archive, like
// test_viz_round3_conventions.mjs), so it never mixes with the new tree. When the map refusals of validateVizSpec later change behaviour for
// another reason, set MAIN_SHA to the base of that change, or delete the matrix part.
// Run: node scripts/test_basemap_refusal_text.mjs   (the matrix worker mode is internal)
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const MAIN_SHA = "7ea386d9479495cc6ec8f7c5d23b1ca283d03a73";
const ID50 = "naturalearth_admin0_50m";
const ID110 = "naturalearth_admin0_110m";
const IDUS = "naturalearth_admin1_us_110m";

if (process.argv[2] === "worker") {
  await worker(process.argv[3]);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------- worker: prints one JSON result
async function worker(dir) {
  const pi = join(dir, "runtime", "pi");
  const next = await import(join(pi, "viz.mjs"));
  const old = await import(join(dir, "old", "runtime", "pi", "viz.mjs"));
  const reg = await import(join(pi, "basemap_registry.mjs"));
  // the fill of the product, from a type-stripped copy of newsroom.ts (as test_symbol_map_basemap_fill.mjs does) and the real plan tool
  const stub = (name, source) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), `${stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" })}\nexport { basemapProvenanceDefaults, symbolMapProvenanceFill };\n`);
  const art = join(makeTestTmp("basemap-refusal-run-"), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
    claim_id: "claim-fixture", status: "verified", source_refs: ["data/africa.csv"],
    verification: { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true },
  })}\n`);
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  process.env.NEWSROOM_CHOROPLETH_NORMALIZED = "0"; // the ratio check of the SQL is another gate; these plans only ask about the basemap fields
  const nm = await import(join(pi, "newsroom.test-copy.mjs"));
  const tools = new Map();
  nm.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  const realPlan = async (params) => {
    const res = await tools.get("newsroom_viz_plan").execute("p", params);
    const stored = JSON.parse(readFileSync(join(art, res.details.planRef), "utf8"));
    return stored.spec ?? stored;
  };
  // the three normalizedParams branches of newsroom.ts viz_plan, written the same way
  const productFill = (p) => p.chart_type === "cartographic_flow_map"
    ? { geometry_crs: "EPSG:4326", projection: "natural_earth_1", ...nm.basemapProvenanceDefaults(p.basemap_id), aggregation_policy: "none", ...p }
    : p.chart_type === "choropleth" ? { ...nm.basemapProvenanceDefaults(p.basemap_id), ...p }
    : p.chart_type === "symbol_map" ? { ...p, ...nm.symbolMapProvenanceFill(p) } : p;
  const KEYS = ["basemap_source_url", "basemap_license", "basemap_content_hash"];
  // change a spec as its refusals say: drop the provenance fields they name, set basemap_id to the id they name
  const followHints = (spec, lines) => {
    const hinted = lines.filter((l) => /out of the call/.test(l));
    if (!hinted.length) return null;
    const fixed = { ...spec };
    const touched = new Set();
    for (const l of hinted) {
      let m;
      if ((m = /^basemap_id requires '([^']+)' for /.exec(l))) { fixed.basemap_id = m[1]; for (const k of KEYS) delete fixed[k]; touched.add("basemap_id"); KEYS.forEach((k) => touched.add(k)); }
      else if ((m = /^Missing required field '(basemap_\w+)' \(set basemap_id to (?:'([^']+)'|a registered basemap) and leave /.exec(l))) { fixed.basemap_id = m[2] ?? ID50; delete fixed[m[1]]; touched.add("basemap_id"); touched.add(m[1]); }
      else if ((m = /^(basemap_\w+) does not match .*, leave \1 out of the call/.exec(l))) { delete fixed[m[1]]; touched.add(m[1]); }
    }
    return { fixed, touched };
  };
  const fieldOf = (l) => /^Unknown basemap_id|^basemap_id requires/.test(l) ? "basemap_id" : (/^(?:Missing required field ')?(basemap_\w+)/.exec(l) ?? [])[1];
  const hintKind = (l) => (/^basemap_id requires/.test(l) ? "id" : /^Missing required field/.test(l) ? "missing" : "mismatch");
  const provenanceRefusal = (l) => /^(?:basemap_id requires|basemap_(?:source_url|license|content_hash) does not match|Missing required field 'basemap_|Unknown basemap_id)/.test(l);
  const viaRealPlan = new Set();
  const planSql = "SELECT 1 AS country, 2 AS value, 3 AS year, 1 AS a, 2 AS b, 3 AS c, 4 AS d";
  const ids = [undefined, null, "", 42, { not: "a string" }, ID50, ID110, IDUS, "not_a_basemap", ...reg.listBasemaps().map((b) => b.id).filter((id) => ![ID50, ID110, IDUS].includes(id))];
  const secrets = reg.listBasemaps().flatMap((b) => [b.source_url, b.license, b.content_hash]).filter(Boolean);
  const failures = [];
  const seen = { cells: 0, refused: 0, allowed: 0, changedLines: 0, followed: 0, realPlans: 0 };
  // a new line, with its added sentence cut off, must be the old line
  const toOld = (line) => line
    .replace(/^basemap_id requires '([^']+)' for \S+ \(the only basemap with a matching attribute sidecar\), leave .* registry entry$/, "choropleth requires basemap_id '$1' (the only basemap with a matching attribute sidecar)")
    .replace(/^(basemap_(?:source_url|license|content_hash) does not match the registered basemap \w+), leave .*$/, "$1")
    .replace(/^(Missing required field '[^']+') \(set basemap_id to .* registry entry\)$/, "$1");
  const common = { schema_version: "0.9.0", reader_task: "spatial", title: "Renewable share", alt: "A map of one measure by country, darker meaning higher.", source_note: "fixture", claim_id: "claim-fixture", sql: "SELECT 1 AS country, 2 AS value, 3 AS year", unit: "%", reference_period_field: "year", mixed_period_strategy: "acknowledge", highlight_values: [], annotations: [] };
  const base = (chart_type, extra) => ({ ...common, chart_type, category_field: "country", value_field: "value", ...extra });
  const configs = [
    { name: "choropleth", env: { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_US_STATES: "1" }, spec: base("choropleth", { category_names: "worldbank" }) },
    { name: "symbol_map", env: { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_US_STATES: "1" }, spec: base("symbol_map", { category_names: "worldbank" }) },
    { name: "symbol_map switch 0", env: { NEWSROOM_SYMBOL_MAP: "0", NEWSROOM_US_STATES: "1" }, spec: base("symbol_map", { category_names: "worldbank" }) },
    { name: "symbol_map switch unset", env: { NEWSROOM_SYMBOL_MAP: undefined, NEWSROOM_US_STATES: "1" }, spec: base("symbol_map", { category_names: "worldbank" }) },
    { name: "us choropleth", env: { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_US_STATES: "1" }, spec: base("choropleth", { category_names: "us_state" }) },
    { name: "us symbol_map", env: { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_US_STATES: "1" }, spec: base("symbol_map", { category_names: "us_state" }) },
    { name: "us choropleth, US_STATES unset", env: { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_US_STATES: undefined }, spec: base("choropleth", { category_names: "us_state" }) },
    { name: "cartographic_flow_map", env: { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_US_STATES: "1" }, spec: { ...common, chart_type: "cartographic_flow_map", value_field: "value", unit: "t", geometry_semantics: "abstract_od", geometry_crs: "EPSG:4326", projection: "natural_earth_1", source_lat_field: "a", source_lon_field: "b", target_lat_field: "c", target_lon_field: "d" } },
  ];
  for (const cfg of configs) {
    // the category_names enum of NEWSROOM_US_STATES is read when the modules load and isUsStateMap reads it on every call; the driver starts this worker once per setting, the other switch is read per call
    if (cfg.env.NEWSROOM_US_STATES !== process.env.NEWSROOM_US_STATES) continue;
    if (cfg.env.NEWSROOM_SYMBOL_MAP === undefined) delete process.env.NEWSROOM_SYMBOL_MAP; else process.env.NEWSROOM_SYMBOL_MAP = cfg.env.NEWSROOM_SYMBOL_MAP;
    for (const id of ids) {
      const entry = typeof id === "string" ? reg.getBasemap(id) : null;
      const right = entry ?? reg.getBasemap(ID50);
      const right3 = { basemap_source_url: right.source_url, basemap_license: right.license, basemap_content_hash: right.content_hash };
      for (const url of ["absent", "right", "wrong", "blank"]) for (const lic of ["absent", "right", "wrong", "blank"]) for (const hash of ["absent", "right", "wrong", "null", "blank"]) {
        const spec = { ...cfg.spec };
        if (id !== undefined) spec.basemap_id = id;
        const pick = (field, mode) => { if (mode === "right") spec[field] = right3[field]; else if (mode === "wrong") spec[field] = `wrong-${field}`; else if (mode === "null") spec[field] = null; else if (mode === "blank") spec[field] = "  "; };
        pick("basemap_source_url", url); pick("basemap_license", lic); pick("basemap_content_hash", hash);
        const label = `${cfg.name} id=${JSON.stringify(id)} url=${url} license=${lic} hash=${hash}`;
        const b = next.validateVizSpec(JSON.parse(JSON.stringify(spec)));
        const c = old.validateVizSpec(JSON.parse(JSON.stringify(spec)));
        seen.cells++;
        if ((c.length > 0) !== (b.length > 0)) failures.push(`refused-or-allowed differs: ${label}`);
        if (c.length !== b.length) failures.push(`refusal line count differs (${c.length} vs ${b.length}): ${label}`);
        const mapped = b.map(toOld);
        if (JSON.stringify(mapped) !== JSON.stringify(c)) failures.push(`refusals differ: ${label}\n  old: ${JSON.stringify(c)}\n  new: ${JSON.stringify(mapped)}`);
        if (c.length) seen.refused++; else seen.allowed++;
        // the sentence is true: change the call as the refusals say (again if the next refusal has its own hint), fill as the product does,
        // and no provenance refusal is left. A flow map with basemap_id null first learns about the id, then about a wrong value.
        const first = followHints(spec, b);
        if (first) {
          seen.followed++;
          let call = first.fixed;
          let filled = productFill(call), left = next.validateVizSpec(JSON.parse(JSON.stringify(filled)));
          // one round must clear every field the refusals named (a lie in the sentence, e.g. the wrong basemap_id, stays visible here)
          const named = left.filter((l) => provenanceRefusal(l) && first.touched.has(fieldOf(l)));
          if (named.length) failures.push(`a field the refusal named is refused again after doing what it says: ${label}\n  ${named.map((l) => l.slice(0, 140)).join("\n  ")}`);
          for (let round = 1; round < 3 && left.some((l) => /out of the call/.test(l)); round++) {
            call = followHints(call, left).fixed;
            filled = productFill(call); left = next.validateVizSpec(JSON.parse(JSON.stringify(filled)));
          }
          const bad = left.filter(provenanceRefusal);
          if (bad.length) failures.push(`still refused after doing what the refusal says: ${label}\n  ${bad.map((l) => l.slice(0, 140)).join("\n  ")}`);
          for (const kind of new Set(b.filter((l) => /out of the call/.test(l)).map(hintKind))) {
            const key = `${cfg.name}|${kind}`;
            if (viaRealPlan.has(key) || cfg.name.endsWith("US_STATES unset")) continue; // that setting refuses us_state names before any plan can pass
            viaRealPlan.add(key);
            seen.realPlans++;
            const params = { ...call, sql: planSql, takeaway: "Places differ.", mixed_period_strategy: "explicit" };
            let stored;
            try { stored = await realPlan(params); } catch (e) { failures.push(`real newsroom_viz_plan refuses after doing what the refusal says: ${label}: ${String(e.message).slice(0, 200)}`); continue; }
            for (const k of ["basemap_id", ...KEYS]) if (stored[k] !== filled[k]) failures.push(`the stand-in fill differs from the real plan on ${k}: ${label}`);
          }
        }
        for (const line of b) {
          if (toOld(line) !== line) seen.changedLines++;
          for (const secret of secrets) if (line.includes(secret)) failures.push(`a registry value is printed: ${label}: ${line.slice(0, 120)}`);
          if (/^(?:basemap_id requires|basemap_(?:source_url|license|content_hash) does not match)/.test(line) && !/leave .* out of the call and the program fills/.test(line)) failures.push(`no "program fills it" sentence: ${line.slice(0, 120)}`);
          if (/^Missing required field 'basemap_(?:source_url|license|content_hash)'/.test(line) && !/leave basemap_\w+ out of the call, the program fills it from that basemap's registry entry\)$/.test(line)) failures.push(`bare missing provenance line: ${line.slice(0, 120)}`);
          if (line.includes("; ")) failures.push(`a refusal line holds "; " (the [refusal] reader splits there): ${line.slice(0, 120)}`);
        }
      }
    }
  }
  // a flow map with no basemap_id: the mismatch lines name the registry entry's id, never "undefined"
  const noId = next.validateVizSpec(JSON.parse(JSON.stringify({ ...configs.at(-1).spec, basemap_source_url: "x", basemap_license: "x", basemap_content_hash: "x" })));
  if (noId.filter((l) => /does not match/.test(l)).length !== 3 || noId.some((l) => l.includes("undefined"))) failures.push(`a flow map without basemap_id: ${JSON.stringify(noId.filter((l) => /basemap_/.test(l)))}`);
  // the [refusal] row: field basemap_id for the id line, field and rule unchanged for the others
  const parserSource = readFileSync(join(pi, "newsroom.ts"), "utf8");
  const slice = parserSource.slice(parserSource.indexOf("const REFUSAL_CODE"), parserSource.indexOf("const REFUSAL_LINE_PREFIX"));
  const parse = new Function(`${stripTypeScriptTypes(slice, { mode: "strip" })}; return refusalFieldsOf;`)();
  process.env.NEWSROOM_SYMBOL_MAP = "1";
  const known = new Set(["basemap_id", "basemap_source_url", "basemap_license", "basemap_content_hash", "category_names", "chart_type"]);
  const rows = (spec) => parse(`Invalid visualization plan: ${next.validateVizSpec(spec).join("; ")}`, known).map((r) => [r.field, r.rule, r.allowed]);
  const oldRows = (spec) => parse(`Invalid visualization plan: ${old.validateVizSpec(spec).join("; ")}`, known).map((r) => [r.field, r.rule, r.allowed]);
  const sm = base("symbol_map", { category_names: "worldbank", basemap_id: ID110 });
  const idRow = rows(sm).find((r) => r[0] === "basemap_id");
  if (!idRow || idRow[1] !== "REQUIRED" || idRow[2] !== null) failures.push(`[refusal] row of the basemap_id line is ${JSON.stringify(idRow)}`);
  const wrong = base("choropleth", { category_names: "worldbank", basemap_id: ID50, basemap_license: "x", basemap_source_url: "y", basemap_content_hash: "z" });
  const nr = rows(wrong), or = oldRows(wrong);
  if (JSON.stringify(nr) !== JSON.stringify(or)) failures.push(`[refusal] rows of the mismatch lines changed: ${JSON.stringify(or)} -> ${JSON.stringify(nr)}`);
  const miss = rows(base("symbol_map", { category_names: "worldbank" })).filter((r) => r[1] === "REQUIRED").map((r) => r[0]);
  for (const f of ["basemap_id", "basemap_source_url", "basemap_license", "basemap_content_hash"]) if (!miss.includes(f)) failures.push(`[refusal] row for missing ${f} lost`);
  console.log(JSON.stringify({ seen, failures: failures.slice(0, 12), failureCount: failures.length }));
}

// ---------------------------------------------------------------------------------------------------- driver
function run(mutations) {
  const dir = makeTestTmp("basemap-refusal-text-");
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", MAIN_SHA, "runtime", "config"], { maxBuffer: 1 << 29 });
  assert.equal(archive.status, 0, `git archive ${MAIN_SHA} failed (the full history is needed): ${String(archive.stderr ?? "").slice(0, 200)}`);
  mkdirSync(join(dir, "old"));
  writeFileSync(join(dir, "old.tar"), archive.stdout);
  assert.equal(spawnSync("tar", ["-xf", join(dir, "old.tar"), "-C", join(dir, "old")]).status, 0, "extracting the base commit failed");
  for (const m of mutations) {
    const file = join(dir, "runtime", "pi", m.file);
    const text = readFileSync(file, "utf8");
    assert.equal(text.split(m.from).length - 1, 1, `mutation anchor must occur once in ${m.file}: ${m.from.slice(0, 60)}`);
    writeFileSync(file, text.replace(m.from, () => m.to));
  }
  const out = { seen: { cells: 0, refused: 0, allowed: 0, changedLines: 0, followed: 0, realPlans: 0 }, failures: [], failureCount: 0 };
  for (const us of ["1", undefined]) {
    const env = { ...process.env }; if (us === undefined) delete env.NEWSROOM_US_STATES; else env.NEWSROOM_US_STATES = us;
    const r = spawnSync(process.execPath, [SELF, "worker", dir], { encoding: "utf8", maxBuffer: 1 << 28, env });
    let part;
    try { part = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return { crashed: true, stderr: r.stderr.slice(-400) }; }
    for (const k of Object.keys(out.seen)) out.seen[k] += part.seen[k];
    out.failures.push(...part.failures); out.failureCount += part.failureCount;
  }
  return out;
}

let failed = 0;
function ok(name, fn) { try { fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.log(`not ok - ${name}\n${e.message}`); } }

const real = run([]);
console.log(JSON.stringify(real.seen));
ok("same refused-or-allowed and same refusal lines (modulo the added sentence) on every cell of the matrix, no registry value printed, [refusal] rows as expected", () => {
  assert.ok(!real.crashed, real.stderr);
  assert.equal(real.failureCount, 0, JSON.stringify(real.failures, null, 1));
  assert.ok(real.seen.cells >= 2000 && real.seen.refused > 0 && real.seen.allowed > 0 && real.seen.changedLines > 0 && real.seen.followed > 0 && real.seen.realPlans >= 8, JSON.stringify(real.seen));
});

const MUTANTS = [
  ["a registry value is printed in a refusal", [{ file: "viz.mjs", from: "out of the call and the program fills it from the registry entry for basemap_id '${choroplethBasemapId}'`);\n        if (spec.basemap_content_hash", to: "out of the call and the program fills it from the registry entry for basemap_id '${choroplethBasemapId}' (${basemap.license})`);\n        if (spec.basemap_content_hash" }]],
  ["the 'program fills it' sentence is dropped from the missing-field line", [{ file: "viz.mjs", from: " and leave ${field} out of the call, the program fills it from that basemap's registry entry)`", to: ")`" }]],
  ["the 'program fills it' sentence is dropped from the id line", [{ file: "viz.mjs", from: ", leave basemap_source_url, basemap_license and basemap_content_hash out of the call and the program fills them from that basemap's registry entry`", to: "`" }]],
  ["one refusal is deleted (the result of one cell changes)", [{ file: "viz.mjs", from: "\n      if (spec.basemap_license !== basemap.license) errors.push(`basemap_license does not match the registered basemap provenance, leave basemap_license out of the call and the program fills it from the registry entry for basemap_id '${basemap.id}'`);", to: "" }]],
  ["the [refusal] row of the id line gets no field again", [{ file: "viz.mjs", from: "`basemap_id requires '${choroplethBasemapId}' for ${spec.chart_type} (the only", to: "`choropleth requires basemap_id '${choroplethBasemapId}' for ${spec.chart_type} (the only" }]],
  ["the flow-map lines print basemap_id of the call again (undefined when it is left out)", [{ file: "viz.mjs", from: "registry entry for basemap_id '${basemap.id}'`);\n      if (spec.basemap_license", to: "registry entry for basemap_id '${spec.basemap_id}'`);\n      if (spec.basemap_license" }]],
  ["the missing-field sentence names the world basemap for a US state map", [{ file: "viz.mjs", from: "`'${isUsStateMap(spec) ? CHOROPLETH_US_BASEMAP_ID : CHOROPLETH_BASEMAP_ID}'`", to: "`'${CHOROPLETH_BASEMAP_ID}'`" }]],
  ["the id sentence names the world basemap for a US state map", [{ file: "viz.mjs", from: "basemap_id requires '${choroplethBasemapId}' for ${spec.chart_type}", to: "basemap_id requires '${CHOROPLETH_BASEMAP_ID}' for ${spec.chart_type}" }]],
  ["a refusal line holds a semicolon", [{ file: "viz.mjs", from: "the program fills it from that basemap's registry entry)`", to: "the program fills it; from that basemap's registry entry)`" }]],
];
for (const [name, mutations] of MUTANTS) {
  ok(`mutation goes red: ${name}`, () => {
    const out = run(mutations);
    assert.ok(out.crashed || out.failureCount > 0, "the checks stayed green on a mutated copy");
  });
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
