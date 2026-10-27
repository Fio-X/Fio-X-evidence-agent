// Mutations of the asset-source kind check (scripts/test_asset_source_kind.mjs must go red for each). Each edit is applied to the real file,
// the test runs, and the file is put back (also on error). Offline.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ART = "runtime/pi/art_direction.mjs", NEWS = "runtime/pi/newsroom.ts";
const GATE = 'if (process.env.NEWSROOM_SPEED_DESIGN_PACK === "1") {\n              for (const typed of requirement.source_refs)';
const MUTANTS = [
  ["K1: the check accepts any file (relaxed to any file)", ART, "export function assetSourceRefProblem(rel, parsed, assetClass) {\n", "export function assetSourceRefProblem(rel, parsed, assetClass) {\n  return null;\n"],
  ["K2: the circular-reference rule is skipped", ART, "if (rel.startsWith(prefix) && !(except && directJson(rel, except))) return `source_refs", "if (false) return `source_refs"],
  ["K3: a basemap is a source for any asset class", ART, "if (!MAP_ASSET_CLASSES.includes(assetClass)) return `source_refs entry ${rel} is a basemap", "if (false) return `source_refs entry ${rel} is a basemap"],
  ["K4: a basemap file needs source_url only, not the licence", ART, "if (text(parsed.source_url) && text(parsed.license)) return null;", "if (text(parsed.source_url)) return null;"],
  ["K5: an illustration manifest is a source for any asset class", ART, "if (!accepted.classes.includes(assetClass)) return `source_refs entry ${rel} is a graphic", "if (false) return `source_refs entry ${rel} is a graphic"],
  ["K6: the third way back: any other file is accepted", ART, "if (!accepted) return `source_refs entry ${rel} is not a source", "if (!accepted) return null; if (!accepted) return `source_refs entry ${rel} is not a source"],
  ["K7: classified by the typed name, not the real path", NEWS, "const rel = await realRunRel(typed);", "const rel = typed;"],
  ["K8: the check runs whatever the design pack switch says", NEWS, GATE, GATE.replace('process.env.NEWSROOM_SPEED_DESIGN_PACK === "1"', "true")],
  ["K9: the check runs unless the switch is exactly 0", NEWS, GATE, GATE.replace('=== "1"', '!== "0"')],
  ["K10: the problem is computed but not thrown", NEWS, "if (problem) throw new Error(problem);", "if (problem) void problem;"],
  ["K11: a drawn class list that includes published_gis", ART, "['verified_diagram', 'vector_illustration', 'human_scale_reference']", "['verified_diagram', 'vector_illustration', 'human_scale_reference', 'published_gis']"],
  ["K12: the asset class handed to the check is not the requirement's", NEWS, "assetSourceRefProblem(rel, parsed, String(requirement.asset_class))", 'assetSourceRefProblem(rel, parsed, "verified_diagram")'],
];
let caught = 0;
for (const [name, file, from, to] of MUTANTS) {
  const path = join(ROOT, file), original = readFileSync(path, "utf8");
  if (original.split(from).length !== 2) { console.log(`  ERROR ${name}: anchor not found exactly once`); process.exitCode = 1; continue; }
  let red = false, tail = "";
  try {
    writeFileSync(path, original.replace(from, () => to));
    const run = spawnSync("node", ["scripts/test_asset_source_kind.mjs"], { cwd: ROOT, encoding: "utf8" });
    red = run.status !== 0; tail = (run.stderr.split("\n").find((l) => /AssertionError|Error:/.test(l)) ?? "").slice(0, 120);
  } finally { writeFileSync(path, original); }
  console.log(`  ${red ? "red " : "GREEN"} ${name}${red ? `  [${tail}]` : ""}`);
  if (red) caught += 1; else process.exitCode = 1;
}
console.log(`asset source kind mutations: ${caught}/${MUTANTS.length} caught -- ${caught === MUTANTS.length ? "PASS" : "FAIL"}`);
