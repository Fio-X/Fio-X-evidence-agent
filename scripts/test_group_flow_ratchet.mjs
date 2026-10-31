#!/usr/bin/env node
// Flow ratchet: a static count of the page-building knowledge that sits in the flow group's (agent) files. That knowledge is
// moving out into generic nodes and page specs; this test keeps it from coming back. It only reads source and changes no run.
//
// Which files: every runtime/pi/groups.json "files" entry with group=agent (a flow file added later is scanned with no edit
// here). Route: src/next_*.rs and runtime/pi/assets/* are the new route, every other agent file the old route; each route
// has its own row. A .rs file is read only up to its first line that starts with `#[cfg(test)]` or `mod tests`; other
// files are read whole. Comment lines (trimmed start `//`, `*`, `/*`) are skipped, and a trailing ` // ...` is cut when the
// line has no `"...//` in it. Data files (not .rs/.ts/.mjs/.js) count only toward copy.
// The four counts (matching lines, fixed rules; kinds over-counts ordinary words, only its trend matters):
//   nodes  each ("name", fn) entry of a NODE_FILLS table, plus each fn/function definition named *_fill or fill_of
//   ops    each line with a `"op":` declaration (also `\"op\":` inside a string)
//   copy   each code line with CJK text and a quote (`"`; in .ts/.mjs/.js also ' or `), each CJK line of a data file, and
//          each CJK line of a word file: a non-code file that a .rs agent file pulls in with include_str! (before its test
//          cut) and that groups.json gives to no group (one owned by agent is scanned as itself; one owned by another group
//          is that group's knowledge). Its lines count toward the including file and its route.
//   kinds  each line naming a chart kind. The names are read at test time from the registries (registryKinds below: the
//          node, group and recipe names in runtime/leaves_py/knobs.json, the piece files of runtime/leaves_py (*.py),
//          runtime/leaves_js (*.cjs) and runtime/nodes (*.mjs), run.py MAIN, every *_TEMPLATES list and NODE_FILLS name in
//          src/next_*.rs, shape_registry.rs Relation variants and templates) plus the word list P0a measured with
//          (P0A_KINDS). A name matches any spelling: every identifier on the line (strings included) is split at `_`,
//          case changes and digits, and a run of its parts joined in lower case that equals the name joined in lower case
//          counts (choropleth, Sankey, Kind::Sankey, StackedBar100, stacked_bar_100, rankbar, sankey_fill). Ordinary
//          words among the names (line, map, text, ...) over-count; the rule is fixed and only the trend matters.
//          The baseline records its name set: counting uses that set, a registry name it lacks is red until --lower admits it
//          (a reviewed baseline edit), and a name never leaves the set.
//
// The ratchet (scripts/fixtures/flow-ratchet.json holds the 8 totals, 4 counts x 2 routes, and the per-file counts):
//   - a total above its baseline is red, naming the files that went up and the hit lines they do not have at git HEAD;
//   - a total below its baseline is red too, "lower the baseline to N", so the ratchet stays tight; `--lower` rewrites the
//     baseline file with the current counts, and refuses while any total is above its baseline. A total never goes up by
//     hand edit without review.
// Self-tests run first: rule samples, a new-route file copy with one extra chart-kind line (kinds goes up, red), a word file
// copy with one extra CJK line (copy goes up, red), and a groups.json copy with one more agent file (scanned, red).
// Flags: --print (per-file counts), --at <sha> (measure a commit through git show, no baseline compare), --lower.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO, "scripts/fixtures/flow-ratchet.json");
export const COUNTS = ["nodes", "ops", "copy", "kinds"];
export const ROUTES = ["new", "old"];

