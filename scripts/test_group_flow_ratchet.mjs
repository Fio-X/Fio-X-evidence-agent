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
//   kinds  each line naming a chart kind: the KIND_RE word list below, `"map"`/`"flow"`/`"change"`, Relation::Flow etc.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO, "scripts/fixtures/flow-ratchet.json");
export const COUNTS = ["nodes", "ops", "copy", "kinds"];
export const ROUTES = ["new", "old"];

export const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const KIND = "composition|stacked100|bubbles?|sankey|heatmap|change_bars|bars|ring|column|treemap|dotgrid";
export const KIND_RE = new RegExp(`(?<![A-Za-z0-9])(?:${KIND})(?![A-Za-z0-9])|"(?:map|flow|change)"|Relation::(?:Flow|Composition|Map|Change)\\b`);
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

/** One file's hits: { nodes, ops, copy, kinds, includes } with hits as { at, line, text }. */
export function scanText(path, text) {
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
    if (KIND_RE.test(code)) hit("kinds", i);
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
export function measure(groups, read) {
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
    const got = scanText(f, text);
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
  return { files: files.length, scanned, totals, perFile, hits, missing, words };
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

const baselineOf = (m, at) => ({
  measured_at: at,
  rules: "scripts/test_group_flow_ratchet.mjs header; totals and per_file may only go down",
  totals: m.totals,
  scanned: m.scanned,
  per_file: Object.fromEntries(Object.keys(m.perFile).sort().map((f) => [f, m.perFile[f]])),
});
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const diskRead = (p) => { const f = join(REPO, p); return existsSync(f) ? readFileSync(f, "utf8") : null; };
const refRead = (sha) => (p) => { try { return git("show", `${sha}:${p}`); } catch { return null; } };
const refHitsAt = (sha, groups) => { let m = null; return (f) => { m ??= measure(groups, refRead(sha)); return m.hits[f]; }; };
const argAfter = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : null; };

// ---- self-tests ----------------------------------------------------------------------------------------------------------------------------
let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };
const counts = (path, text) => { const g = scanText(path, text); return Object.fromEntries(COUNTS.map((c) => [c, g[c].length])); };
eq(counts("src/next_x.rs", 'let k = "sankey";\n// let k = "bars";\nlet t = "\u4e2d\u6587";\nlet o = json!({"op": "fill"});\n#[cfg(test)]\nlet k = "ring";\n'), { nodes: 0, ops: 1, copy: 1, kinds: 1 }, "rs sample: comment skipped, cut at the test line");
eq(counts("src/next_x.rs", 'const NODE_FILLS: &[(&str, F)] = &[\n    ("map", map_fill),\n    ("ring", ring_fill),\n];\nfn map_fill() {}\npub(crate) fn fill_of() {}\n'), { nodes: 4, ops: 0, copy: 0, kinds: 2 }, "NODE_FILLS entries and fill fns");
eq(counts("src/next_x.rs", 'const NODE_FILLS: &[(&str, F)] = &[("map", map_fill), ("bars", bars_fill)];\nlet x = ("no", 1);\n'), { nodes: 2, ops: 0, copy: 0, kinds: 1 }, "a one-line NODE_FILLS table; a tuple after it is no entry");
eq(counts("runtime/pi/x.mjs", "const t = '\u4e2d\u6587'; // ok\nconst u = x; // \u4e2d\u6587 note\n"), { nodes: 0, ops: 0, copy: 1, kinds: 0 }, "js quote kinds; CJK only in a trailing comment is no copy");
eq(counts("runtime/pi/assets/x.tsv", "a\t\u4e2d\nb\tbars\n"), { nodes: 0, ops: 0, copy: 1, kinds: 0 }, "a data file counts copy only");
assert.ok(KIND_RE.test("change_bars") && KIND_RE.test("Relation::Flow") && !KIND_RE.test("rings2x") && !KIND_RE.test("columns"), "kind words are whole words");
checks += 1;

const groups = JSON.parse(diskRead("runtime/pi/groups.json"));
const disk = measure(groups, diskRead);
eq(disk.missing, [], "every agent file and word file groups.json and include_str name exists");
assert.ok(disk.files > 0 && disk.scanned.new > 0 && disk.scanned.old > 0, `scanned files: ${JSON.stringify(disk.scanned)} (each route must be > 0)`);
checks += 1;
assert.ok(disk.words.length > 0, "at least one include_str word file is scanned");
checks += 1;
const selfBase = baselineOf(disk, "disk");
const diskHits = (f) => disk.hits[f];
const overlay = (over) => (p) => (p in over ? over[p] : diskRead(p));

