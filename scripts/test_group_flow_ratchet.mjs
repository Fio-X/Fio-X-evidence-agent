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
//   kinds  each line naming a chart kind. The names are read at test time from the registries (registryKinds below; a
//          registry file, table or listing that is missing or yields no name fails the test, except NODE_FILLS, which P6
//          emptied: absent it adds no name, a table that is there must yield names): the node, group and recipe
//          names (and recipe layers) of runtime/leaves_py/knobs.json, run.py MAIN and LEAF_LAYERS, every *_TEMPLATES list
//          and NODE_FILLS name in src/next_*.rs, the NodeInfo and GroupInfo names in src/next_render.rs, shape_registry.rs
//          Relation variants and their templates, the NODES keys of runtime/nodes/run.mjs when that folder is there (no commit
//          tracks it yet; base_map and flow_lines came in from it on 11-01 and stay in the stored set below), plus the word
//          list P0a measured with (P0A_KINDS). Names compare in lower
//          case with every non-alphanumeric dropped (Sankey = sankey, stacked_bar_100 = StackedBar100 = stackedbar100).
//          A line names a kind when (a) a string literal on it ("..", '..', `..`, or an escaped \"..\" inside one) is the
//          name, (b) an enum path segment `::Name` is the name (Kind::Sankey, Relation::Map), or (c) for every name not in
//          ORDINARY, a run of the parts of an identifier on it (strings included; split at `_`, case changes and digits)
//          joined is the name (choropleth, SANKEY_FILL, rank_bar, StackedBar100, CHOROPLETH_FILL). ORDINARY holds the
//          registry names that are everyday words of code (map, text, line, step, ...): they count by (a) and (b) only.
//          BTreeMap and BTreeSet are no identifier match. Other ordinary words still over-count; only the trend matters.
//          The baseline records its name set: counting uses that set, a registry name it lacks is red until --lower admits it
//          (a reviewed baseline edit that may raise kinds by the lines the new name matches), and a name never leaves the set.
//
// What the scan does NOT count (known limits, kept as plain rules rather than closed):
//   - any code line whose trimmed start is `//`, `*` or `/*`, so a code line that starts with `*` (a deref such as
//     `*slot = "sankey"`) is skipped as if it were a comment;
//   - everything in a .rs file from its first line starting `#[cfg(test)]` or `mod tests` on; past that line only test code
//     may follow (the test module, or items whose attribute lines carry #[cfg(test)]), any other item is red (pastCut:
//     items found by brace depth with strings and comments skipped, at any indentation; an inline attribute covers only its
//     own item; a mod tests without #[cfg(test)] is not test code);
//     every run prints, per file, the lines read of its total;
//   - the continuation lines of a multi-line string: copy needs CJK and a quote on the same line, so a CJK line inside a
//     multi-line string literal with no quote on it is not copy (word files and data files are counted line by line);
//   - text a `{}` format placeholder fills in at run time, and any knowledge reached through a function call or constant
//     defined outside the flow group;
//   - copy or kind names moved into another group's files (or an include_str file that groups.json gives to another
//     group): they leave this count, and the other group's own checks hold them;
//   - a kind name glued into one lower-case word with no separator (rankbars, sankeys, choroplethmap) and a kind no
//     registry or the P0a list names.
//
// The ratchet (scripts/fixtures/flow-ratchet.json holds the 8 totals, 4 counts x 2 routes, and the per-file counts):
//   - a total above its baseline is red, naming the files that went up and the hit lines they do not have at git HEAD;
//   - a total below its baseline is red too, "lower the baseline to N", so the ratchet stays tight; `--lower` rewrites the
//     baseline file with the current counts, and refuses while any total is above its baseline. A total never goes up by
//     hand edit without review.
// Self-tests run first: rule samples and kind spellings, every registry failing when it cannot be read, a new-route file copy
// with one extra chart-kind line in each of several spellings (kinds goes up, red), a word file copy with one extra CJK line
// (copy goes up, red), a knobs.json copy with one more node (a new name), and a groups.json copy with one more agent file.
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
// Registry names that are also everyday words of code or English (`.map(`, `text`, `line`, `step`, ...). Matched in any
// spelling inside an identifier they would count most lines, so they count only as a whole string literal ("map", "Map",
// "line") or an enum path segment (Relation::Map, Kind::Line). Every other name also counts as a run of identifier parts.
// The P0a words map, flow and change were counted this way then; the other P0a words keep the identifier match.
export const ORDINARY = new Set(["text", "map", "names", "line", "step", "hero", "flow", "flows", "base", "profile", "change", "notes", "charts", "labels", "strip", "events", "header", "highlight", "edge", "legend", "ledger", "frame", "inset", "prose", "timeline", "routes", "illus", "ranking", "distribution", "cities"]);
// Rust std type names whose parts spell a kind (BTreeMap is b+tree+map): never a chart kind, so no identifier match.
const STD_TYPES = new Set(["BTreeMap", "BTreeSet"]);
const PART_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
const LITERAL_RE = /\\"((?:[^"\\]|\\(?!"))*)\\"|"((?:[^"\\]|\\.)*)"|'([^'\\\n]*)'|`([^`]*)`/g;
/** The kind names a code line names (normalized), any spelling and case. kinds: Set of normalized names. */
export function kindsIn(code, kinds) {
  const found = new Set();
  const whole = (t) => { const k = normKind(t); if (kinds.has(k)) found.add(k); };
  for (const m of code.matchAll(LITERAL_RE)) {
    const body = m[1] ?? m[2] ?? m[3] ?? m[4];
    whole(body);
    for (const e of body.matchAll(/\\"([^"\\]*)\\"/g)) whole(e[1]);
  }
  for (const m of code.matchAll(/::([A-Z][A-Za-z0-9_]*)/g)) whole(m[1]);
  for (const token of code.match(/[A-Za-z0-9_]+/g) ?? []) {
    if (STD_TYPES.has(token)) continue;
    const parts = token.split("_").flatMap((w) => w.match(PART_RE) ?? []).map((w) => w.toLowerCase());
    for (let i = 0; i < parts.length; i++) {
      let joined = "";
      for (let j = i; j < parts.length; j++) { joined += parts[j]; if (kinds.has(joined) && !ORDINARY.has(joined)) found.add(joined); }
    }
  }
  return found;
}
/** The registered kind names: Map(normalized name -> where it was read). read(path) -> text|null; list(dir) -> names|null.
 * Every registry must be there and must yield names: a missing file, table or listing fails here, never an empty set. */
