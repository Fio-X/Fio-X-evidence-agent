// Helper of the Rust test verify::tests::row_hash_agrees_between_the_two_runtimes. Prints {fixture: hashRows(rows)} as JSON for
// every fixture group of scripts/row_hash_cross_runtime.json. ROWHASH_MUTATE (JSON [{from,to}]) applies exact one-time text
// replacements to viz.mjs in a temporary copy of runtime/pi first (mutation proofs); the product files are never changed.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const mutations = JSON.parse(process.env.ROWHASH_MUTATE ?? "[]");
let vizPath = join(ROOT, "runtime/pi/viz.mjs");
let temp;
if (mutations.length) {
  temp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "row-hash-mutant-"));
  cpSync(join(ROOT, "runtime"), join(temp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(temp, "config"), { recursive: true });
  vizPath = join(temp, "runtime/pi/viz.mjs");
  let text = readFileSync(vizPath, "utf8");
  for (const m of mutations) {
    if (text.split(m.from).length - 1 !== 1) { console.error(`mutation anchor must occur once: ${m.from}`); process.exit(3); }
    text = text.replace(m.from, () => m.to);
  }
  writeFileSync(vizPath, text);
}
try {
  const { hashRows } = await import(pathToFileURL(vizPath).href);
  const fixtures = JSON.parse(readFileSync(join(ROOT, "scripts/row_hash_cross_runtime.json"), "utf8"));
  const out = {};
  for (const group of ["must_equal", "report_only"]) for (const [name, rows] of Object.entries(fixtures[group])) out[name] = hashRows(rows);
  process.stdout.write(JSON.stringify(out));
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