export const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
// The P0a keyword set, kept so no name measured then leaves the count (treemap and dotgrid are in no registry yet).
const P0A_KINDS = ["composition", "stacked100", "bubble", "bubbles", "sankey", "heatmap", "change_bars", "bars", "ring", "column", "treemap", "dotgrid", "map", "flow", "change"];
export const normKind = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
const PART_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
/** The kind names a code line names (normalized), any spelling. kinds: Set of normalized names. */
export function kindsIn(code, kinds) {
  const found = new Set();
  for (const token of code.match(/[A-Za-z0-9_]+/g) ?? []) {
    const parts = token.split("_").flatMap((w) => w.match(PART_RE) ?? []).map((w) => w.toLowerCase());
    for (let i = 0; i < parts.length; i++) {
      let joined = "";
      for (let j = i; j < parts.length; j++) { joined += parts[j]; if (kinds.has(joined)) found.add(joined); }
    }
  }
  return found;
}
/** The registered kind names: Map(normalized name -> where it was read). read(path) -> text|null; list(dir) -> file names. */
export function registryKinds(read, list) {
  const out = new Map();
  const add = (name, from) => { const k = normKind(name); if (k.length >= 2 && !/^[0-9]+$/.test(k) && !out.has(k)) out.set(k, from); };
  const knobs = read("runtime/leaves_py/knobs.json");
  assert.ok(knobs, "runtime/leaves_py/knobs.json is the node registry and must be read");
  const kj = JSON.parse(knobs);
  for (const part of ["nodes", "groups", "legacy"]) for (const k of Object.keys(kj[part] ?? {})) add(k, `knobs.json ${part}`);
  for (const r of kj.recipes ?? []) { add(r.name, "knobs.json recipes"); for (const l of r.layers ?? []) add(l, "knobs.json recipes"); }
  for (const [dir, ext] of [["runtime/leaves_py", ".py"], ["runtime/leaves_js", ".cjs"], ["runtime/nodes", ".mjs"]]) for (const f of list(dir)) if (f.endsWith(ext)) add(f.slice(0, -ext.length), `${dir} file`);
  const main = /^MAIN\s*=\s*dict\(([^)]*)\)/m.exec(read("runtime/leaves_py/run.py") ?? "");
  assert.ok(main, "run.py MAIN (the column recipes' main nodes) must be read");
  for (const m of main[1].matchAll(/(\w+)\s*=\s*"(\w+)"/g)) { add(m[1], "run.py MAIN"); add(m[2], "run.py MAIN"); }
  for (const f of list("src")) {
    if (!/^next_\w*\.rs$/.test(f)) continue;
    const text = read(`src/${f}`) ?? "";
    for (const m of text.matchAll(/const\s+\w*TEMPLATES\s*:[^=]*=\s*&?\[([^\]]*)\]/g)) for (const q of m[1].matchAll(/"([^"]+)"/g)) add(q[1], `src/${f} templates`);
    const fills = /\bNODE_FILLS\b[^=]*=\s*&?\[([\s\S]*?)\];/.exec(text);
    if (fills) for (const q of fills[1].matchAll(/\(\s*"([^"]+)"\s*,/g)) add(q[1], `src/${f} NODE_FILLS`);
  }
  const shapes = read("src/shape_registry.rs");
  assert.ok(shapes, "src/shape_registry.rs (relations and their templates) must be read");
  const rel = /pub enum Relation\s*\{([^}]*)\}/.exec(shapes);
  assert.ok(rel, "shape_registry.rs enum Relation must be read");
  for (const v of rel[1].matchAll(/^\s*([A-Z]\w*)\s*,?\s*$/gm)) add(v[1], "shape_registry.rs Relation");
  for (const q of shapes.matchAll(/\(Relation::\w+,[^)]*\)\s*=>\s*"([^"]+)"/g)) add(q[1], "shape_registry.rs template");
  for (const k of P0A_KINDS) add(k, "P0a word list");
  return out;
}
const OP_RE = /\\?"op\\?"\s*:/;
const FILL_FN_RE = /^\s*(?:export\s+)?(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?(?:fn|function)\s+(?:\w*_fill|fill_of)\b/;
const NODE_FILLS_DEF_RE = /\bNODE_FILLS\b[^=]*=\s*&?\[/;
const NODE_ENTRY_RE = /\(\s*"[^"]*"\s*,/g;
const INCLUDE_RE = /include_str!\(\s*"([^"]+)"\s*\)/g;
const TEST_CUT_RE = /^(?:#\[cfg\(test\)\]|mod tests)/;
const CODE_EXT = /\.(?:rs|ts|mjs|js|cjs)$/;
const JS_EXT = /\.(?:ts|mjs|js)$/;

export const routeOf = (path) => (/^src\/next_[^/]*\.rs$/.test(path) || path.startsWith("runtime/pi/assets/") ? "new" : "old");
export function ownerOf(groups, path) {
  const row = groups.files?.[path];
  if (row) return row.group ?? null;
  for (const r of groups.file_rules ?? []) if ((!r.prefix || path.startsWith(r.prefix)) && (!r.suffix || path.endsWith(r.suffix)) && (r.prefix || r.suffix)) return r.group;
  return null;
}
export const flowFiles = (groups) => Object.entries(groups.files ?? {}).filter(([, v]) => v?.group === "agent").map(([k]) => k).sort();

/** The line index where counting stops: the first test line of a .rs file, else the end. */
export function cutAt(path, lines) {
  if (path.endsWith(".rs")) for (let i = 0; i < lines.length; i++) if (TEST_CUT_RE.test(lines[i])) return i;
  return lines.length;
}

/** One file's hits: { nodes, ops, copy, kinds, includes } with hits as { at, line, text } (kinds hits also carry names). */
export function scanText(path, text, kinds) {
  const lines = text.split("\n");
  const n = cutAt(path, lines);
  const isData = !/\.(?:rs|ts|mjs|js)$/.test(path);
  const isJs = JS_EXT.test(path);
  const out = { nodes: [], ops: [], copy: [], kinds: [], includes: [] };
  const hit = (k, i) => out[k].push({ at: path, line: i + 1, text: lines[i].trim() });
  let inFills = false;
  for (let i = 0; i < n; i++) {
    const L = lines[i];
    if (isData) { if (CJK_RE.test(L)) hit("copy", i); continue; }
    const s = L.trim();
    if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) continue;
    const code = /"[^"]*\/\//.test(L) ? L : L.replace(/\s\/\/\s.*$/, "");
    const named = kindsIn(code, kinds);
    if (named.size) { hit("kinds", i); out.kinds.at(-1).names = [...named]; }
    if (OP_RE.test(code)) hit("ops", i);
    if (CJK_RE.test(code) && (code.includes('"') || (isJs && (code.includes("'") || code.includes("`"))))) hit("copy", i);
    if (FILL_FN_RE.test(L)) hit("nodes", i);
    let rest = code;
    if (!inFills) { const m = NODE_FILLS_DEF_RE.exec(code); if (m) { inFills = true; rest = code.slice(m.index + m[0].length); } else rest = null; }
    if (inFills && rest !== null) {
      const end = rest.indexOf("]");
      for (const _ of (end >= 0 ? rest.slice(0, end) : rest).matchAll(NODE_ENTRY_RE)) hit("nodes", i);
      if (end >= 0) inFills = false;
    }
    if (path.endsWith(".rs")) for (const m of code.matchAll(INCLUDE_RE)) out.includes.push({ line: i + 1, target: normalize(join(dirname(path), m[1])).replace(/\\/g, "/") });
  }
  return out;
}