export function registryKinds(read, list) {
  const out = new Map();
  const add = (name, from) => { const k = normKind(name); if (k.length >= 2 && !/^[0-9]+$/.test(k) && !out.has(k)) out.set(k, from); };
  const need = (text, what) => { assert.ok(typeof text === "string" && text.length, `${what} is a kind registry and must be read`); return text; };
  const took = (n, what) => assert.ok(n > 0, `${what} must yield at least one kind name`);
  const kj = JSON.parse(need(read("runtime/leaves_py/knobs.json"), "runtime/leaves_py/knobs.json"));
  let n = 0;
  for (const part of ["nodes", "groups", "legacy"]) for (const k of Object.keys(kj[part] ?? {})) { add(k, `knobs.json ${part}`); n += 1; }
  for (const r of kj.recipes ?? []) { add(r.name, "knobs.json recipes"); n += 1; for (const l of r.layers ?? []) add(l, "knobs.json recipes"); }
  took(n, "knobs.json nodes, groups and recipes");
  const run = need(read("runtime/leaves_py/run.py"), "runtime/leaves_py/run.py");
  const main = /^MAIN\s*=\s*dict\(([^)]*)\)/m.exec(run);
  assert.ok(main, "run.py MAIN (the column recipes' main nodes) must be read");
  n = 0;
  for (const m of main[1].matchAll(/(\w+)\s*=\s*"(\w+)"/g)) { add(m[1], "run.py MAIN"); add(m[2], "run.py MAIN"); n += 1; }
  took(n, "run.py MAIN");
  const leaves = /^LEAF_LAYERS\s*=\s*dict\(([\s\S]*?)\)\)\s*$/m.exec(run);
  assert.ok(leaves, "run.py LEAF_LAYERS (the chart leaves a column page holds) must be read");
  n = 0;
  for (const m of `,${leaves[1]})`.matchAll(/(?:^|,)\s*(\w+)=/gm)) { add(m[1], "run.py LEAF_LAYERS"); n += 1; }
  took(n, "run.py LEAF_LAYERS");
  // runtime/nodes: the JS leaf nodes, the keys of run.mjs NODES (base_map, flow_lines, ...). The folder is not in every checkout
  // (no commit tracks it yet): when it is there, run.mjs and its NODES must yield names, as every other registry; when it is
  // not, its names still count through the baseline's stored set, which a name never leaves.
  if (list("runtime/nodes") !== null) {
    const nodes = /\bNODES\s*=\s*\{([^}]*)\}/.exec(need(read("runtime/nodes/run.mjs"), "runtime/nodes/run.mjs (runtime/nodes is there)"));
    assert.ok(nodes, "runtime/nodes/run.mjs NODES must be read");
    n = 0;
    for (const m of nodes[1].matchAll(/(?:^|,)\s*["']?(\w+)["']?\s*(?=[:,]|$)/g)) { add(m[1], "runtime/nodes run.mjs NODES"); n += 1; }
    took(n, "runtime/nodes run.mjs NODES");
  }
  const src = list("src");
  assert.ok(Array.isArray(src) && src.length, "src must be listed");
  let templates = 0, fillNames = 0;
  for (const f of src) {
    if (!/^next_\w*\.rs$/.test(f)) continue;
    const text = need(read(`src/${f}`), `src/${f}`);
    for (const m of text.matchAll(/const\s+\w*TEMPLATES\s*:[^=]*=\s*&?\[([^\]]*)\]/g)) for (const q of m[1].matchAll(/"([^"]+)"/g)) { add(q[1], `src/${f} templates`); templates += 1; }
    const fills = /\bNODE_FILLS\b[^=]*=\s*&?\[([\s\S]*?)\];/.exec(text);
    if (fills) for (const q of fills[1].matchAll(/\(\s*"([^"]+)"\s*,/g)) { add(q[1], `src/${f} NODE_FILLS`); fillNames += 1; }
  }
  took(templates, "the *_TEMPLATES lists of src/next_*.rs");
  // NODE_FILLS was emptied by P6 (every node fill moved to the visual group): its names ("map", ...) still count
  // through the baseline's stored set, which a name never leaves; a NODE_FILLS table that is there must yield names
  if (fillNames === 0) assert.ok(!src.some((f) => /^next_\w*\.rs$/.test(f) && NODE_FILLS_DEF_RE.test(read(`src/${f}`) ?? "")), "a NODE_FILLS table that is there must yield at least one kind name");
  const render = need(read("src/next_render.rs"), "src/next_render.rs");
  n = 0;
  for (const m of render.matchAll(/:\s*(NodeInfo|GroupInfo)\s*=\s*\1\s*\{\s*name:\s*"([^"]+)"/g)) { add(m[2], `next_render.rs ${m[1]}`); n += 1; }
  took(n, "next_render.rs NodeInfo and GroupInfo");
  const shapes = need(read("src/shape_registry.rs"), "src/shape_registry.rs");
  const rel = /pub enum Relation\s*\{([^}]*)\}/.exec(shapes);
  assert.ok(rel, "shape_registry.rs enum Relation must be read");
  n = 0;
  for (const v of rel[1].matchAll(/^\s*([A-Z]\w*)\s*,?\s*$/gm)) { add(v[1], "shape_registry.rs Relation"); n += 1; }
  took(n, "shape_registry.rs enum Relation");
  n = 0;
  for (const q of shapes.matchAll(/\(Relation::\w+,[^)]*\)\s*=>\s*"([^"]+)"/g)) { add(q[1], "shape_registry.rs template"); n += 1; }
  took(n, "shape_registry.rs relation templates");
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

/** Per line of Rust source, the depth of open (, [ and { at its start (one more entry for the end), with strings, raw
 *  strings, byte strings, char literals and comments skipped (a lone ' is a lifetime). */
export function depthsOf(lines) {
  const t = lines.join("\n"), n = t.length, depth = [0];
  let d = 0, i = 0;
  const nl = () => depth.push(d);
  const word = (k) => k >= 0 && /[A-Za-z0-9_]/.test(t[k]);
  while (i < n) {
    const c = t[i];
    if (c === "\n") { nl(); i += 1; continue; }
    if (c === "/" && t[i + 1] === "/") { while (i < n && t[i] !== "\n") i += 1; continue; }
    if (c === "/" && t[i + 1] === "*") {
      let open = 1; i += 2;
      while (i < n && open) { if (t[i] === "\n") nl(); if (t[i] === "/" && t[i + 1] === "*") { open += 1; i += 2; continue; } if (t[i] === "*" && t[i + 1] === "/") { open -= 1; i += 2; continue; } i += 1; }
      continue;
    }
    const raw = !word(i - 1) && /^b?r(#*)"/.exec(t.slice(i, i + 64));
    if (raw) {
      const close = `"${raw[1]}`;
      i += raw[0].length;
      while (i < n && t.slice(i, i + close.length) !== close) { if (t[i] === "\n") nl(); i += 1; }
      i += close.length;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && t[i] !== '"') { if (t[i] === "\\") { if (t[i + 1] === "\n") nl(); i += 2; continue; } if (t[i] === "\n") nl(); i += 1; }
      i += 1;
      continue;
    }
    if (c === "'") { const ch = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n])'/.exec(t.slice(i, i + 12)); i += ch ? ch[0].length : 1; continue; }
    if (c === "(" || c === "[" || c === "{") d += 1;
    else if (c === ")" || c === "]" || c === "}") d -= 1;
    i += 1;
  }
  return depth;
}

