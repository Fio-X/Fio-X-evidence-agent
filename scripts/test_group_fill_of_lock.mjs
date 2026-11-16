#!/usr/bin/env node
// fill_of lock: the flow's page fill (src/next_run.rs fn fill_of) asks the visual group's nodes and keeps the run's records; it
// chooses no chart and branches on no recipe or layer. Three rules over its body (from its `fn fill_of(` line to the first line
// that starts with `}`), each with must-fail self-tests:
//   (a) no string literal that is a key (letters, digits, `_` and `.` only) names a registered chart kind as a run of its
//       identifier parts (every registry name, the ordinary words too: the kinds the flow ratchet reads, registryKinds plus
//       the baseline's stored set), except on the record-key lines listed in RECORD_KEYS;
//   (b) no match or comparison on a recipe or layer name: no `recipe.name`, no `==` / `!=` against a string literal, no
//       match arm on a string literal (`"..." =>`), no `contains(&"...")` / `contains("...")`;
//   (c) the flow ratchet's own hits inside it (scanText over the whole file, kept to its lines) are exactly RATCHET_HITS:
//       count, the kind names matched and the line's text, as a multiset (line numbers move; the text does not).
// It reads source only. It changes no rule of the flow ratchet; importing it runs the ratchet's self-tests and check as well.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COUNTS, normKind, registryKinds, scanText } from "./test_group_flow_ratchet.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "src/next_run.rs";
const read = (p) => { const f = join(REPO, p); return existsSync(f) ? readFileSync(f, "utf8") : null; };
const list = (d) => { const f = join(REPO, d); return existsSync(f) ? readdirSync(f) : null; };

// The record-key lines (11-03 audit): the request's names, the composition record and its bars key.
const RECORD_KEYS = new Map([
  ['p["names"] = json!(leaf_labels(&[], &picks.ranked, catalogue).map_err(no)?);', ["names"]],
  ["let Filled { drawn, rows, facts, mut fmts, data, mut hero, notes, points, named: name_rows, unit_drawn, flow_pairs, composition: cut, .. } = out;", ["composition"]],
  ['let spec = json!({"title": title, "dek": dek, "tables": tables, "facts": facts, "fmts": fmts, "hero": hero});', ["hero"]],
  ['let mut knobs = json!({"spec": spec, "labels": labels});', ["labels"]],
  ["if let (Some(comp), Some(cut)) = (&shape.composition, cut) {", ["composition"]],
  ['fill["composition"] = json!({"template": cut["template"], "dim": comp.dim, "total": comp.total,', ["composition"]],
  ['"groups": comp.groups, "year": shape.year, "place": shape.place, "candidates": shape.countries, "bars": cut["bars"],', ["bars"]],
]);
// The flow ratchet's 9 lines in fill_of (11-03 audit): one node (its own definition), one copy line, seven kinds lines.
const RATCHET_HITS = [
  ["nodes", [], "fn fill_of("],
  ["copy", [], 'let line = std::iter::once(unit_line.unwrap_or_else(|| format!("单位：{short}"))).chain(notes).collect::<Vec<_>>().join("；");'],
  ...[...RECORD_KEYS].map(([text, names]) => ["kinds", names, text]),
].map(([c, n, t]) => `${c}\t${[...n].sort().join(",")}\t${t}`).sort();

/** fill_of's body: [first line index, last line index] (0-based) of `fn fill_of(` .. the first line starting with `}`. */
export function bodyOf(lines) {
  const starts = lines.flatMap((l, i) => (l.startsWith("fn fill_of(") ? [i] : []));
  assert.equal(starts.length, 1, `${FILE} must define fn fill_of exactly once at the line start (found ${starts.length})`);
  let end = starts[0];
  while (end < lines.length && !lines[end].startsWith("}")) end += 1;
  assert.ok(end < lines.length, "fill_of has no closing line");
  return [starts[0], end];
}

const PART_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
const KEY_RE = /"((?:[^"\\]|\\.)*)"/g;
/** (a): the key literals of a line naming a kind as a run of their parts (any registry name), as normalized names. */
export function keyKinds(line, kinds) {
  const found = new Set();
  for (const m of line.matchAll(KEY_RE)) {
    if (!/^[A-Za-z0-9_.]+$/.test(m[1])) continue;
    const parts = m[1].split(/[_.]/).flatMap((w) => w.match(PART_RE) ?? []).map((w) => w.toLowerCase());
    for (let i = 0; i < parts.length; i++) {
      let joined = "";
      for (let j = i; j < parts.length; j++) { joined += parts[j]; if (kinds.has(joined)) found.add(joined); }
    }
  }
  return found;
}