/** Measure every agent file. read(path) -> text or null. Returns totals per route, per-file counts and every hit. */
export function measure(groups, read, kinds) {
  const files = flowFiles(groups);
  const totals = Object.fromEntries(ROUTES.map((r) => [r, Object.fromEntries(COUNTS.map((c) => [c, 0]))]));
  const scanned = { new: 0, old: 0 };
  const perFile = {};
  const hits = {};
  const missing = [];
  const words = [];
  for (const f of files) {
    const text = read(f);
    if (text === null) { missing.push(f); continue; }
    const route = routeOf(f);
    scanned[route] += 1;
    const got = scanText(f, text, kinds);
    for (const inc of got.includes) {
      if (CODE_EXT.test(inc.target) || ownerOf(groups, inc.target) !== null) continue;
      const wt = read(inc.target);
      if (wt === null) { missing.push(`${inc.target} (include_str in ${f}:${inc.line})`); continue; }
      words.push({ includer: f, target: inc.target });
      const lines = wt.split("\n");
      lines.forEach((L, i) => { if (CJK_RE.test(L)) got.copy.push({ at: inc.target, line: i + 1, text: L.trim() }); });
    }
    hits[f] = got;
    for (const c of COUNTS) {
      totals[route][c] += got[c].length;
      if (got[c].length) (perFile[f] ??= {})[c] = got[c].length;
    }
  }
  return { files: files.length, scanned, totals, perFile, hits, missing, words, kinds };
}