/** A line's leading attributes (`#[...]`, brackets matched) and the rest of it. */
export function splitAttrs(line) {
  const attrs = [];
  let rest = line.trim();
  while (rest.startsWith("#[")) {
    let open = 0, k = 1;
    for (; k < rest.length; k += 1) { if (rest[k] === "[") open += 1; else if (rest[k] === "]" && --open === 0) break; }
    if (k >= rest.length) break;
    attrs.push(rest.slice(0, k + 1));
    rest = rest.slice(k + 1).trim();
  }
  return { attrs, rest };
}

/** The first line past a .rs file's cut that is not test code, else -1. Past the cut, each item at depth 0 (depthsOf, at any
 *  indentation) must carry #[cfg(test)] among its attributes, on the lines above it or inline before it; a module named tests
 *  without it is code like any other. An item runs from its first line to the line that ends it at depth 0 (`;` or `}`);
 *  comments and blank lines between items are no item. */
export function pastCut(path, lines) {
  const cut = cutAt(path, lines);
  if (cut >= lines.length) return -1;
  const depth = depthsOf(lines);
  let attrs = [], open = false;
  const ends = (k) => depth[k + 1] === 0 && /[;}]$/.test(lines[k].replace(/\s\/\/\s.*$/, "").trim());
  for (let k = cut; k < lines.length; k += 1) {
    const l = lines[k].trim();
    if (open) { if (ends(k)) open = false; continue; }
    if (!l || l.startsWith("//")) continue;
    const { attrs: a, rest } = splitAttrs(l);
    attrs.push(...a);
    if (!rest) continue;
    const test = attrs.includes("#[cfg(test)]");
    attrs = [];
    if (!test) return k;
    open = !ends(k);
  }
  return -1;
}

