#!/usr/bin/env node
// K368 (#62, hole C3): static ratchet on raw file-system writes in runtime/. A tool write is judged by the group guard only if the write site REGISTERS
// itself first (recordBoundaryWrite, stageOp, stagedWriteRoot or stagedFilePath, all from groups.mjs); the registration is a hand-written line in front of
// each raw writeFile / appendFile / rename / unlink / rm / link / copyFile / cp / symlink / truncate / mkdir / createWriteStream call, and nothing made sure
// a NEW raw write site also has one. This test finds every such call in runtime/**/*.{ts,mjs,js} (not runtime/pi/vendor, not runtime/web/vendor) and
// requires, for each site, exactly one of:
//   1. a registration on the same line or within MAX_REG_DISTANCE lines before it;
//   2. an entry in OUT_OF_RUN_FOLDER: the write does not land in a run folder or is the guard's own bookkeeping, with the reason written next to it;
//   3. an entry in KNOWN_GAPS: a site that is neither, found on 10-14 and kept visible for review. These are holes, not allowances; the test prints them
//      on every run and a gap that is fixed (the site is registered, or gone) must be deleted from the list.
// Both lists are exact: an entry that matches no site turns the test red (so the lists only ever shrink), and a new unregistered site is red whichever
// list it is not on. A site is keyed `<file>::<trimmed line text>#<n>` (n = nth identical line in that file) so a moved line keeps its entry.
// MAX_REG_DISTANCE is MEASURED, not chosen: it is the largest distance between a registration and the write it covers among the registered sites on
// 10-14 (the immutable writers register at the top of the function, the write comes a few lines later). The test prints the measured maximum and
// fails if a registered site needs more than the constant, so loosening it takes an edit with a reason here.
// How it reads the code (no parser is installed): comments and string text are blanked (blank() from test_group_cross_calls.mjs); a call counts when it
// is a bare name imported from node:fs / node:fs/promises in that file, or a method of an fs namespace (fs, fsp, promises, artifactFs). A local function
// that merely shares a name (a `truncate(s, n)` string helper) is not a write because it is not imported from fs. Not seen: a write done by a child
// process (the web/ renderers, python tools) or through a name the file got by other means; those are the C2 hole, not this one.
// `--root <dir>` reads <dir>/runtime instead of the repository (used by the mutation checks on temporary copies); `--print` lists every site.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { blank } from "./test_group_cross_calls.mjs";

const HERE = fileURLToPath(import.meta.url);
const REPO = join(dirname(HERE), "..");
const argAfter = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : null; };
const ROOT = argAfter("--root") ?? REPO;

export const MAX_REG_DISTANCE = 8;
const REGISTRATION = /\b(?:recordBoundaryWrite|stageOp|stagedWriteRoot|stagedFilePath)\b/;
const WRITE_OPS = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "rename", "renameSync", "unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync",
  "link", "linkSync", "symlink", "symlinkSync", "copyFile", "copyFileSync", "cp", "cpSync", "truncate", "truncateSync", "createWriteStream",
]);
// Directory creation writes no content and the guard does not judge it (hole C4, accepted as known): counted and printed, not ratcheted.
const DIR_OPS = new Set(["mkdir", "mkdirSync", "mkdtemp", "mkdtempSync"]);
const FS_MODULES = /^(?:node:)?fs(?:\/promises)?$/;
const EXTRA_NAMESPACES = ["artifactFs", "promises"]; // artifactFs: newsroom.ts's one object of fs functions for the immutable writers