/** Totals against a baseline: rises (red, the files and new lines) and drops (red, lower the baseline). */
export function compare(now, baseline, refHits) {
  const rises = [], drops = [];
  for (const r of ROUTES) for (const c of COUNTS) {
    const have = now.totals[r][c], was = baseline.totals?.[r]?.[c];
    assert.ok(Number.isInteger(was), `baseline totals.${r}.${c} missing`);
    if (have > was) {
      const where = [];
      for (const [f, got] of Object.entries(now.hits)) {
        if (routeOf(f) !== r) continue;
        const before = baseline.per_file?.[f]?.[c] ?? 0;
        if (got[c].length <= before) continue;
        const old = new Map();
        for (const h of refHits(f)?.[c] ?? []) old.set(`${h.at}\u0000${h.text}`, (old.get(`${h.at}\u0000${h.text}`) ?? 0) + 1);
        const fresh = got[c].filter((h) => { const k = `${h.at}\u0000${h.text}`; const left = old.get(k) ?? 0; if (left) { old.set(k, left - 1); return false; } return true; });
        where.push({ file: f, was: before, now: got[c].length, lines: (fresh.length ? fresh : got[c]).slice(0, 8) });
      }
      rises.push({ route: r, count: c, was, now: have, where });
    } else if (have < was) drops.push({ route: r, count: c, was, now: have });
  }
  return { rises, drops };
}

export function describe({ rises, drops }) {
  const out = [];
  for (const x of rises) {
    out.push(`UP ${x.route} ${x.count}: ${x.was} -> ${x.now} (only down is allowed; move the knowledge into a node or page spec)`);
    for (const w of x.where) {
      out.push(`  ${w.file}: ${w.was} -> ${w.now}`);
      for (const h of w.lines) out.push(`    ${h.at}:${h.line}: ${h.text.slice(0, 140)}`);
    }
  }
  for (const x of drops) out.push(`DOWN ${x.route} ${x.count}: ${x.was} -> ${x.now}: lower the baseline to ${x.now} (node scripts/test_group_flow_ratchet.mjs --lower)`);
  return out.join("\n");
}

const baselineOf = (m, at, names) => ({
  measured_at: at,
  rules: "scripts/test_group_flow_ratchet.mjs header; totals and per_file may only go down; kind_names only grow, by --lower",
  totals: m.totals,
  scanned: m.scanned,
  kind_names: Object.fromEntries([...names].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  per_file: Object.fromEntries(Object.keys(m.perFile).sort().map((f) => [f, m.perFile[f]])),
});
/** Per name: the lines it matches and the lines only it matches (what dropping it would take off). */
export function kindShares(m) {
  const all = new Map(), only = new Map();
  for (const got of Object.values(m.hits)) for (const h of got.kinds) { for (const n of h.names) all.set(n, (all.get(n) ?? 0) + 1); if (h.names.length === 1) only.set(h.names[0], (only.get(h.names[0]) ?? 0) + 1); }
  return [...all.keys()].sort((a, b) => all.get(b) - all.get(a)).map((n) => ({ name: n, lines: all.get(n), only: only.get(n) ?? 0 }));
}
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const diskRead = (p) => { const f = join(REPO, p); return existsSync(f) ? readFileSync(f, "utf8") : null; };
const diskList = (d) => { const f = join(REPO, d); return existsSync(f) ? readdirSync(f) : []; };
const refRead = (sha) => (p) => { try { return git("show", `${sha}:${p}`); } catch { return null; } };
const refList = (sha) => (d) => { try { return git("ls-tree", "--name-only", `${sha}:${d}`).split("\n").filter(Boolean); } catch { return []; } };
const refHitsAt = (sha, groups, kinds) => { let m = null; return (f) => { m ??= measure(groups, refRead(sha), kinds); return m.hits[f]; }; };
const argAfter = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : null; };