/** One file's hits: { nodes, ops, copy, kinds, includes } with hits as { at, line, text } (kinds hits also carry names). */
export function scanText(path, text, kinds) {
  const lines = text.split("\n");
  const n = cutAt(path, lines);
  const past = pastCut(path, lines);
  const isData = !/\.(?:rs|ts|mjs|js)$/.test(path);
  const isJs = JS_EXT.test(path);
  const out = { nodes: [], ops: [], copy: [], kinds: [], includes: [], hidden: past < 0 ? null : { line: past + 1, cut: n + 1, text: lines[past].trim() }, read: n, total: lines.length };
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
  const hidden = [];
  const reads = {};
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
    reads[f] = { read: got.read, total: got.total };
    if (got.hidden) hidden.push(`${f}:${got.hidden.line} (cut at ${got.hidden.cut}): ${got.hidden.text}`);
    hits[f] = got;
    for (const c of COUNTS) {
      totals[route][c] += got[c].length;
      if (got[c].length) (perFile[f] ??= {})[c] = got[c].length;
    }
  }
  return { files: files.length, scanned, totals, perFile, hits, missing, words, kinds, hidden, reads };
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
const diskList = (d) => { const f = join(REPO, d); return existsSync(f) ? readdirSync(f) : null; };
const refRead = (sha) => (p) => { try { return git("show", `${sha}:${p}`); } catch { return null; } };
const refList = (sha) => (d) => { try { return git("ls-tree", "--name-only", `${sha}:${d}`).split("\n").filter(Boolean); } catch { return null; } };
const refHitsAt = (sha, groups, kinds) => { let m = null; return (f) => { m ??= measure(groups, refRead(sha), kinds); return m.hits[f]; }; };
// a runtime/nodes folder as the self-tests see it, whether or not this checkout has one
const NODES_LIST = (d) => (d === "runtime/nodes" ? ["run.mjs"] : diskList(d));
const NODES_RUN = 'import * as base_map from "./base_map.mjs";\nexport const NODES = { base_map, flow_lines, leader_notes, legend, "keyed_one": x };\n';
const argAfter = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : null; };