// Sites whose write does not land in a run folder, or is the guard's own record. One reason each. Key = `<file>::<line text>#<n>`.
export const OUT_OF_RUN_FOLDER = {
  "runtime/pi/groups.mjs::appendFileSync(join(ctx.dir, STAGING_REPORT_FILE), JSON.stringify(line) + \"\\n\", \"utf8\");#1": "the guard's own record or rollback, written by groups.mjs itself; it cannot register with itself and it is not a tool write (staging report)",
  "runtime/pi/groups.mjs::appendFileSync(join(ctx.dir, STAGING_OPS_FILE), JSON.stringify(line) + \"\\n\", \"utf8\");#1": "the guard's own record or rollback, written by groups.mjs itself; it cannot register with itself and it is not a tool write (staging ops log)",
  "runtime/pi/groups.mjs::writeFileSync(path, JSON.stringify(report, null, 2) + \"\\n\", \"utf8\");#1": "the guard's own record or rollback, written by groups.mjs itself; it cannot register with itself and it is not a tool write (boundary report)",
  "runtime/pi/groups.mjs::appendFileSync(path, JSON.stringify(line) + \"\\n\", \"utf8\");#1": "the guard's own record or rollback, written by groups.mjs itself; it cannot register with itself and it is not a tool write (cross-call report)",
  "runtime/pi/groups.mjs::appendFileSync(path, JSON.stringify(entry) + \"\\n\", \"utf8\");#1": "the guard's own record or rollback, written by groups.mjs itself; it cannot register with itself and it is not a tool write (cross-call refusal log)",
  "runtime/pi/groups.mjs::if (!overlapped) for (const path of extra) { try { rmSync(join(root, path), { force: true }); rolled#1": "the guard's own record or rollback, written by groups.mjs itself; it cannot register with itself and it is not a tool write (rolls back files a declared child process made outside its declaration)",
  "runtime/pi/newsroom.ts::if (metricsFile) appendFileSync(metricsFile, `${JSON.stringify(metric)}\\n`, \"utf8\");#1": "performance metrics line appended to the file named by NEWSROOM_PHASE_METRICS_FILE, set by the measuring harness; not a run-folder artifact (if the harness points it into a run folder that is the harness's choice)",
  "runtime/pi/newsroom.ts::writeFileSync(join(tempDir, ref.split(\"/\").pop() as string), JSON.stringify(rows, null, 2) + \"\\n\", {#1": "row copy in a mkdtemp directory under the OS temp dir, handed to the DuckDB shadow check, removed in the finally block; never inside a run folder",
  "runtime/pi/newsroom.ts::if (tempDir) rmSync(tempDir, { recursive: true, force: true });#1": "removes that same OS temp directory",
  "runtime/pi/newsroom.ts::writeFileSync(pngPath, png);#1": "page PNG copy in a mkdtemp directory under the OS temp dir for the page read-back; never inside a run folder",
  "runtime/pi/newsroom.ts::} finally { rmSync(scratch, { recursive: true, force: true }); }#1": "removes that same OS temp directory",
  "runtime/pi/page_ocr.mjs::writeFileSync(sourceFile, swift);#1": "Swift source of the page reader in the user's cache folder (Library/Caches), outside any run folder; named by its source hash",
  "runtime/pi/page_ocr.mjs::renameSync(partial, binary);#1": "moves the compiled page reader into place in that same cache folder",
  "runtime/pi/pdf_extract.mjs::await writeFile(tempPath, bytes);#1": "PDF bytes copied to a random file in the OS temp dir for pdftotext; deleted after use; never inside a run folder",
  "runtime/pi/pdf_extract.mjs::try { await unlink(tempPath); } catch {}#1": "deletes that same OS temp file",
};
// Sites that fit neither rule: found, not excused. Key as above; the value says what the site does and why it matters.
export const KNOWN_GAPS = {
  "runtime/pi/newsroom.ts::await writeFile(marker,new Date().toISOString(),'utf8');#1": "fault-injection marker .fault-injected-<tool> written INSIDE the run folder (runtime/) with no registration. Only when NEWSROOM_FAULT_INJECT_TOOL_ONCE is set (test harness switch), so no production run reaches it; still a raw write the guard does not see",
  "runtime/pi/newsroom.ts::try { await artifactFs.unlink(join(dir, name)); removed++; } catch {}#1": "deletes stale <pid>-<hex>.tmp files in the run folder's artifact tmp dir. No registration in this function; the .tmp name is exempt from the write judgement (C1)",
  "runtime/pi/newsroom.ts::await artifactFs.writeFile(tmp, bytes, { flag: \"wx\" });#1": "createViaLink writes the temp file of an immutable artifact into the run folder's tmp dir. The final artifact is registered by the CALLER (writeArtifactIfAbsent / ...BytesIfAbsent, a few lines before it calls createViaLink), the temp name is exempt (C1); this function itself registers nothing and takes any root",
  "runtime/pi/newsroom.ts::await artifactFs.link(tmp, path);#1": "createViaLink publishes the temp file at the final artifact path with link(2); the registration is in the caller, not in this function",
  "runtime/pi/newsroom.ts::try { await artifactFs.unlink(tmp); } catch {}#1": "createViaLink removes its temp file; temp name exempt (C1)",
  "runtime/pi/newsroom.ts::try { await unlink(temp); } catch {}#1": "removes the preview PNG in <run>/runtime/preview-tmp/ after the rasterizer ran; the child process write is judged by runDeclared([temp]) but this unlink is not registered; folder exempt (C1)",
  "runtime/web/publication_request.mjs::const spec=JSON.parse(fs.readFileSync(reqPath,'utf8'));fs.mkdirSync(outdir,{recursive:true});const {#1": "child process (not the tool's own process): writes the publication spec output into the output folder it is given, which is inside the run folder. A registration cannot cover it; it is seen only after the fact by the runDeclared directory comparison (C2)",
  "runtime/web/render_request.mjs::const svgPath=path.join(outdir,'figure.svg'); fs.writeFileSync(svgPath,svg,'utf8');#1": "child process: writes figure.svg into its output folder inside the run folder; only seen after the fact by runDeclared (C2)",
  "runtime/web/render_request.mjs::const scenePayload=JSON.stringify(scene,null,2)+'\\n'; const scenePath=path.join(outdir,'scene.json')#1": "child process: writes the scene file into its output folder inside the run folder; only seen after the fact (C2)",
  "runtime/web/render_request.mjs::const payload=JSON.stringify(scene,null,2)+'\\n'; const scenePath=path.join(outdir,'scene.json'); fs.#1": "child process: writes the scene file into its output folder inside the run folder; only seen after the fact (C2)",
  "runtime/web/render_request.mjs::fs.writeFileSync(path.join(outdir,'manifest.json'),JSON.stringify(manifest,null,2)+'\\n');#1": "child process: writes manifest.json into its output folder inside the run folder; only seen after the fact (C2)",
};