// ---- self-tests ----------------------------------------------------------------------------------------------------------------------------
let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };
const SAMPLE_KINDS = new Set(["sankey", "bars", "ring", "map", "horizontal_bar", "stacked_bar_100", "rankbar"].map(normKind));
const counts = (path, text) => { const g = scanText(path, text, SAMPLE_KINDS); return Object.fromEntries(COUNTS.map((c) => [c, g[c].length])); };
eq(counts("src/next_x.rs", 'let k = "sankey";\n// let k = "bars";\nlet t = "\u4e2d\u6587";\nlet o = json!({"op": "fill"});\n#[cfg(test)]\nlet k = "ring";\n'), { nodes: 0, ops: 1, copy: 1, kinds: 1 }, "rs sample: comment skipped, cut at the test line");
eq(counts("src/next_x.rs", 'const NODE_FILLS: &[(&str, F)] = &[\n    ("map", map_fill),\n    ("ring", ring_fill),\n];\nfn map_fill() {}\npub(crate) fn fill_of() {}\n'), { nodes: 4, ops: 0, copy: 0, kinds: 3 }, "NODE_FILLS entries and fill fns");
eq(counts("src/next_x.rs", 'const NODE_FILLS: &[(&str, F)] = &[("map", map_fill), ("bars", bars_fill)];\nlet x = ("no", 1);\n'), { nodes: 2, ops: 0, copy: 0, kinds: 1 }, "a one-line NODE_FILLS table; a tuple after it is no entry");
eq(counts("runtime/pi/x.mjs", "const t = '\u4e2d\u6587'; // ok\nconst u = x; // \u4e2d\u6587 note\n"), { nodes: 0, ops: 0, copy: 1, kinds: 0 }, "js quote kinds; CJK only in a trailing comment is no copy");
eq(counts("runtime/pi/assets/x.tsv", "a\t\u4e2d\nb\tbars\n"), { nodes: 0, ops: 0, copy: 1, kinds: 0 }, "a data file counts copy only");
for (const [code, want] of [["Kind::Sankey", ["sankey"]], ["SANKEY_FILL", ["sankey"]], ["StackedBar100", ["stackedbar100"]], ["HorizontalBar", ["horizontalbar"]], ["rank_bar", ["rankbar"]], ['"rankbar"', ["rankbar"]], ["to_string", []], ["mapped", []], ["barsX", ["bars"]], ["sankeys", []]])
  eq([...kindsIn(code, SAMPLE_KINDS)], want, `kind spelling ${code}`);

const groups = JSON.parse(diskRead("runtime/pi/groups.json"));
// a missing baseline is red; only --lower writes the first one
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
assert.ok(baseline || process.argv.includes("--lower"), `no baseline at ${BASELINE_PATH.slice(REPO.length + 1)}`);
const registry = registryKinds(diskRead, diskList);
for (const n of ["choropleth", "rankbar", "sankey", "cards", "horizontalbar", "line"]) assert.ok(registry.has(n), `registries name ${n}`);
checks += 1;
const baseNames = new Map(Object.entries(baseline?.kind_names ?? {}));
const newNames = [...registry].filter(([n]) => !baseNames.has(n));
const countNames = baseline ? baseNames : registry;
const disk = measure(groups, diskRead, new Set(countNames.keys()));
eq(disk.missing, [], "every agent file and word file groups.json and include_str name exists");
assert.ok(disk.files > 0 && disk.scanned.new > 0 && disk.scanned.old > 0, `scanned files: ${JSON.stringify(disk.scanned)} (each route must be > 0)`);
checks += 1;
assert.ok(disk.words.length > 0, "at least one include_str word file is scanned");
checks += 1;
const selfBase = baselineOf(disk, "disk", countNames);
const diskHits = (f) => disk.hits[f];
const overlay = (over) => (p) => (p in over ? over[p] : diskRead(p));