// mutant 1: a copy of a new-route file with one extra line naming a chart kind (placed before its test cut)
{
  const f = flowFiles(groups).find((p) => routeOf(p) === "new" && p.endsWith(".rs"));
  const text = diskRead(f);
  const extra = '    let kind = "treemap";';
  const m = measure(groups, overlay({ [f]: `${extra}\n${text}` }));
  eq(m.totals.new.kinds, disk.totals.new.kinds + 1, `mutant 1: ${f} with one chart-kind line: kinds goes up by 1`);
  const cmp = compare(m, selfBase, diskHits);
  eq(cmp.rises.map((x) => `${x.route}/${x.count}`), ["new/kinds"], "mutant 1 is red on new kinds only");
  eq(cmp.rises[0].where.map((w) => [w.file, w.lines.map((h) => `${h.at}:${h.line}:${h.text}`)]), [[f, [`${f}:1:${extra.trim()}`]]], "mutant 1 names the file and the line");
  assert.match(describe(cmp), /UP new kinds/);
  // the same line after the test cut does not count
  const after = measure(groups, overlay({ [f]: `${text}\n#[cfg(test)]\n${extra}\n` }));
  eq(after.totals.new.kinds, disk.totals.new.kinds, "mutant 1b: the same line inside the test part is not counted");
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
// mutant 3: a flow file added to groups.json is scanned with no edit here
{
  const g2 = structuredClone(groups);
  g2.files["src/next_ratchet_probe.rs"] = { group: "agent" };
  const m = measure(g2, overlay({ "src/next_ratchet_probe.rs": 'fn x() { json!({"op": "probe"}); }\n' }));
  eq([m.scanned.new, m.totals.new.ops], [disk.scanned.new + 1, disk.totals.new.ops + 1], "mutant 3: a new agent file is picked up from groups.json");
  eq(compare(m, selfBase, diskHits).rises.map((x) => `${x.route}/${x.count}`), ["new/ops"], "mutant 3 is red on new ops");
  eq(compare(measure(groups, overlay({ [Object.keys(disk.perFile)[0]]: "" })), selfBase, diskHits).drops.length > 0, true, "an emptied file drops a count: red, lower the baseline");
}

// ---- the ratchet -----------------------------------------------------------------------------------------------------------------------------
const row = (m) => ROUTES.map((r) => `${r} (${m.scanned[r]} files) ${COUNTS.map((c) => `${c} ${m.totals[r][c]}`).join(" ")}`).join(" | ");
const at = argAfter("--at");
if (at) {
  assert.match(at, /^[0-9a-f]{40}$/, "--at takes a 40-hex sha");
  const g = JSON.parse(refRead(at)("runtime/pi/groups.json"));
  const m = measure(g, refRead(at));
  console.log(`at ${at}: ${row(m)}${m.missing.length ? ` | missing ${m.missing.join(", ")}` : ""}`);
  console.log(`word files: ${m.words.map((w) => `${w.includer} <- ${w.target}`).join(", ")}`);
  if (process.argv.includes("--print")) for (const [f, c] of Object.entries(m.perFile)) console.log(`  ${f} ${JSON.stringify(c)}`);
  process.exit(0);
}
if (process.argv.includes("--print")) for (const [f, c] of Object.entries(disk.perFile)) console.log(`  ${f} ${JSON.stringify(c)}`);
// a missing baseline is red; only --lower writes the first one
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
assert.ok(baseline || process.argv.includes("--lower"), `no baseline at ${BASELINE_PATH.slice(REPO.length + 1)}`);
const cmp = baseline ? compare(disk, baseline, refHitsAt("HEAD", groups)) : { rises: [], drops: [] };
if (process.argv.includes("--lower")) {
  if (cmp.rises.length) { console.error(describe(cmp)); console.error("--lower refused: a total is above its baseline"); process.exit(1); }
  let head = "unknown";
  try { head = git("rev-parse", "HEAD").trim(); } catch {}
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baselineOf(disk, head), null, 2)}\n`);
  console.log(`baseline written: ${row(disk)}`);
  process.exit(0);
}
if (cmp.rises.length || cmp.drops.length) {
  console.error(describe(cmp));
  console.error(`flow ratchet FAIL: ${row(disk)}`);
  process.exit(1);
}
console.log(`flow ratchet ok (${checks} self-checks): ${row(disk)}`);
