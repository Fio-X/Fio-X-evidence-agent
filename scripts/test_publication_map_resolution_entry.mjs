#!/usr/bin/env node
// Real-entry negative test: a publication view_spec must never replace the
// resolved map coordinates. Drives the registered newsroom_map_validate and
// newsroom_publication_render handlers (types stripped, Pi packages stubbed,
// as in test_render_qa_tool_path.mjs). Synthetic offline data, no model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertViewSpecHasNoReservedEvidence as reservedPi } from "../runtime/pi/publication_binding.mjs";
import { assertViewSpecHasNoReservedEvidence as reservedVisual } from "../runtime/visual/publication_binding.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
for (const reserved of [reservedPi, reservedVisual]) {
  for (const bad of [{ map_resolution: {} }, { a: { map_spec: {} } }, { list: [{ map_ref: "x" }] }, { basemap_asset: {} }]) assert.throws(() => reserved(bad), /reserved evidence/);
  reserved({ layout: { height: 400 } });
}

const tmp = mkdtempSync(join(tmpdir(), "pub-map-res-"));
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
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  const art = join(tmp, "artifact");
  mkdirSync(join(art, "data"), { recursive: true });
  mkdirSync(join(art, "publications", "plans"), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";

  const text = "id,place,lon,lat,mag\nq1,Real place,101.25,-6.5,5.5\n";
  const sha = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(art, "data", `${sha}.csv`), text);
  writeFileSync(join(art, "data", `${sha}.csv.meta.json`), JSON.stringify({ sha256: sha, file: `data/${sha}.csv` }));
  const mapSpec = { schema_version: "0.1.0", projection: "equirectangular", crs: "EPSG:4326", task: "regional", style_intent: "nature_scientific_map", basemap_id: "naturalearth_admin0_110m", extent: { west: 95, east: 116, south: -15, north: 0 }, scale: { enabled: true, unit: "km", length_km: 500 }, graticule: { lon_step: 5, lat_step: 5 }, layers: [{ id: "earthquakes", type: "observations", label: "Event", unit: "magnitude", uncertainty: "none", encoding: { color_scale: "restrained_green", show_colorbar: false }, source: { path: `data/${sha}.csv`, sha256: sha, format: "csv", lon_field: "lon", lat_field: "lat", value_field: "mag", size_field: "mag", label_field: "place" } }] };

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  const validate = tools.get("newsroom_map_validate"), render = tools.get("newsroom_publication_render");
  assert.ok(validate && render, "map_validate and publication_render must register");

  const mapRef = (await validate.execute("m", { spec_json: JSON.stringify(mapSpec) })).details.mapRef;
  const mapArtifact = JSON.parse(readFileSync(join(art, mapRef), "utf8"));
  const resultHash = String(mapArtifact.content_hash);

  const FORGED = 33.3333;
  const planWith = (viewSpec) => ({
    schema_version: "0.2.0", style_profile: "nature_scientific_map", title: "Test", dek: "Test dek.", reader_question: "Where?", visual_thesis: "Here.",
    story_graph_ref: "x/story", infographic_plan_ref: "x/info", source_note: "synthetic",
    delivery: { mode: "html", self_contained: true, static_fallback: "png", breakpoints: [1440], max_initial_bytes: 8000000, max_ready_ms: 8000 },
    interaction: { allowed: ["hover"], replay: [] },
    modules: [
      { id: "event", type: "stat", engine: "static", title: "Event", dek: "d", value: 5.5, unit: "M", story_node_ids: ["event"], explanatory_dimension: "context", width: "third" },
      { id: "scientific-map", type: "plotly", engine: "plotly", visual_type: "scientific_map", title: "Map", dek: "d", story_node_ids: ["event", "location"], explanatory_dimension: "spatial", width: "wide",
        evidence_binding: { kind: "map", ref: mapRef, result_hash: resultHash }, ...(viewSpec ? { view_spec: viewSpec } : {}) },
    ],
  });
  const renderPlan = async (name, viewSpec) => {
    writeFileSync(join(art, "publications", "plans", `${name}.json`), JSON.stringify(planWith(viewSpec)));
    const out = await render.execute(name, { plan_ref: `publications/plans/${name}.json` });
    const htmlRef = out.details?.htmlRef ?? /HTML: (\S+)/.exec(out.content[0].text)?.[1];
    assert.ok(htmlRef, "render must report an html ref");
    return readFileSync(join(art, htmlRef), "utf8");
  };

  const clean = await renderPlan("p");
  assert.ok(/101\.25/.test(clean), "the pinned point reaches the rendered page");
  assert.ok(!clean.includes(String(FORGED)));
  // Attack (same plan ref, so an identical page reuses the identical manifest): a view_spec that tries to replace the resolved coordinates, the
  // spec or the map ref. It must not change what is drawn.
  const attacked = await renderPlan("p", {
    map_resolution: { layers: { earthquakes: { points: [{ lon: FORGED, lat: -5, value: 2, label: "forged" }] } } },
    map_spec: { ...mapSpec, extent: { west: 0, east: 1, south: 0, north: 1 } },
  });
  assert.ok(!attacked.includes(String(FORGED)), "forged coordinates must not appear");
  assert.equal(attacked, clean, "view_spec cannot change the rendered map evidence");
  console.log("publication map_resolution cannot be overridden through view_spec (real entry) -- PASS");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