const BRANCH_RES = [
  [/\brecipe\.name\b/, "reads recipe.name"],
  [/[!=]=\s*"/, "compares with a string literal"],
  [/"\s*[!=]=/, "compares a string literal"],
  [/"[^"]*"\s*(?:\|\s*"[^"]*"\s*)*=>/, "matches on a string literal"],
  [/\.contains\(\s*&?\s*"/, "looks for a string literal"],
];

/** The three rules over a whole file's text: { a: [...], b: [...], c: {missing, extra} }, each problem naming its line. */
export function lockProblems(text, kinds) {
  const lines = text.split("\n");
  const [s, e] = bodyOf(lines);
  const a = [], b = [];
  for (let i = s; i <= e; i++) {
    const t = lines[i].trim();
    if (t.startsWith("//")) continue;
    const code = lines[i].replace(/\s\/\/\s.*$/, "");
    const named = [...keyKinds(code, kinds)];
    const allowed = RECORD_KEYS.get(t) ?? [];
    const off = named.filter((k) => !allowed.includes(k));
    if (off.length) a.push(`line ${i + 1} names ${off.join(", ")}: ${t}`);
    for (const [re, why] of BRANCH_RES) if (re.test(code)) b.push(`line ${i + 1} ${why}: ${t}`);
  }
  const got = scanText(FILE, text, kinds);
  const hits = COUNTS.flatMap((c) => got[c].filter((h) => h.line >= s + 1 && h.line <= e + 1).map((h) => `${c}\t${[...(h.names ?? [])].sort().join(",")}\t${h.text}`)).sort();
  const left = [...hits];
  const missing = [];
  for (const want of RATCHET_HITS) { const at = left.indexOf(want); if (at < 0) missing.push(want); else left.splice(at, 1); }
  return { a, b, c: { missing, extra: left } };
}

const clean = (p) => p.a.length === 0 && p.b.length === 0 && p.c.missing.length === 0 && p.c.extra.length === 0;

// ---- the kinds: the flow ratchet's own set (the registries, plus the baseline's stored names)
const kinds = new Set(registryKinds(read, list).keys());
const baseline = JSON.parse(read("scripts/fixtures/flow-ratchet.json") ?? "{}");
for (const n of Object.keys(baseline.kind_names ?? {})) kinds.add(normKind(n));
assert.ok(["sankey", "bars", "composition", "stacked100", "ring"].every((k) => kinds.has(k)), "the kind set holds the registry names");

// ---- self-tests: each rule fails on a mutant of the real file
const text = read(FILE);
const lines = text.split("\n");
const [s, e] = bodyOf(lines);
let checks = 0;
const mutant = (what, edit) => { const m = [...lines]; edit(m); return lockProblems(m.join("\n"), kinds); };
const insert = (line) => (m) => m.splice(e, 0, `    ${line}`);
const red = (what, p, rule) => {
  const bad = rule === "c" ? p.c.missing.length + p.c.extra.length : p[rule].length;
  assert.ok(bad > 0, `${what} must fail rule (${rule}): ${JSON.stringify(p)}`);
  checks += 1;
};
red("a chart kind as a key", mutant("a", insert('out.data.insert("sankey".into(), json!(1));')), "a");
red("a kind inside a key", mutant("a", insert('let k = "stacked100_left";')), "a");
red("an ordinary kind word as a key", mutant("a", insert('let k = "strip";')), "a");
red("a listed name on another line", mutant("a", insert('fill["bars"] = json!(1);')), "a");
red("recipe.name read", mutant("b", insert('if recipe.name.is_empty() { return Err(no(String::new())); }')), "b");
red("a layer compared with a literal", mutant("b", insert('if layer == "bubbles" {}')), "b");
red("a literal compared with a name", mutant("b", insert('let x = "change" != shape.place;')), "b");
red("a match arm on a literal", mutant("b", insert('match shape.place.as_str() { "geo" | "partner" => {} _ => {} }')), "b");
red("a literal looked for", mutant("b", insert('let x = recipe.layers.contains(&"map".to_string());')), "b");
red("a ratchet kinds hit more", mutant("c", insert('let k = "sankey";')), "c");
red("a ratchet copy hit more", mutant("c", insert('let k = "单位";')), "c");
red("a ratchet op hit more", mutant("c", insert('let k = json!({"op": "minus"});')), "c");
red("a listed line gone", mutant("c", (m) => { const at = m.findIndex((l, i) => i >= s && l.trim() === "if let (Some(comp), Some(cut)) = (&shape.composition, cut) {"); m[at] = m[at].replace("shape.composition", "shape.relation"); }), "c");
red("a node line more", mutant("c", insert("fn rows_fill() {}")), "c");
// the comments in the body are skipped, and so are the lines after it
assert.ok(clean(mutant("comment", insert('// "sankey" == layer'))), "a comment line is no case"); checks += 1;
assert.ok(clean(mutant("after", (m) => m.splice(e + 1, 0, 'fn other() { let k = "sankey"; }'))), "a line after the body is no case"); checks += 1;

// ---- the lock over the file as it is
const now = lockProblems(text, kinds);
if (!clean(now)) {
  for (const x of now.a) console.error(`(a) ${x}`);
  for (const x of now.b) console.error(`(b) ${x}`);
  for (const x of now.c.missing) console.error(`(c) a listed ratchet hit is gone: ${x.replace(/\t/g, " | ")}`);
  for (const x of now.c.extra) console.error(`(c) a ratchet hit not listed: ${x.replace(/\t/g, " | ")}`);
  console.error(`fill_of lock FAIL (${FILE} lines ${s + 1}-${e + 1})`);
  process.exit(1);
}
console.log(`fill_of lock ok (${checks} self-checks): lines ${s + 1}-${e + 1}, ${RATCHET_HITS.length} ratchet hits as listed, ${RECORD_KEYS.size} record-key lines`);
