// Only the three writer modules may use runAsWriter (groups.mjs defines it).
// A tool that could call it would pick its own writer identity.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["runtime/pi", "runtime/visual"];
const EXT = /\.(mjs|cjs|js|ts|mts|cts|jsx|tsx)$/;
const ALLOWED = new Set([
  "runtime/pi/groups.mjs",
  "runtime/pi/knowledge_writer.mjs",
  "runtime/pi/decision_writer.mjs",
  // Flow group (agent): writes the extreme-probe diagnosis record, once, as the agent writer. It is a writer module
  // like the two above: it calls runAsWriter("agent", ...) itself and no tool picks its own identity.
  "runtime/pi/extreme_probe_writer.mjs",
]);
const NAME = /\brunAsWriter\b/;
const GROUPS_SPEC = /["'`][^"'`]*\bgroups\.mjs["'`]/;

// Reasons a source text uses runAsWriter: any mention (named import, member
// access on a namespace, destructured dynamic import or require, string key).
export function findUses(text) {
  const out = [];
  if (NAME.test(text)) out.push("mentions runAsWriter");
  // A namespace/dynamic/require handle on groups.mjs that is not a plain
  // named import could reach it by a computed key, so flag those too.
  const handle =
    /import\s*\*\s*as\s+\w+\s+from\s*["'`][^"'`]*groups\.mjs["'`]/.test(text) ||
    /import\s*\(\s*["'`][^"'`]*groups\.mjs["'`]\s*\)/.test(text) ||
    /require\s*\(\s*["'`][^"'`]*groups\.mjs["'`]\s*\)/.test(text);
  if (handle) out.push("takes a whole-module handle on groups.mjs");
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (EXT.test(name)) acc.push(p);
  }
  return acc;
}

// 1. The detector itself catches every import form.
const forms = {
  named: `import { runAsWriter } from "./groups.mjs";`,
  aliased: `import { runAsWriter as r } from "./groups.mjs";`,
  namespace: `import * as g from "./groups.mjs";\ng.runAsWriter("a","b",f);`,
  namespaceComputed: `import * as g from "./groups.mjs";\ng["run"+"AsWriter"]();`,
  dynamic: `const m = await import("./groups.mjs"); m.runAsWriter();`,
  dynamicComputed: `const m = await import('./groups.mjs'); m["run"+"AsWriter"]();`,
  require: `const { runAsWriter } = require("./groups.mjs");`,
  requireComputed: "const m = require(`./groups.mjs`); m[k]();",
};
for (const [k, src] of Object.entries(forms)) {
  assert.ok(findUses(src).length > 0, `detector misses form: ${k}`);
}
assert.deepEqual(findUses(`import { currentWriter } from "./groups.mjs";`), []);
assert.deepEqual(findUses(`const x = 1;`), []);

// 2. No other module uses it.
const files = SCAN.flatMap((d) => walk(join(root, d)));
assert.ok(files.length > 20, "scan found too few files");
const bad = [];
for (const f of files) {
  const rel = relative(root, f).split("\\").join("/");
  if (ALLOWED.has(rel)) continue;
  const uses = findUses(readFileSync(f, "utf8"));
  if (uses.length) bad.push(`${rel}: ${uses.join("; ")}`);
}
assert.deepEqual(bad, [], `runAsWriter used outside the three writer modules:\n${bad.join("\n")}`);

// 3. The allowed modules exist, and the three writers really use it.
for (const f of ALLOWED) assert.ok(statSync(join(root, f)).isFile(), `${f} missing`);
for (const f of ["runtime/pi/knowledge_writer.mjs", "runtime/pi/decision_writer.mjs", "runtime/pi/extreme_probe_writer.mjs"]) {
  assert.ok(NAME.test(readFileSync(join(root, f), "utf8")), `${f} no longer uses runAsWriter`);
}
assert.ok(GROUPS_SPEC.test(readFileSync(join(root, "runtime/pi/knowledge_writer.mjs"), "utf8")));
console.log("ok: runAsWriter is used only by the three writer modules (" + files.length + " files scanned)");
