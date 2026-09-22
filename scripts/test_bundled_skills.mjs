import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LIEFLAT_BUNDLE, VISUAL_SKILL_BUNDLE, VISUAL_SKILL_INDEX, VISUAL_SKILLS } from "../runtime/pi/visual_skill_bundle.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = async (path) => readFile(join(root, path), "utf8");

const expectedSkills = [
  "lieflat-charts",
  "economist-analytical",
  "scmp-integrated-explainer",
  "pudding-visual-essay",
];
for (const name of expectedSkills) {
  assert.ok(VISUAL_SKILLS[name], `missing bundled skill ${name}`);
  assert.equal(VISUAL_SKILL_INDEX[name].name, name);
  const source = await text(`skills/${name}/SKILL.md`);
  assert.equal(VISUAL_SKILLS[name].sha256, sha256(Buffer.from(source)), `${name} skill hash drift`);
  assert.ok(VISUAL_SKILLS[name].body.length > 200, `${name} method body is unexpectedly short`);
}
assert.equal(Object.keys(VISUAL_SKILLS).length, 17, "unexpected bundled skill count");
assert.equal(LIEFLAT_BUNDLE.commit, "eace082a317b696c5570c25826a53a7fa113e984");
assert.equal(LIEFLAT_BUNDLE.license, "PolyForm Noncommercial License 1.0.0");

const required = [
  "SKILL.md", "README.md", "README.en.md", "catalog.md", "report-catalog.md",
  "mono-tokens.js", "color-presets.js", "templates/lupi-gallery.html",
  "templates/basics-gallery.html", "templates/glance-gallery.html",
  "templates/maps-gallery.html", "templates/reports/report-01.zh.html",
  "templates/reports/report-01.en.html", "examples/README.md", "scripts/validate.mjs",
  "agents/openai.yaml", "LICENSE", "THIRD_PARTY_NOTICES.md", "UPSTREAM.json",
];
const entries = [...LIEFLAT_BUNDLE.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
assert.equal(entries.length, 126);
for (const path of required) assert.ok(entries.some((entry) => entry.path === path), `missing vendored file ${path}`);
for (const entry of entries) {
  assert.equal(entry.encoding, "gzip+base64");
  const bytes = gunzipSync(Buffer.from(entry.data, "base64"));
  assert.equal(bytes.length, entry.bytes, `byte count drift: ${entry.path}`);
  assert.equal(sha256(bytes), entry.sha256, `file hash drift: ${entry.path}`);
  assert.ok(!entry.path.split("/").includes(".git"));
}
const upstreamEntries = entries.filter((entry) => entry.path !== "UPSTREAM.json");
for (const entry of upstreamEntries) {
  const sourceBytes = await readFile(join(root, "skills", "lieflat-charts", entry.path));
  assert.equal(sourceBytes.length, entry.bytes, `local vendored byte drift: ${entry.path}`);
  assert.equal(sha256(sourceBytes), entry.sha256, `local vendored hash drift: ${entry.path}`);
}
const upstreamMetadata = JSON.parse(await text("skills/lieflat-charts/UPSTREAM.json"));
assert.equal(upstreamMetadata.commit, LIEFLAT_BUNDLE.commit);
assert.equal(upstreamMetadata.license, LIEFLAT_BUNDLE.license);
assert.equal(upstreamMetadata.source_tree_sha256, LIEFLAT_BUNDLE.source_tree_sha256);
assert.equal(upstreamMetadata.source_file_count, LIEFLAT_BUNDLE.source_file_count);
const treeHasher = createHash("sha256");
for (const entry of upstreamEntries) treeHasher.update(`${entry.path}\0${entry.sha256}\0${entry.bytes}\n`);
assert.equal(treeHasher.digest("hex"), LIEFLAT_BUNDLE.source_tree_sha256);
assert.equal(upstreamEntries.length, LIEFLAT_BUNDLE.source_file_count);
const aggregateManifest = entries.map(({ path, bytes, sha256: digest }) => ({ bytes, path, sha256: digest }));
assert.equal(sha256(Buffer.from(JSON.stringify(aggregateManifest))), LIEFLAT_BUNDLE.aggregate_sha256);

const index = JSON.parse(await text("config/bundled-skills.json"));
assert.equal(index.lieflat.commit, LIEFLAT_BUNDLE.commit);
assert.equal(index.lieflat.license, LIEFLAT_BUNDLE.license);
assert.equal(index.lieflat.aggregate_sha256, LIEFLAT_BUNDLE.aggregate_sha256);
assert.deepEqual(index.lieflat.files, entries.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest })));

console.log(JSON.stringify({
  status: "PASS",
  skill_count: Object.keys(VISUAL_SKILLS).length,
  lieflat_file_count: entries.length,
  upstream_source_file_count: upstreamEntries.length,
  upstream_commit: LIEFLAT_BUNDLE.commit,
  aggregate_sha256: LIEFLAT_BUNDLE.aggregate_sha256,
}, null, 2));