// ---- reading the source ------------------------------------------------------------------------------------------------------------------
/** Local names this file imports from fs: { names: Map(local -> original), namespaces: Set(local) }. */
function fsImports(raw) {
  const names = new Map(), namespaces = new Set(EXTRA_NAMESPACES);
  for (const m of raw.matchAll(/import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g)) {
    if (!FS_MODULES.test(m[2])) continue;
    const clause = m[1].trim();
    const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (star) namespaces.add(star[1]);
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def) namespaces.add(def[1]);
    const group = /\{([^}]*)\}/.exec(clause);
    if (group) for (const part of group[1].split(",")) {
      const mm = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (mm) names.set(mm[2] ?? mm[1], mm[1]);
    }
  }
  return { names, namespaces };
}

/** files: Map(repo path -> source text). Returns every raw write site, with its registration distance (null when none above it in the file). */
export function scanSites(files, ops = WRITE_OPS) {
  const sites = [];
  for (const [file, text] of files) {
    const blanked = blank(text);
    const code = blanked.split("\n"), original = text.split("\n");
    const { names, namespaces } = fsImports(text);
    const seen = new Map();
    for (let i = 0; i < code.length; i++) {
      const line = code[i];
      let op = null;
      for (const m of line.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (names.has(m[1]) && ops.has(names.get(m[1])) && !/\bfunction\s+$/.test(line.slice(0, m.index))) { op = names.get(m[1]); break; }
      }
      if (!op) for (const m of line.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(?:promises\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (namespaces.has(m[1]) && ops.has(m[2])) { op = m[2]; break; }
      }
      if (!op) continue;
      let distance = null;
      for (let j = i; j >= 0; j--) if (REGISTRATION.test(code[j])) { distance = i - j; break; }
      const text1 = original[i].trim().replace(/\s+/g, " ").slice(0, 100);
      const nth = (seen.get(text1) ?? 0) + 1;
      seen.set(text1, nth);
      sites.push({ file, line: i + 1, op, text: text1, key: `${file}::${text1}#${nth}`, distance });
    }
  }
  return sites;
}

function readRuntime(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "vendor" && entry.name !== "node_modules") walk(path); continue; }
      if (/\.(?:ts|mjs|js)$/.test(entry.name)) files.set(relative(root, path).replace(/\\/g, "/"), readFileSync(path, "utf8"));
    }
  };
  if (existsSync(join(root, "runtime"))) walk(join(root, "runtime"));
  return files;
}

