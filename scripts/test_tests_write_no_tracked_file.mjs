#!/usr/bin/env node
// No test edits the repository in place. A test that writes, renames, copies over or deletes a file under the repo's
// runtime/, src/, fixtures/, config/, scripts/ or recipes/ (even one it puts back afterwards) can break another test that
// reads that file while both run in a parallel full comparison. Tests work on a copy in a scratch folder instead
// (os.tmpdir(), mkdtemp, TMPDIR, scripts/tmp_helper.mjs makeTestTmp) or under the git-ignored outputs/.
//
// A static scan of scripts/test_*.mjs, .js and .py. Each write call's target (writeFileSync, appendFileSync, renameSync,
// rmSync, unlinkSync, copyFileSync, cpSync and their fs/promises forms; Python open(..., "w"/"a"/"x"/"+"), Path.write_text,
// write_bytes, open, touch, unlink, rename, os.remove/unlink/rename/replace, shutil copy/move/rmtree) is read as written, with
// the file's own assignments substituted in, and counts when it is under the repo root (ROOT, REPO, import.meta.url,
// __dirname, __file__, the working directory) in one of those folders, and not under a scratch folder or outputs/.
// The scan is a heuristic over source text: it sees what a reader of the call sees, not what runs.
//
// The writes no test can move off yet are pinned per file in scripts/fixtures/tests-writing-tracked-files.json with the
// reason for each; a file's count must equal its pin (a new write is red, a removed one is red until the pin goes down),
// and the pins' total may only go down (PIN_TOTAL_CEILING). Self-tests below: must-fail and must-pass sources.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = "scripts/fixtures/tests-writing-tracked-files.json";
// The registry's total when it was made (2026-11-01). Lower it with the registry; never raise it.
const PIN_TOTAL_CEILING = 35;
const TRACKED_DIRS = ["runtime", "src", "fixtures", "config", "scripts", "recipes"];

// ---- lexing: blank comments, keep strings, know which characters are code ------------------------------------------------
function lex(src, lang) {
  const out = src.split("");
  const code = new Array(src.length).fill(true);
  const n = src.length;
  let i = 0;
  let prevSig = ""; // last significant code character (JS regex-literal guess)
  const blank = (a, b) => { for (let k = a; k < b; k++) { if (out[k] !== "\n") out[k] = " "; code[k] = false; } };
  const str = (a, b) => { for (let k = a; k < b; k++) code[k] = false; };
  const jsTemplate = (start) => { // returns index after the closing backtick
    let k = start + 1;
    while (k < n && src[k] !== "`") {
      if (src[k] === "\\") { k += 2; continue; }
      if (src[k] === "$" && src[k + 1] === "{") { str(start, k + 2); k = jsCode(k + 2, "}"); start = k - 1; continue; }
      k++;
    }
    str(start, Math.min(k + 1, n));
    return k + 1;
  };
  const jsCode = (start, close) => { // lex JS code until an unbalanced `close`; returns index after it
    let k = start, depth = 0;
    while (k < n) {
      const c = src[k];
      if (close && depth === 0 && c === close) return k + 1;
      if (c === "/" && src[k + 1] === "/") { const e = src.indexOf("\n", k); const end = e < 0 ? n : e; blank(k, end); k = end; continue; }
      if (c === "/" && src[k + 1] === "*") { const e = src.indexOf("*/", k + 2); const end = e < 0 ? n : e + 2; blank(k, end); k = end; continue; }
      if (c === "'" || c === '"') { let e = k + 1; while (e < n && src[e] !== c && src[e] !== "\n") e += src[e] === "\\" ? 2 : 1; str(k, e + 1); k = e + 1; prevSig = c; continue; }
      if (c === "`") { k = jsTemplate(k); prevSig = "`"; continue; }
      if (c === "/" && (prevSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSig))) {
        let e = k + 1, cls = false;
        while (e < n && src[e] !== "\n" && (cls || src[e] !== "/")) { if (src[e] === "\\") e++; else if (src[e] === "[") cls = true; else if (src[e] === "]") cls = false; e++; }
        if (src[e] === "/") { str(k, e + 1); k = e + 1; prevSig = ")"; continue; }
      }
      if (c === "{" || c === "(" || c === "[") depth++;
      if (c === "}" || c === ")" || c === "]") depth--;
      if (!/\s/.test(c)) prevSig = /[\w$]/.test(c) ? (/\b(?:return|typeof|case|in|of)$/.test(src.slice(Math.max(0, k - 6), k + 1)) ? "(" : "a") : c;
      k++;
    }
    return k;
  };
  if (lang === "js") { jsCode(0, null); return { text: out.join(""), code }; }
  while (i < n) {
    const c = src[i];
    if (c === "#") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      const triple = src.slice(i, i + 3) === c.repeat(3);
      const q = triple ? c.repeat(3) : c;
      let e = i + q.length;
      while (e < n && src.slice(e, e + q.length) !== q && (triple || src[e] !== "\n")) e += src[e] === "\\" ? 2 : 1;
      str(i, e + q.length); i = e + q.length; continue;
    }
    i++;
  }
  return { text: out.join(""), code };
}

