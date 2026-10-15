#!/usr/bin/env node
// Every localeCompare call in runtime/ and scripts/ names its locale. Without one the order follows the machine's default locale
// (for example zh-CN puts Chinese before Latin letters), so the same input could produce different bytes on different machines.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/test_locale_compare_explicit.mjs";

// Returns the top-level argument texts of the call whose "(" is just before index i, and the index of the closing ")".
function callArgs(s, i) {
  const args = []; let depth = 0, start = i, q = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === "\\") { j++; continue; }
      if (q === "`" && c === "$" && s[j + 1] === "{") { let d = 1; j += 2; while (d) { if (s[j] === "{") d++; else if (s[j] === "}") d--; j++; } j--; continue; }
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") q = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) { args.push(s.slice(start, j).trim()); return args; } depth--; }
    else if (c === "," && depth === 0) { args.push(s.slice(start, j).trim()); start = j + 1; }
  }
  throw new Error("unbalanced localeCompare call");
}

export function callsWithoutLocale(text) {
  const bad = [];
  for (const m of text.matchAll(/localeCompare\(/g)) {
    const args = callArgs(text, m.index + m[0].length);
    if (args.length < 2 || args[1] === "undefined" || args[1] === "") bad.push(text.slice(0, m.index).split("\n").length);
  }
  return bad;
}

// the checker itself: these must be caught, and these must pass
assert.deepEqual(callsWithoutLocale("a.localeCompare(b)"), [1]);
assert.deepEqual(callsWithoutLocale("x\na.localeCompare(String(b), undefined, { numeric: true })"), [2]);
assert.deepEqual(callsWithoutLocale("a.localeCompare(f(b, c))"), [1]);
assert.deepEqual(callsWithoutLocale('a.localeCompare(b, "en-US")'), []);
assert.deepEqual(callsWithoutLocale('a.localeCompare(String(b), "en-US", { numeric: true })'), []);
assert.deepEqual(callsWithoutLocale("a.localeCompare(`${b},x`, 'en')"), []);

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const found = [];
for (const dir of ["runtime", "scripts"]) {
  for (const file of walk(join(root, dir), [])) {
    const rel = relative(root, file);
    if (rel === SELF) continue;
    for (const line of callsWithoutLocale(readFileSync(file, "utf8"))) found.push(`${rel}:${line}`);
  }
}
assert.deepEqual(found, [], `localeCompare without a locale (pass "en-US"):\n${found.join("\n")}`);
console.log("localeCompare locale guard: ok");