// ---- self-tests ----------------------------------------------------------------------------------------------------------------------------
let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };
const SAMPLE_KINDS = new Set(["sankey", "bars", "ring", "map", "horizontal_bar", "stacked_bar_100", "rankbar", "treemap"].map(normKind));
const counts = (path, text) => { const g = scanText(path, text, SAMPLE_KINDS); return Object.fromEntries(COUNTS.map((c) => [c, g[c].length])); };
eq(counts("src/next_x.rs", 'let k = "sankey";\n// let k = "bars";\nlet t = "\u4e2d\u6587";\nlet o = json!({"op": "fill"});\n#[cfg(test)]\nmod tests {\nlet k = "ring";\n}\n'), { nodes: 0, ops: 1, copy: 1, kinds: 1 }, "rs sample: comment skipped, cut at the test line");
// past the cut only test code: the test module, #[cfg(test)] items (a raw string's lines inside one are no item)
const pastOf = (text) => pastCut("src/next_x.rs", text.split("\n"));
eq(pastOf('fn a() {}\n#[cfg(test)]\nmod tests {\n    use super::*;\n}\n#[cfg(test)]\n/// doc\npub fn b() {\n    let s = r#"\n}\n"#;\n}\n'), -1, "past the cut: the test module and a test item only");
eq(pastOf('#[cfg(test)]\n#[derive(Debug)]\npub enum R {\n    A,\n}\n#[cfg(test)]\nuse x::Y;\n#[cfg(test)]\nmod tests {\n}\n'), -1, "past the cut: test items before the test module");
eq(pastOf('fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() {}\n}\nfn draw() {\n    let k = "ring";\n}\n'), 5, "must-fail: code after mod tests");
eq(pastOf('#[cfg(test)]\nuse crate::x::{A, B};\nfn fill_of() {\n    let k = "ring";\n}\n#[cfg(test)]\nmod tests {\n}\n'), 2, "must-fail: a stray #[cfg(test)] use line followed by code");
eq(pastOf('#[cfg(test)]\nmod tests {\n}\n// trailing note\n'), -1, "past the cut: comments are no item");
eq(pastOf('#[cfg(test)]\nmod tests {\n    fn f<\'a>(x: &\'a str) -> char {\n        let s = "}";\n        let r = r#"\n}\n"#;\n        \'{\'\n    }\n}\n#[cfg(test)]\npub fn g(\n    a: u8,\n) -> u8 {\n    a\n}\n'), -1, "past the cut: strings, raw strings, chars and lifetimes hold no brace; a signature over lines is one item");
eq(pastOf('#[cfg(test)]\nmod tests {\n}\n#[cfg(test)] const X: u8 = 1;\nfn hidden() {}\n'), 4, "must-fail: an inline #[cfg(test)] item covers only itself, not the code after it");
eq(pastOf('#[cfg(test)]\nmod tests {\n}\n    fn indented() {\n        let k = "ring";\n    }\n'), 3, "must-fail: indented code at the top level after the test module");
eq(pastOf('fn a() {}\nmod tests {\n    fn t() {}\n}\n'), 1, "must-fail: a mod tests without #[cfg(test)] is built and counted, not cut");
eq(depthsOf('const S: &str = "a {\\\nb";\nfn f() {}\n'.split("\n")), [0, 0, 0, 0], "a string continued over a line (backslash newline) keeps the line count and holds no brace");
eq(cutAt("src/next_x.rs", 'fn a() {\n    #[cfg(test)]\n    let k = "ring";\n}\nfn b() {}\n'.split("\n")), 6, "an indented #[cfg(test)] inside a non-test item is no cut");
eq(counts("src/next_x.rs", 'fn a() {\n    #[cfg(test)]\n    let k = "ring";\n}\nfn b() { let j = "sankey"; }\n'), { nodes: 0, ops: 0, copy: 0, kinds: 2 }, "the code after an indented #[cfg(test)] is counted");
assert.ok(scanText("src/next_x.rs", '#[cfg(test)]\nuse a::B;\nfn f() {}\n', SAMPLE_KINDS).hidden?.line === 3, "a hidden line is reported by scanText");
checks += 1;
// NODE_FILLS: a src listing with no table reads; one with an empty table throws
{
  const srcList = (d) => (d === "src" ? [...(diskList("src") ?? []), "next_nofills_probe.rs"] : diskList(d));
  const strip = (t) => (t ?? "").replace(/\bNODE_FILLS\b/g, "NODE_FILLX");
  const noTable = (p) => (/^src\/next_\w*\.rs$/.test(p) ? (p === "src/next_nofills_probe.rs" ? "fn x() {}\n" : strip(diskRead(p))) : diskRead(p));
  assert.doesNotThrow(() => registryKinds(noTable, srcList), "no NODE_FILLS table: reads");
  const emptyTable = (p) => (p === "src/next_nofills_probe.rs" ? "const NODE_FILLS: &[(&str, F)] = &[];\n" : noTable(p));
  assert.throws(() => registryKinds(emptyTable, srcList), assert.AssertionError, "an empty NODE_FILLS table must fail");
  checks += 2;
}
eq(counts("src/next_x.rs", 'const NODE_FILLS: &[(&str, F)] = &[\n    ("map", map_fill),\n    ("ring", ring_fill),\n];\nfn map_fill() {}\npub(crate) fn fill_of() {}\n'), { nodes: 4, ops: 0, copy: 0, kinds: 2 }, "NODE_FILLS entries and fill fns (map is an ordinary word: only its literal counts)");
eq(counts("src/next_x.rs", 'const NODE_FILLS: &[(&str, F)] = &[("map", map_fill), ("bars", bars_fill)];\nlet x = ("no", 1);\n'), { nodes: 2, ops: 0, copy: 0, kinds: 1 }, "a one-line NODE_FILLS table; a tuple after it is no entry");
eq(counts("runtime/pi/x.mjs", "const t = '\u4e2d\u6587'; // ok\nconst u = x; // \u4e2d\u6587 note\n"), { nodes: 0, ops: 0, copy: 1, kinds: 0 }, "js quote kinds; CJK only in a trailing comment is no copy");
eq(counts("runtime/pi/assets/x.tsv", "a\t\u4e2d\nb\tbars\n"), { nodes: 0, ops: 0, copy: 1, kinds: 0 }, "a data file counts copy only");
for (const [code, want] of [["Kind::Sankey", ["sankey"]], ["SANKEY_FILL", ["sankey"]], ["StackedBar100", ["stackedbar100"]], ["HorizontalBar", ["horizontalbar"]], ["rank_bar", ["rankbar"]], ['"rankbar"', ["rankbar"]], ["to_string", []], ["mapped", []], ["barsX", ["bars"]], ["sankeys", []], ["xs.iter().map(f)", []], ["let map = 1;", []], ['"Map"', ["map"]], ["Relation::Map", ["map"]], ['"{\\"kind\\": \\"SANKEY\\"}"', ["sankey"]], ["'stacked-bar-100'", ["stackedbar100"]], ["CHOROPLETH", []], ["BTreeMap<String, u32>", []]])
  eq([...kindsIn(code, SAMPLE_KINDS)], want, `kind spelling ${code}`);