// ---- reading expressions ----------------------------------------------------------------------------------------------------
const OPEN = { "(": ")", "[": "]", "{": "}" };
/** From `start`, the text up to a top-level `,` `;` or closing bracket (and, at depth 0, a newline when `stopAtNewline`). */
function readExpr(L, start, stopAtNewline) {
  let k = start, depth = 0;
  const { text, code } = L;
  while (k < text.length) {
    const c = text[k];
    if (code[k]) {
      if (OPEN[c]) depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === "," || c === ";")) break;
      else if (depth === 0 && c === "\n" && stopAtNewline && !/[\\(,+]\s*$/.test(text.slice(start, k))) break;
    }
    k++;
  }
  return { expr: text.slice(start, k).trim(), end: k };
}
/** The top-level arguments of the call whose `(` is at `open`. */
function callArgs(L, open) {
  const args = [];
  let k = open + 1;
  for (;;) {
    const { expr, end } = readExpr(L, k, false);
    if (expr) args.push(expr);
    if (end >= L.text.length || L.text[end] === ")" || L.text[end] === "]" || L.text[end] === "}") return args;
    k = end + 1;
  }
}
/** The receiver of a method call whose `.` is at `dot`: an identifier chain with calls, indexing and parentheses. */
function receiver(L, dot) {
  const { text, code } = L;
  let k = dot - 1;
  for (;;) {
    while (k >= 0 && (text[k] === " " || text[k] === "\t")) k--;
    if (k >= 0 && code[k] && (text[k] === ")" || text[k] === "]")) {
      let depth = 0;
      for (; k >= 0; k--) {
        if (!code[k]) continue;
        if (text[k] === ")" || text[k] === "]") depth++;
        else if (text[k] === "(" || text[k] === "[") { depth--; if (depth === 0) break; }
      }
      k--;
      while (k >= 0 && /[\w$]/.test(text[k])) k--;
    } else if (k >= 0 && /[\w$]/.test(text[k])) {
      while (k >= 0 && /[\w$]/.test(text[k])) k--;
    } else break;
    if (k >= 0 && text[k] === ".") { k--; continue; }
    break;
  }
  return text.slice(k + 1, dot).trim();
}

