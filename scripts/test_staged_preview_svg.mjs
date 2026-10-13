#!/usr/bin/env node
// K354: inside a staged call (NEWSROOM_AGENT=rust) a tool chain's render step leaves the SVG in the call's staging folder, so the preview step's child
// process (the rasterizer) must be given the staged copy, and only when the run folder does not have the file. Outside a staged call, and whenever the run
// folder has the file, the child's argv is exactly what it was before. A fake rasterizer (NEWSROOM_PYTHON_BIN) records its argv, fails with
// "input SVG does not exist" when its input path is not a file, and otherwise writes a minimal PNG. Loads newsroom.ts from a type-stripped copy.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("staged-preview-");
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));

const run = join(tmp, "run");
mkdirSync(run, { recursive: true });
const argvLog = join(tmp, "argv.log");
const fake = join(tmp, "fake-rasterizer.sh");
writeFileSync(fake, `#!/bin/sh
# argv: <script> <input svg> <output png> --width <n>
printf '%s\\n' "$*" >> "${argvLog}"
if [ "$1" != "${tmp}/never" ] && [ "$2" = "--request" ]; then
  [ -f "$3" ] || { echo "request does not exist: $3" >&2; exit 2; }
  echo '{"summary":{"node_count":2,"edge_count":1,"community_count":1,"retained_cross_community_weight_fraction":1,"displayed_meta_edges":0},"result_hash":"h","id":"i","detail_class":"d","features":[],"content_hash":"c"}' > "$5"
  exit 0
fi
if [ ! -f "$2" ]; then echo "input SVG does not exist: $2" >&2; exit 2; fi
printf '\\211PNG\\r\\n\\032\\n' > "$3"
head -c 200 /dev/zero >> "$3"
echo '{"engine": "fake"}'
`);
chmodSync(fake, 0o755);
process.env.NEWSROOM_ARTIFACT_DIR = run;
process.env.NEWSROOM_PYTHON_BIN = fake;

const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const { runInStagedCall, withStagedCall } = await import(join(pi, "groups.mjs"));
const staging = join(run, "staging");
const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>");
const ref = "infographics/page-desktop.svg";
const callStep = (id, fn, chainDone) => withStagedCall({ execute: fn }).execute(id, {}, undefined, undefined, undefined, chainDone === undefined ? undefined : { chainDone });
const outer = (id, fn) => runInStagedCall(id, join(staging, id), fn);
const argvLines = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean) : []);
const lastInput = () => argvLines().at(-1).split(" ")[1];

// 1 + 2: a chain inside one staged call. The render step stages the SVG; the preview step (named the render as finished) rasterizes it.
await outer("c1", async () => {
  await callStep("c1:newsroom_infographic_render", () => mod.__writeArtifactBytesIfAbsentForTest(ref, svg));
  assert.equal(existsSync(join(run, ref)), false, "the SVG is still only staged, not in the run folder");
  await callStep("c1:newsroom_infographic_preview", async () => {
    const result = await mod.__rasterizeArtifactSvgForTest(ref, 1440);
    assert.equal(result.bytes.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(result.engine, "fake");
  }, ["newsroom_infographic_render"]);
});
assert.equal(argvLines().length, 1);
assert.ok(lastInput().startsWith(join(staging, "c1")), `the child got the staged copy: ${lastInput()}`);
assert.equal(readFileSync(lastInput()).equals(svg), true, "the staged copy has the render step's bytes");

// the infographics/ prefix check and the existence check stay: a path outside it, and a file nobody wrote, are still refused
await outer("c2", async () => {
  await assert.rejects(() => mod.__rasterizeArtifactSvgForTest("data/x.svg", 1440), /must be under infographics\//);
  await assert.rejects(() => mod.__rasterizeArtifactSvgForTest("infographics/none.svg", 1440));
});

// 3: preview as its own call after a render call that already committed: the run folder has the file, the child gets exactly the run-folder path
mkdirSync(join(run, "infographics"), { recursive: true });
writeFileSync(join(run, ref), svg);
const runPath = join(run, ref);
await outer("c3", async () => {
  await callStep("c3:newsroom_infographic_preview", () => mod.__rasterizeArtifactSvgForTest(ref, 1440));
});
assert.equal(lastInput(), runPath);
// the same when a staged rewrite of the same file also exists: the run folder's file wins, as before
await outer("c4", async () => {
  await callStep("c4:newsroom_infographic_render", () => mod.__writeArtifactBytesIfAbsentForTest(ref, Buffer.concat([svg, Buffer.from("<!-- x -->")])));
  await callStep("c4:newsroom_infographic_preview", () => mod.__rasterizeArtifactSvgForTest(ref, 1440), ["newsroom_infographic_render"]);
});
const afterC4 = argvLines().at(-1);

// 4: outside any staged call (Pi path): the run-folder path, exact argv form as before
await mod.__rasterizeArtifactSvgForTest(ref, 720);
const lines = argvLines();
const parts = lines.at(-1).split(" ");
assert.equal(parts[1], runPath);
assert.equal(parts[3], "--width");
assert.equal(parts[4], "720");
assert.ok(parts[2].startsWith(join(run, "runtime", "preview-tmp")) && parts[2].endsWith(".png"));
assert.equal(afterC4.split(" ")[1], runPath);

// the same rule for the other children that are handed a request file the same call wrote (graph analysis, graph reduction, basemap): run the registered
// tools with a fake script. Inside a staged call the request comes from staging while the run folder lacks it; outside one, or when the run folder has it, the
// argv carries the run-folder path as before.
process.env.NEWSROOM_TOOL_PROFILE = "full";
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const requestPath = (name, params, where) => {
  const before = argvLines().length;
  return where(() => tools.get(name).execute("t", params, undefined, undefined, {})).then(() => argvLines().slice(before).at(-1).split(" ")[2]);
};
const jobs = [
  ["newsroom_network_analyze", { nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] }, "visualizations/graph-analysis/requests/"],
  ["newsroom_network_reduce", { nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] }, "visualizations/graph-reduction/requests/"],
  ["newsroom_basemap_prepare", { west: 0, east: 10, south: 0, north: 10 }, "maps/basemaps/requests/"],
];
for (const [name, params, dir] of jobs) {
  assert.ok(tools.has(name), `${name} is registered`);
  // outside a staged call (the Pi path): the written request is in the run folder, the child gets that path
  const outside = await requestPath(name, params, (f) => f());
  assert.ok(outside.startsWith(join(run, dir)), `${name} outside a staged call: ${outside}`);
  // inside a staged call, run folder empty for that request (fresh run folder copy): the child gets the staged copy
  const fresh = join(tmp, `run-${name}`);
  mkdirSync(fresh, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = fresh;
  const inside = await requestPath(name, params, (f) => outer(`s-${name}`, f));
  assert.ok(inside.startsWith(staging), `${name} inside a staged call: ${inside}`); // the fake script already refused a request that was not a file when it ran
  // inside a staged call, but the run folder already has the same request: the run-folder path, as before
  const again = await requestPath(name, params, (f) => outer(`s2-${name}`, async () => { mkdirSync(join(fresh, dir), { recursive: true }); writeFileSync(join(fresh, dir, basename(inside)), "{}"); return f(); }));
  assert.equal(again, join(fresh, dir, basename(inside)), `${name} run folder has the request`);
  process.env.NEWSROOM_ARTIFACT_DIR = run;
}

console.log("test_staged_preview_svg: ok");