eq([...kindsIn("CHOROPLETH_FILL; choroplethLayer", new Set(["choropleth"]))], ["choropleth"], "kind spelling: upper snake and camel parts");
eq(P0A_KINDS.map(normKind).filter((k) => ORDINARY.has(k)), ["map", "flow", "change"], "only the P0a words counted as literals then are ordinary now");

const groups = JSON.parse(diskRead("runtime/pi/groups.json"));
// a missing baseline is red; only --lower writes the first one
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
assert.ok(baseline || process.argv.includes("--lower"), `no baseline at ${BASELINE_PATH.slice(REPO.length + 1)}`);
const registry = registryKinds(diskRead, diskList);
for (const n of ["choropleth", "rankbar", "sankey", "stackedbar100", "horizontalbar", "line", "barcard", "dumbbell", "treemap"]) assert.ok(registry.has(n), `registries name ${n}`);
checks += 1;
// a registry that cannot be read fails; it never yields a smaller name set
for (const [what, over, list] of [
  ["knobs.json missing", { "runtime/leaves_py/knobs.json": null }, diskList],
  ["run.py missing", { "runtime/leaves_py/run.py": null }, diskList],
  ["run.py without MAIN", { "runtime/leaves_py/run.py": (diskRead("runtime/leaves_py/run.py") ?? "").replace(/^MAIN\s*=/m, "MAINX =") }, diskList],
  ["shape_registry.rs missing", { "src/shape_registry.rs": null }, diskList],
  ["next_render.rs missing", { "src/next_render.rs": null }, diskList],
  ["src not listed", {}, (d) => (d === "src" ? null : diskList(d))],
  ["runtime/nodes there without run.mjs", { "runtime/nodes/run.mjs": null }, NODES_LIST],
  ["runtime/nodes run.mjs without NODES", { "runtime/nodes/run.mjs": "export const DRAW = { base_map };\n" }, NODES_LIST],
  ["runtime/nodes run.mjs with empty NODES", { "runtime/nodes/run.mjs": "export const NODES = {};\n" }, NODES_LIST],
]) { assert.throws(() => registryKinds((p) => (p in over ? over[p] : diskRead(p)), list), assert.AssertionError, `registry ${what} must fail`); checks += 1; }
// runtime/nodes, when there, adds its NODES keys, and they count in any spelling (BASE_MAP, flow_lines, "leader_notes")
{
  const reg = registryKinds((p) => (p === "runtime/nodes/run.mjs" ? NODES_RUN : diskRead(p)), NODES_LIST);
  eq(["basemap", "flowlines", "leadernotes", "legend", "keyedone"].map((k) => [k, reg.has(k)]), [["basemap", true], ["flowlines", true], ["leadernotes", true], ["legend", true], ["keyedone", true]], "runtime/nodes NODES keys are kind names");
  eq([...kindsIn('let BASE_MAP = 1; flow_lines(x); f("leader_notes");', new Set(reg.keys()))].sort(), ["basemap", "flowlines", "leadernotes"], "runtime/nodes names count in any spelling");
}
const baseNames = new Map(Object.entries(baseline?.kind_names ?? {}));
const newNames = [...registry].filter(([n]) => !baseNames.has(n));
const countNames = baseline ? baseNames : registry;
const disk = measure(groups, diskRead, new Set(countNames.keys()));
eq(disk.missing, [], "every agent file and word file groups.json and include_str name exists");
// every run: what each file's scan read (a .rs file up to its test cut) of its lines; a non-test part not read in full is red
for (const [f, r] of Object.entries(disk.reads)) console.log(`read ${r.read} / total ${r.total} lines: ${f}${r.read < r.total ? " (the rest its tests)" : ""}`);
eq(disk.hidden, [], "past each .rs file's test cut only test code: a line there is not counted, so none may be non-test code");
assert.ok(disk.files > 0 && disk.scanned.new > 0 && disk.scanned.old > 0, `scanned files: ${JSON.stringify(disk.scanned)} (each route must be > 0)`);
checks += 1;
assert.ok(disk.words.length > 0, "at least one include_str word file is scanned");
checks += 1;
// The mutants count with every name the registries and the baseline hold, so they hold before a baseline has its names.
const selfNames = new Map([...registry, ...baseNames]);
const self = measure(groups, diskRead, new Set(selfNames.keys()));
const selfBase = baselineOf(self, "disk", selfNames);
const diskHits = (f) => self.hits[f];
const overlay = (over) => (p) => (p in over ? over[p] : diskRead(p));