// ---- assignments, substituted into a target ---------------------------------------------------------------------------------
function assignments(L, lang) {
  const map = new Map();
  const add = (name, expr) => { if (!expr) return; if (!map.has(name)) map.set(name, []); map.get(name).push(expr); };
  const { text, code } = L;
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
    if (!code[m.index]) continue;
    add(m[1], readExpr(L, m.index + m[0].length, lang === "py").expr);
  }
  // loop variables and destructured names take the whole expression they come from
  const names = (pattern) => [...pattern.replace(/\b[A-Za-z_$][\w$]*\s*:(?!:)/g, "").matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]);
  const loops = lang === "py" ? /\bfor\s+([\w\s,()]+?)\s+in\s+/g : /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*|\[[^\]]*\]|\{[^}]*\})\s+of\s+/g;
  for (const m of text.matchAll(loops)) {
    if (!code[m.index]) continue;
    const expr = readExpr(L, m.index + m[0].length, lang === "py").expr;
    for (const name of names(m[1])) add(name, expr);
  }
  if (lang === "js") for (const m of text.matchAll(/\b(?:const|let|var)\s*(\[[^\]=]*\]|\{[^}=]*\})\s*=(?![=>])/g)) {
    if (!code[m.index]) continue;
    const expr = readExpr(L, m.index + m[0].length, false).expr;
    for (const name of names(m[1])) add(name, expr);
  }
  if (lang === "py") for (const m of text.matchAll(/\bwith\s+([^\n]+?)\s+as\s+([A-Za-z_]\w*)/g)) if (code[m.index]) add(m[2], m[1]);
  return map;
}
// Calls that build a path from their arguments; any other call's result is opaque (only its name is kept, so a scratch
// maker like makeTestTmp(...) still reads as scratch, and a helper given ROOT does not read as the repo).
const PATH_BUILDERS = /^(?:await\s+)?(?:new\s+URL|URL|join|resolve|dirname|normalize|fileURLToPath|pathToFileURL|realpathSync|String|str|Path|PurePath|(?:path|posix|os\.path)\.\w+)\s*\(/;
const callEnd = (t, open) => { let d = 0; for (let k = open; k < t.length; k++) { if (t[k] === "(") d++; else if (t[k] === ")" && --d === 0) return k + 1; } return t.length; };
const opaque = (e) => {
  const t = e.trim();
  const m = t.match(/^(?:await\s+)?(?:new\s+)?([\w$.]+)\s*\(/);
  if (!m || PATH_BUILDERS.test(t)) return t;
  return `${m[1]}(…)${t.slice(callEnd(t, t.indexOf("(")))}`;
};
/** The expression with each name's assigned expressions written after it once (`name{a | b}`), to depth 6. */
function expand(expr, map, done = new Set(), depth = 0) {
  if (depth > 6) return expr;
  return expr.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1|(?<![\w$.])[A-Za-z_$][\w$]*/g, (tok) => {
    if (/^["'`]/.test(tok) || !map.has(tok) || done.has(tok)) return tok;
    done.add(tok);
    return `${tok}{${map.get(tok).slice(0, 12).map((e) => expand(opaque(e.slice(0, 2000)), map, done, depth + 1)).join(" | ")}}`;
  });
}

// ---- classifying a target ---------------------------------------------------------------------------------------------------
const SCRATCH = /tmpdir\b|mkdtemp|makeTestTmp|TMPDIR|\btempfile\b|TemporaryDirectory|\btmp_path\b|NamedTemporaryFile|gettempdir|tmpd\.sh/;
const REPO_NAMES = /(?<![\w$.])(?:ROOT|REPO|REPO_ROOT|REPOROOT|repoRoot|repo_root|PROJECT_ROOT)(?![\w${])/;
const REPO_ANCHOR = /import\.meta\.url|__dirname|__file__|process\.cwd\(\)|os\.getcwd\(\)|Path\.cwd\(\)/;
const UP_ONE = /["'`]\.\.(?:\/|["'`])|\.parents\s*\[|\.parent\s*\.\s*parent\b|dirname\(\s*(?:os\.path\.)?dirname\(/;
const strings = (e) => [...e.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
const underTracked = (s) => { const first = s.replace(/^(?:\.\.?\/)+/, "").split("/")[0]; return TRACKED_DIRS.includes(first); };

/** Why a target expression is an in-place repo write, or null. */
export function classifyTarget(raw, map) {
  const e = expand(raw, map);
  if (SCRATCH.test(e)) return null;
  const lits = strings(e);
  if (lits.some((s) => /^(?:\.\.\/)*outputs(?:\/|$)/.test(s))) return null;
  const anchored = REPO_ANCHOR.test(e) || REPO_NAMES.test(e);
  const bareLiteral = /^(?:[\w.]+\(\s*)*["'`]/.test(raw.trim()) && !/[A-Za-z_$][\w$]*\s*(?:,|\))/.test(raw.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ""));
  const tracked = lits.some(underTracked);
  // the scripts folder itself: __dirname, Path(__file__).parent or new URL("x", import.meta.url) with no step up
  const scriptsDir = /__dirname|__file__|import\.meta\.url/.test(e) && !UP_ONE.test(e) && !/\bROOT\b|\bREPO\b/.test(e);
  if ((anchored || bareLiteral) && tracked) return `under ${lits.find(underTracked)}`;
  if (scriptsDir && (/__dirname|__file__/.test(e) || /new URL\(\s*["'`](?!\.\.)/.test(e))) return "under scripts/ (the test's own folder)";
  return null;
}

const JS_SYNC = { writeFileSync: [0], appendFileSync: [0], rmSync: [0], unlinkSync: [0], renameSync: [0, 1], copyFileSync: [1], cpSync: [1] };
const JS_ASYNC = { writeFile: [0], appendFile: [0], rm: [0], unlink: [0], rename: [0, 1], copyFile: [1], cp: [1] };
const PY_FUNCS = { "os.remove": [0], "os.unlink": [0], "os.rmdir": [0], "os.rename": [0, 1], "os.replace": [0, 1], "shutil.copy": [1], "shutil.copy2": [1], "shutil.copyfile": [1], "shutil.copytree": [1], "shutil.move": [0, 1], "shutil.rmtree": [0] };
const PY_METHODS = { write_text: [], write_bytes: [], touch: [], unlink: [], rename: [0], replace: [0], open: [] };
const WRITE_MODE = /^["'][rbt]*[wax+][bt+]*["']$/;

/** Every in-place repo write in one test source: [{ line, call, target, why }]. */
export function scanSource(src, lang) {
  const L = lex(src, lang);
  const map = assignments(L, lang);
  const found = [];
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  const hit = (i, call, target) => { const why = target && classifyTarget(target, map); if (why) found.push({ line: lineOf(i), call, target, why }); };
  if (lang === "js") {
    const calls = { ...JS_SYNC };
    // aliases from fs imports: `{ rmSync: rm }`, `{ rmSync as rm }`; fs/promises names
    for (const m of L.text.matchAll(/\{([^{}]*)\}\s*(?:=\s*(?:await\s+)?import\(\s*["'](node:)?fs(\/promises)?["']\s*\)|from\s+["'](?:node:)?fs(\/promises)?["'])/g)) {
      const promises = Boolean(m[3] || m[4]);
      for (const part of m[1].split(",")) {
        const [orig, alias] = part.split(/\s*(?::|\bas\b)\s*/).map((s) => s.trim());
        const table = promises ? JS_ASYNC : JS_SYNC;
        if (table[orig]) calls[alias || orig] = table[orig];
      }
    }
    for (const [name, which] of Object.entries(calls)) {
      const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
      for (const m of L.text.matchAll(re)) {
        if (!L.code[m.index]) continue;
        const before = L.text.slice(Math.max(0, m.index - 30), m.index);
        if (/function\s*$/.test(before)) continue;
        if (/\.\s*$/.test(before) && !/(?:fs|fsp|promises|fsPromises)\s*\.\s*$/.test(before)) continue;
        const args = callArgs(L, m.index + m[0].length - 1);
        for (const a of which) hit(m.index, name, args[a]);
      }
    }
    for (const m of L.text.matchAll(/(?:fsp|promises|fsPromises)\s*\.\s*(writeFile|appendFile|rm|unlink|rename|copyFile|cp)\s*\(/g)) {
      if (!L.code[m.index]) continue;
      const args = callArgs(L, m.index + m[0].length - 1);
      for (const a of JS_ASYNC[m[1]]) hit(m.index, m[1], args[a]);
    }
    return found;
  }
  for (const m of L.text.matchAll(/(?<![\w.])open\s*\(/g)) {
    if (!L.code[m.index]) continue;
    const args = callArgs(L, m.index + m[0].length - 1);
    const mode = args.find((a) => /^mode\s*=/.test(a))?.replace(/^mode\s*=\s*/, "") ?? (args[1] && !/=/.test(args[1]) ? args[1] : null);
    if (mode && WRITE_MODE.test(mode)) hit(m.index, "open", args[0]);
  }
  for (const [name, which] of Object.entries(PY_FUNCS)) {
    for (const m of L.text.matchAll(new RegExp(`(?<![\\w.])${name.replace(".", "\\s*\\.\\s*")}\\s*\\(`, "g"))) {
      if (!L.code[m.index]) continue;
      const args = callArgs(L, m.index + m[0].length - 1);
      for (const a of which) hit(m.index, name, args[a]);
    }
  }
  for (const [name, which] of Object.entries(PY_METHODS)) {
    for (const m of L.text.matchAll(new RegExp(`\\.\\s*${name}\\s*\\(`, "g"))) {
      if (!L.code[m.index]) continue;
      const recv = receiver(L, m.index);
      if (!recv || /^(?:os|shutil|str|["'])/.test(recv) || /^(?:os|shutil)\./.test(recv)) continue;
      const args = callArgs(L, m.index + m[0].length - 1);
      if (name === "open" && !(args[0] && WRITE_MODE.test(args[0].replace(/^mode\s*=\s*/, "")))) continue;
      if (name === "replace" && args.length !== 1) continue; // str.replace takes two
      hit(m.index, `.${name}`, recv);
      for (const a of which) hit(m.index, `.${name}`, args[a]);
    }
  }
  return found;
}

/** The verdict for counts per file against the registry: problem lines, [] is clean. */
export function verdict(counts, registry, ceiling = PIN_TOTAL_CEILING) {
  const out = [];
  let total = 0;
  for (const [file, entry] of Object.entries(registry.files ?? {})) {
    total += entry.count;
    if (!Array.isArray(entry.sites) || entry.sites.length !== entry.count) out.push(`${REGISTRY} ${file}: count ${entry.count} needs one reason per write in sites`);
    if (!(file in counts)) out.push(`${REGISTRY} ${file}: no such test (drop the pin)`);
  }
  if (total > ceiling) out.push(`${REGISTRY} pins ${total} writes in all, over the ceiling ${ceiling}: the pins may only go down`);
  for (const [file, n] of Object.entries(counts)) {
    const pin = registry.files?.[file]?.count ?? 0;
    if (n > pin) out.push(`${file}: ${n} in-place repo write(s), pinned ${pin}: write to a scratch copy (makeTestTmp, mkdtemp) or outputs/ instead`);
    else if (n < pin) out.push(`${file}: ${n} in-place repo write(s), pinned ${pin}: lower the pin in ${REGISTRY} (and PIN_TOTAL_CEILING)`);
  }
  return out;
}

const langOf = (f) => (f.endsWith(".py") ? "py" : "js");
const testFiles = () => readdirSync(join(REPO, "scripts")).filter((f) => /^test_.*\.(?:mjs|js|py)$/.test(f)).sort().map((f) => `scripts/${f}`);

// ---- self-tests ---------------------------------------------------------------------------------------------------------------
const JS_HEAD = 'import { writeFileSync, mkdtempSync } from "node:fs";\nimport { join } from "node:path";\nimport { tmpdir } from "node:os";\nimport { fileURLToPath } from "node:url";\nconst ROOT = fileURLToPath(new URL("..", import.meta.url));\n';
const PY_HEAD = "from pathlib import Path\nROOT = Path(__file__).resolve().parents[1]\n";
const realFiles = testFiles();
const counts = {};
const sites = [];
for (const f of realFiles) {
  const got = scanSource(readFileSync(join(REPO, f), "utf8"), langOf(f));
  counts[f] = got.length;
  for (const s of got) sites.push(`${f}:${s.line} ${s.call}(${s.target.replace(/\s+/g, " ").slice(0, 90)}) -- ${s.why}`);
}
if (process.argv.includes("--list")) { for (const s of sites) console.log(s); process.exit(0); }
// --scan <file>...: the findings for any files (a test's older version, say), not held to the registry
if (process.argv[2] === "--scan") {
  for (const f of process.argv.slice(3)) for (const s of scanSource(readFileSync(f, "utf8"), langOf(f))) console.log(`${f}:${s.line} ${s.call}(${s.target.replace(/\s+/g, " ").slice(0, 90)}) -- ${s.why}`);
  process.exit(0);
}
const registry = JSON.parse(readFileSync(join(REPO, REGISTRY), "utf8"));

const one = (src, lang) => scanSource(src, lang).length;
const withNew = (file, src, lang) => verdict({ ...counts, [file]: one(src, lang) }, registry);
// a registered .mjs test, read from disk, with one more write appended
const pinnedJs = Object.keys(registry.files ?? {}).find((f) => f.endsWith(".mjs"));
const mustFail = [
  ["a new test writes runtime/pi/x.mjs", () => withNew("scripts/test_new.mjs", `${JS_HEAD}writeFileSync(join(ROOT, "runtime/pi/x.mjs"), "export {};\\n");\n`, "js"), "test_new.mjs: 1 in-place repo write(s), pinned 0"],
  ["a new test writes runtime/pi/x.mjs through new URL", () => withNew("scripts/test_new.mjs", `${JS_HEAD}const p = new URL("../runtime/pi/x.mjs", import.meta.url);\nwriteFileSync(p, "");\n`, "js"), "test_new.mjs: 1 in-place repo write(s), pinned 0"],
  ["a renamed fs alias deletes a runtime file", () => withNew("scripts/test_new.mjs", `${JS_HEAD}const { rmSync: rm } = await import("node:fs");\nrm(join(ROOT, "runtime", "pi", "x.mjs"));\n`, "js"), "test_new.mjs: 1 in-place repo write(s), pinned 0"],
  ["a Python test opens ROOT/\"src/x.rs\" for writing", () => withNew("scripts/test_new.py", `${PY_HEAD}with open(ROOT / "src/x.rs", "w") as f:\n    f.write("")\n`, "py"), "test_new.py: 1 in-place repo write(s), pinned 0"],
  ["a Python test write_text()s under fixtures/", () => withNew("scripts/test_new.py", `${PY_HEAD}(ROOT / "fixtures" / "x.json").write_text("{}")\n`, "py"), "test_new.py: 1 in-place repo write(s), pinned 0"],
  [`a registered file (${pinnedJs}) gains one more write`, () => {
    const pin = registry.files[pinnedJs].count;
    return verdict({ ...counts, [pinnedJs]: one(`${readFileSync(join(REPO, pinnedJs), "utf8")}\nwriteFileSync(join(ROOT, "src/x.rs"), "");\n`, "js") }, registry).filter((p) => p.includes(`pinned ${pin}`));
  }, `${pinnedJs}: ${(registry.files?.[pinnedJs]?.count ?? 0) + 1} in-place repo write(s), pinned`],
  ["a registered file loses a write but keeps its pin", () => verdict({ ...counts, [pinnedJs]: counts[pinnedJs] - 1 }, registry), "lower the pin"],
  ["the registry pins more than the ceiling", () => verdict(counts, { ...registry, files: { ...registry.files, [pinnedJs]: { count: counts[pinnedJs] + 1, sites: [...registry.files[pinnedJs].sites, "x"] } } }), "over the ceiling"],
];
const mustPass = [
  ["a write into mkdtemp", `${JS_HEAD}const dir = mkdtempSync(join(tmpdir(), "t-"));\nwriteFileSync(join(dir, "runtime/pi/x.mjs"), "");\n`, "js"],
  ["a write under outputs/", `${JS_HEAD}writeFileSync(join(ROOT, "outputs", "x", "runtime.json"), "{}");\n`, "js"],
  ["a mutated copy whose ROOT is a scratch folder", `${JS_HEAD.replace("const ROOT", "const REPO")}import { makeTestTmp } from "./tmp_helper.mjs";\nconst ROOT = makeTestTmp("m-");\nconst path = join(ROOT, "runtime/pi/a.mjs");\nwriteFileSync(path, "");\n`, "js"],
  ["a Python write into TemporaryDirectory", `${PY_HEAD}import tempfile\nwith tempfile.TemporaryDirectory() as d:\n    (Path(d) / "src" / "x.rs").write_text("")\n`, "py"],
  ["a write named only in a comment or a string", `${JS_HEAD}// writeFileSync(join(ROOT, "runtime/pi/x.mjs"))\nconst s = 'writeFileSync(join(ROOT, "src/x.rs"))';\n`, "js"],
];
const results = [];
const bad = [];
for (const [label, run, want] of mustFail) {
  const got = run();
  if (got.some((p) => p.includes(want))) results.push(`must-fail ${label}: red as expected`);
  else bad.push(`must-fail ${label}: NOT red with "${want}", got ${JSON.stringify(got)}`);
}
for (const [label, src, lang] of mustPass) {
  const got = scanSource(src, lang);
  if (got.length === 0) results.push(`must-pass ${label}: clean`);
  else bad.push(`must-pass ${label}: NOT clean: ${JSON.stringify(got)}`);
}
const real = verdict(counts, registry);
for (const r of results) console.log(r);
for (const x of bad) console.log(`  NOT AS EXPECTED ${x}`);
for (const p of real) console.log(`  REPO ${p}`);
const pinned = Object.values(registry.files ?? {}).reduce((a, e) => a + e.count, 0);
console.log(`tests write no tracked file: ${realFiles.length} test files scanned, ${sites.length} in-place repo writes found, ${pinned} pinned; ` +
  `${results.length}/${mustFail.length + mustPass.length} self-tests as expected`);
assert.ok(realFiles.length > 100, "found the tests");
if (bad.length || real.length) {
  console.log("FAIL: test_tests_write_no_tracked_file");
  process.exitCode = 1;
} else console.log("ok: test_tests_write_no_tracked_file");