const cmp2str = (c) => c.rises.map((x) => `${x.route}/${x.count}`).join(",");
// mutant 1: a copy of a new-route file with one extra line naming a chart kind (placed before its test cut)
{
  const f = flowFiles(groups).find((p) => routeOf(p) === "new" && p.endsWith(".rs"));
  const text = diskRead(f);
  const extra = '    let kind = "treemap";';
  const m = measure(groups, overlay({ [f]: `${extra}\n${text}` }), disk.kinds);
  eq(m.totals.new.kinds, disk.totals.new.kinds + 1, `mutant 1: ${f} with one chart-kind line: kinds goes up by 1`);
  const cmp = compare(m, selfBase, diskHits);
  eq(cmp2str(cmp), "new/kinds", "mutant 1 is red on new kinds only");
  eq(cmp.rises[0].where.map((w) => [w.file, w.lines.map((h) => `${h.at}:${h.line}:${h.text}`)]), [[f, [`${f}:1:${extra.trim()}`]]], "mutant 1 names the file and the line");
  assert.match(describe(cmp), /UP new kinds/);
  // the same line after the test cut does not count
  const after = measure(groups, overlay({ [f]: `${text}\n#[cfg(test)]\n${extra}\n` }), disk.kinds);
  eq(after.totals.new.kinds, disk.totals.new.kinds, "mutant 1b: the same line inside the test part is not counted");
  // mutant 1c: the registry names in other spellings, each one line, each red
  for (const spelled of ['    let t = "choropleth";', '    let p = "rankbar";', '    let k = "Sankey";', "    Kind::Sankey => {}"]) {
    const m2 = measure(groups, overlay({ [f]: `${spelled}\n${text}` }), new Set(registry.keys()));
    const self2 = baselineOf(measure(groups, diskRead, new Set(registry.keys())), "disk", registry);
    const c2 = compare(m2, self2, (p) => self2 && measure(groups, diskRead, new Set(registry.keys())).hits[p]);
    eq([cmp2str(c2), c2.rises[0]?.where[0]?.lines.map((h) => h.text)], ["new/kinds", [spelled.trim()]], `mutant 1c: ${spelled.trim()} is red on new kinds`);
  }
}
// mutant 2: a word file pulled in with include_str gains one CJK line
{
  const w = disk.words.find((x) => routeOf(x.includer) === "new") ?? disk.words[0];
  const route = routeOf(w.includer);
  const extra = '  "added": "\u65b0\u589e\u6587\u6848",';
  const text = diskRead(w.target);
  const m = measure(groups, overlay({ [w.target]: text.replace("\n", `\n${extra}\n`) }));
  eq(m.totals[route].copy, disk.totals[route].copy + 1, `mutant 2: ${w.target} (read by ${w.includer}) with one CJK line: copy goes up by 1`);
  const cmp = compare(m, selfBase, diskHits);
  eq(cmp.rises.map((x) => `${x.route}/${x.count}`), [`${route}/copy`], "mutant 2 is red on copy only");
  eq(cmp.rises[0].where.map((w2) => [w2.file, w2.lines.map((h) => `${h.at}:${h.line}`)]), [[w.includer, [`${w.target}:2`]]], "mutant 2 names the includer and the word file line");
}
// mutant 4: a registry gains a name the baseline lacks: red until --lower admits it
{
  const kj = JSON.parse(diskRead("runtime/leaves_py/knobs.json"));
  kj.nodes.waffle_probe = {};
  const reg2 = registryKinds(overlay({ "runtime/leaves_py/knobs.json": JSON.stringify(kj) }), diskList);
  eq([...reg2.keys()].filter((n) => !registry.has(n)), ["waffleprobe"], "mutant 4: a new node name in knobs.json is a new kind name");
}
// mutant 3: a flow file added to groups.json is scanned with no edit here
{
  const g2 = structuredClone(groups);
  g2.files["src/next_ratchet_probe.rs"] = { group: "agent" };
  const m = measure(g2, overlay({ "src/next_ratchet_probe.rs": 'fn x() { json!({"op": "probe"}); }\n' }), disk.kinds);
  eq([m.scanned.new, m.totals.new.ops], [disk.scanned.new + 1, disk.totals.new.ops + 1], "mutant 3: a new agent file is picked up from groups.json");
  eq(compare(m, selfBase, diskHits).rises.map((x) => `${x.route}/${x.count}`), ["new/ops"], "mutant 3 is red on new ops");
  eq(compare(measure(groups, overlay({ [Object.keys(disk.perFile)[0]]: "" }), disk.kinds), selfBase, diskHits).drops.length > 0, true, "an emptied file drops a count: red, lower the baseline");
}