const cmp2str = (c) => c.rises.map((x) => `${x.route}/${x.count}`).join(",");
// mutant 1: a copy of a new-route file with one extra line naming a chart kind (placed before its test cut)
{
  const f = flowFiles(groups).find((p) => routeOf(p) === "new" && p.endsWith(".rs"));
  const text = diskRead(f);
  const extra = '    let kind = "treemap";';
  const m = measure(groups, overlay({ [f]: `${extra}\n${text}` }), self.kinds);
  eq(m.totals.new.kinds, self.totals.new.kinds + 1, `mutant 1: ${f} with one chart-kind line: kinds goes up by 1`);
  const cmp = compare(m, selfBase, diskHits);
  eq(cmp2str(cmp), "new/kinds", "mutant 1 is red on new kinds only");
  eq(cmp.rises[0].where.map((w) => [w.file, w.lines.map((h) => `${h.at}:${h.line}:${h.text}`)]), [[f, [`${f}:1:${extra.trim()}`]]], "mutant 1 names the file and the line");
  assert.match(describe(cmp), /UP new kinds/);
  // the same line after the test cut does not count
  const after = measure(groups, overlay({ [f]: `${text}\n#[cfg(test)]\nmod probe_tests {\n${extra}\n}\n` }), self.kinds);
  eq(after.totals.new.kinds, self.totals.new.kinds, "mutant 1b: the same line inside the test part is not counted");
  // mutant 1c: registry names in other spellings and cases, each one line, each red on new kinds and naming that line
  for (const [spelled, name] of [['    let t = "choropleth";', "choropleth"], ['    let p = "rankbar";', "rankbar"], ['    let k = "Sankey";', "sankey"], ["    Kind::Sankey => {}", "sankey"], ['    let s = "stacked_bar_100";', "stackedbar100"], ["    Shape::StackedBar100 => {}", "stackedbar100"], ["    CHOROPLETH_FILL;", "choropleth"]]) {
    const m2 = measure(groups, overlay({ [f]: `${spelled}\n${text}` }), self.kinds);
    const c2 = compare(m2, selfBase, diskHits);
    eq([cmp2str(c2), m2.totals.new.kinds - self.totals.new.kinds, c2.rises[0]?.where[0]?.lines.map((h) => [h.text, h.names.includes(name)])], ["new/kinds", 1, [[spelled.trim(), true]]], `mutant 1c: ${spelled.trim()} is red on new kinds as ${name}`);
  }
}
// mutant 2: a word file pulled in with include_str gains one CJK line
{
  const w = self.words.find((x) => routeOf(x.includer) === "new") ?? self.words[0];
  const route = routeOf(w.includer);
  const extra = '  "added": "\u65b0\u589e\u6587\u6848",';
  const text = diskRead(w.target);
  const m = measure(groups, overlay({ [w.target]: text.replace("\n", `\n${extra}\n`) }), self.kinds);
  eq(m.totals[route].copy, self.totals[route].copy + 1, `mutant 2: ${w.target} (read by ${w.includer}) with one CJK line: copy goes up by 1`);
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
  const m = measure(g2, overlay({ "src/next_ratchet_probe.rs": 'fn x() { json!({"op": "probe"}); }\n' }), self.kinds);
  eq([m.scanned.new, m.totals.new.ops], [self.scanned.new + 1, self.totals.new.ops + 1], "mutant 3: a new agent file is picked up from groups.json");
  eq(compare(m, selfBase, diskHits).rises.map((x) => `${x.route}/${x.count}`), ["new/ops"], "mutant 3 is red on new ops");
  eq(compare(measure(groups, overlay({ [Object.keys(self.perFile)[0]]: "" }), self.kinds), selfBase, diskHits).drops.length > 0, true, "an emptied file drops a count: red, lower the baseline");
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
  for (const [f, r] of Object.entries(m.reads)) if (process.argv.includes("--print")) console.log(`read ${r.read} / total ${r.total} lines: ${f}`);
  console.log(m.hidden.length ? `NOT fully read (non-test code past a test cut): ${m.hidden.join("; ")}` : "every non-test part read in full");
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