/** Judge the sites. Returns { problems, registered, maxDistance, outOfRun, gaps } (problems is empty when the ratchet holds). */
export function judge(sites, { out = OUT_OF_RUN_FOLDER, gaps = KNOWN_GAPS, maxReg = MAX_REG_DISTANCE } = {}) {
  const problems = [], used = new Set();
  const registered = [], outOfRun = [], knownGaps = [];
  let maxDistance = 0;
  for (const site of sites) {
    const near = site.distance !== null && site.distance <= maxReg;
    if (near) { registered.push(site); maxDistance = Math.max(maxDistance, site.distance); }
    if (site.key in out) { used.add(site.key); outOfRun.push(site); if (near) problems.push(`${site.file}:${site.line} is registered, remove its OUT_OF_RUN_FOLDER entry: ${site.key}`); continue; }
    if (site.key in gaps) { used.add(site.key); knownGaps.push(site); if (near) problems.push(`${site.file}:${site.line} is registered now, remove its KNOWN_GAPS entry: ${site.key}`); continue; }
    if (!near) {
      problems.push(`${site.file}:${site.line}: ${site.op}() with no registration (recordBoundaryWrite / stageOp / stagedWriteRoot / stagedFilePath) within ${maxReg} lines before it${site.distance === null ? "" : ` (nearest is ${site.distance} lines up)`}: ${site.text}`);
    }
  }
  for (const key of [...Object.keys(out), ...Object.keys(gaps)]) if (!used.has(key)) problems.push(`list entry matches no site (the code changed or the gap was fixed; delete the entry): ${key}`);
  return { problems, registered, maxDistance, outOfRun, gaps: knownGaps };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const files = readRuntime(ROOT);
  const sites = scanSites(files);
  const dirSites = scanSites(files, DIR_OPS);
  if (process.argv.includes("--print")) {
    for (const s of sites) console.log(`${s.file}:${s.line} ${s.op} dist=${s.distance}  ${s.text.slice(0, 90)}`);
    console.log(`${sites.length} sites in ${files.size} files`);
    process.exit(0);
  }
  const verdict = judge(sites);
  if (argAfter("--root")) { // child mode for the mutation checks
    for (const p of verdict.problems) console.log(p);
    process.exit(verdict.problems.length ? 1 : 0);
  }
  assert.ok(files.size >= 40, `expected to read the whole runtime/ tree, saw ${files.size} files`);
  assert.ok(verdict.registered.length >= 10, "the scanner must see the registered sites (a broken scan finds none)");
  assert.deepEqual(verdict.problems, [], `raw write sites in runtime/ that the group guard cannot see:\n${verdict.problems.join("\n")}`);
  console.log(`ok: ${sites.length} raw write sites in ${files.size} runtime files: ${verdict.registered.length} registered (largest distance ${verdict.maxDistance} lines, limit ${MAX_REG_DISTANCE}), ${verdict.outOfRun.length} out of the run folder, ${verdict.gaps.length} known gaps; ${dirSites.length} directory-creating calls are counted only (C4)`);
  assert.ok(verdict.maxDistance <= MAX_REG_DISTANCE);
  for (const g of verdict.gaps) console.log(`KNOWN GAP (for review): ${g.file}:${g.line} ${g.op}: ${KNOWN_GAPS[g.key]}`);

  // ---- sample checks on the scanner itself (in memory) -------------------------------------------------------------------------------------
  const scan = (text) => scanSites(new Map([["runtime/pi/x.mjs", text]]));
  const imp = 'import { writeFile, rename as mv, mkdir } from "node:fs/promises";\nimport fs from "node:fs";\n';
  assert.equal(scan(imp + "async function f(){ await writeFile(p, b); }").length, 1, "bare imported writeFile");
  assert.equal(scan(imp + "function f(){ mv(a, b); }").length, 1, "aliased import is seen under its local name");
  assert.equal(scan(imp + "function f(){ fs.writeFileSync(p, b);\n fs.promises.rm(p); }").length, 2, "namespace calls (one site per line)");
  assert.equal(scan('import { readFile } from "node:fs/promises";\nfunction truncate(s, n) { return s; }\ntruncate(a, 3); readFile(p); const t = "writeFile(x)"; // rm(p)').length, 0, "a local helper with a write name, reads, strings, comments");
  assert.equal(scan(imp + "recordBoundaryWrite(r, p, 'write');\nawait writeFile(p, b);")[0].distance, 1, "distance counts lines up from the write");
  assert.equal(scan(imp + "await writeFile(p, b);")[0].distance, null, "no registration above");
  assert.equal(judge(scan(imp + "await writeFile(p, b);"), { out: {}, gaps: {} }).problems.length, 1, "an unregistered site is a problem");
  console.log("ok: scanner samples behave");

  // ---- mutation checks on temporary copies of runtime/ --------------------------------------------------------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), "k368-c3-"));
  try {
    const run = (name, edit, expectRed, needle = "") => {
      const dir = mkdtempSync(join(tmp, "m-"));
      cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true, filter: (src) => !/[\\/]vendor(?:[\\/]|$)/.test(src) });
      edit(dir);
      const res = spawnSync(process.execPath, [HERE, "--root", dir], { encoding: "utf8" });
      assert.equal(res.status === 1, expectRed, `mutation "${name}": expected ${expectRed ? "red" : "green"}, exit ${res.status}\n${res.stdout}${res.stderr}`);
      if (expectRed) assert.ok(res.stdout.includes(needle), `mutation "${name}": red, but not for the expected site (${needle}):\n${res.stdout}`);
      console.log(`ok: mutation "${name}" -> ${expectRed ? "red" : "green"}`);
    };
    const patch = (file, fn) => (dir) => { const p = join(dir, file); writeFileSync(p, fn(readFileSync(p, "utf8"))); };
    run("unchanged copy", () => {}, false);
    run("an unregistered writeFile(join(root, ...)) is added", patch("runtime/pi/shadow.mjs", (t) => t + '\nexport async function k368Mutant(root) { await writeFile(join(root, "x.json"), "{}"); }\n'), true, "runtime/pi/shadow.mjs");
    run("an unregistered write is added through an fs namespace", patch("runtime/pi/publication.mjs", (t) => t + "\nexport function k368Mutant(p) { fs.writeFileSync(p, 'x'); }\n"), true, "runtime/pi/publication.mjs");
    run("a registration line is removed (shadow.mjs)", patch("runtime/pi/shadow.mjs", (t) => { const next = t.split("\n").filter((l) => !/recordBoundaryWrite\(/.test(l) || /^\s*(?:export\s+)?(?:async\s+)?function|import/.test(l)); assert.notEqual(next.length, t.split("\n").length, "shadow.mjs has a registration line"); return next.join("\n"); }), true, "runtime/pi/shadow.mjs");
    run("the registration is moved out of range", patch("runtime/pi/shadow.mjs", (t) => t.replace(/(recordBoundaryWrite\([^\n]*\n)/, "$1" + "//\n".repeat(MAX_REG_DISTANCE + 2))), true, "runtime/pi/shadow.mjs");
    run("a registered write is added", patch("runtime/pi/shadow.mjs", (t) => t + '\nexport async function k368Ok(root) { recordBoundaryWrite(root, "x.json", "write"); await writeFile(join(root, "x.json"), "{}"); }\n'), false);
    run("a listed site changes its text (stale entry)", patch("runtime/pi/page_ocr.mjs", (t) => t.replace("writeFileSync(sourceFile, swift);", "writeFileSync(sourceFile, swift, 'utf8');")), Object.keys(OUT_OF_RUN_FOLDER).some((k) => k.includes("page_ocr.mjs::")), "list entry matches no site");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("PASS test_group_raw_write_sites");
}