// ---- the ratchet -----------------------------------------------------------------------------------------------------------------------------
const row = (m) => ROUTES.map((r) => `${r} (${m.scanned[r]} files) ${COUNTS.map((c) => `${c} ${m.totals[r][c]}`).join(" ")}`).join(" | ");
const at = argAfter("--at");
if (at) {
  assert.match(at, /^[0-9a-f]{40}$/, "--at takes a 40-hex sha");
  const g = JSON.parse(refRead(at)("runtime/pi/groups.json"));
  const names = registryKinds(refRead(at), refList(at));
  for (const [n, from] of baseNames) if (!names.has(n)) names.set(n, from);
  const m = measure(g, refRead(at), new Set(names.keys()));
  console.log(`at ${at}: ${row(m)}${m.missing.length ? ` | missing ${m.missing.join(", ")}` : ""}`);
  console.log(`word files: ${m.words.map((w) => `${w.includer} <- ${w.target}`).join(", ")}`);
  if (process.argv.includes("--print")) { for (const [f, c] of Object.entries(m.perFile)) console.log(`  ${f} ${JSON.stringify(c)}`); console.log(`kind names (lines/only): ${kindShares(m).map((x) => `${x.name} ${x.lines}/${x.only}`).join(", ")}`); }
  process.exit(0);
}
if (process.argv.includes("--print")) { for (const [f, c] of Object.entries(disk.perFile)) console.log(`  ${f} ${JSON.stringify(c)}`); console.log(`kind names (lines/only): ${kindShares(disk).map((x) => `${x.name} ${x.lines}/${x.only}`).join(", ")}`); }
const cmp = baseline ? compare(disk, baseline, refHitsAt("HEAD", groups, disk.kinds)) : { rises: [], drops: [] };
const admitted = new Map([...countNames, ...newNames]);
if (process.argv.includes("--lower")) {
  if (cmp.rises.length) { console.error(describe(cmp)); console.error("--lower refused: a total is above its baseline"); process.exit(1); }
  let head = "unknown";
  try { head = git("rev-parse", "HEAD").trim(); } catch {}
  const m = newNames.length ? measure(groups, diskRead, new Set(admitted.keys())) : disk;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baselineOf(m, head, admitted), null, 2)}\n`);
  console.log(`baseline written: ${row(m)}${newNames.length ? ` (admitted kind names: ${newNames.map(([n, from]) => `${n} from ${from}`).join(", ")})` : ""}`);
  process.exit(0);
}
if (newNames.length) console.error(`NEW kind names in the registries, not in the baseline: ${newNames.map(([n, from]) => `${n} (${from})`).join(", ")}; admit them with --lower (a reviewed baseline edit)`);
if (cmp.rises.length || cmp.drops.length || newNames.length) {
  console.error(describe(cmp));
  console.error(`flow ratchet FAIL: ${row(disk)}`);
  process.exit(1);
}
console.log(`flow ratchet ok (${checks} self-checks): ${row(disk)}`);
