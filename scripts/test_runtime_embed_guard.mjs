// Every runtime file newsroom.ts can reach through ./ imports (static, re-export or dynamic) must be in the embed list of
// src/runtime.rs, because `news` writes the runtime folder from that list: a file missing there is missing in an installed news
// and the import fails when it loads. Read-only: reads source files, writes nothing.
// Usage: node scripts/test_runtime_embed_guard.mjs [repo-root]   (the root argument lets the mutation checks point at a copy)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const piDir = join(root, "runtime", "pi");

// files in the embed list: include_str!("../runtime/pi/<path>")
const rs = readFileSync(join(root, "src", "runtime.rs"), "utf8");
const embedded = new Set([...rs.matchAll(/include_str!\(\s*"\.\.\/runtime\/pi\/([^"]+)"\s*\)/g)].map((m) => m[1]));
assert.ok(embedded.has("newsroom.ts") && embedded.has("viz.mjs"), "the embed list was not parsed (newsroom.ts / viz.mjs missing)");

// ./ and ../ specifiers: import ... from "x", export ... from "x", import "x", import("x")
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
function relativeImports(file) {
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...src.matchAll(SPEC)].map((m) => m[1]);
}

const seen = new Map(); // path under runtime/pi -> first file that imported it
const queue = ["newsroom.ts"];
const missing = [];
const unresolved = [];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.set(name, true);
  const file = join(piDir, name);
  if (!existsSync(file)) { unresolved.push(name); continue; }
  if (!/\.(?:mjs|js|ts)$/.test(name)) continue;
  for (const spec of relativeImports(file)) {
    const target = normalize(join(dirname(name), spec));
    if (target.startsWith("..")) continue; // leaves runtime/pi: not part of the embedded runtime
    if (!embedded.has(target)) missing.push(`${target} (imported by ${name})`);
    queue.push(target);
  }
}
assert.deepEqual(unresolved, [], `imports that point at no file: ${unresolved.join(", ")}`);
assert.deepEqual(missing, [], `runtime files reachable from newsroom.ts but not in the embed list of src/runtime.rs:\n  ${missing.join("\n  ")}`);
console.log(`ok test_runtime_embed_guard: ${seen.size} files reachable from newsroom.ts, all in the embed list (${embedded.size} entries)`);
