// The four-group list (agent, knowledge, visual, system) and the two opt-in helpers built on it. The list itself is groups.json
// (commands, Pi tools and source files, each in exactly one group). Nothing here runs unless a switch is set. NEWSROOM_GROUP_BOUNDARY
// only reports. NEWSROOM_GROUP_ENFORCE (on unless exactly "0", with HANDOFF) refuses a write by a tool outside the owning group, and NEWSROOM_GROUP_TOOLS (on unless exactly "0", #64 step 4)
// adds the single registration wrapper and the child-process output check; each refusal is also appended to runtime/boundary-refusals.jsonl.
//
// NEWSROOM_GROUP_BOUNDARY=1 (exact value, default off; this switch only reports, the refusing is done by NEWSROOM_GROUP_ENFORCE below): every artifact write made through newsroom.ts is recorded as
// (initiating tool, its group, artifact kind, owning group) in one report file, runtime/group-boundary-report.json. It only reports.
// A write whose tool or path cannot be classified is counted as 待查, never as fine. Write sites this file cannot see are listed in
// the report under not_traced, so the report never claims zero violations.
//
// NEWSROOM_GROUP_ENFORCE (on unless exactly "0"; needs the hand-off on, an explicit "1" with NEWSROOM_GROUP_HANDOFF=0 stops newsroom.ts at start-up): the same
// classification, but a write made by a tool outside the owning group is refused before anything reaches the disk. A write that cannot be
// classified (待查) is refused too, and so is a check that fails, errors or runs past its hard limit (fail-closed). Reads, mkdir and a group's own
// writers (asHandoffWriter) are refused unless groups.json "handoffs" lists the path for that writer and the asking tool as a requester. Not covered: Rust-side writes and files written by child processes (see NOT_TRACED).
//
// NEWSROOM_GROUP_TOOLS (on unless exactly "0", #64 step 4; exactly "1" with the refusal off stops newsroom.ts at start-up, see groupToolsEnabled): every tool goes through one
// wrapper at the single registration point (withGroupTools). A tool that groups.json does not list with a group and a group.action name stops the start-up.
// A tool that starts a child process declares its output files first (runDeclared): each declared file is judged like an in-process write before the process
// starts, and after it ends any NEW file in the watched folders that was not declared is deleted again and the call is refused; a file that already existed
// and was rewritten or removed is refused too, but cannot be restored (reported as such). A file a tool call running at the same time wrote through a judged write is that call's. That second part is a check
// AFTER writing with a rollback, not a refusal before writing: a child process can write what it likes in between.
// The only exceptions (E1-E3, each pinned by a test): E1 program bookkeeping (temp files and atomic intermediates, the phase-metrics file, the fault marker; the
// fixed lists below), E2 reads, E3 files a child process keeps inside itself (not visible, only the watched folders are compared).
//
// NEWSROOM_GROUP_ENFORCE is on unless exactly "0" (#64 step 3; see groupEnforceEnabled: with the hand-off turned off and ENFORCE unset it is off). NEWSROOM_GROUP_TOOLS follows it (#64 step 4; see groupToolsEnabled).
//
// NEWSROOM_GROUP_CALL_REPORT and NEWSROOM_GROUP_CALL_CHECK are on unless exactly "0" (#64 steps 1 and 2): the report records the first call of each
// (tool, function) pair, the check adds tool_allow / tool_pin rows and requester-none rows. Both only record. CALL_REPORT="0" turns the check's rows off
// with the report; CALL_CHECK="0" turns off only its own rows. NEWSROOM_GROUP_CALL_REFUSE=1 needs the report (start-up stop otherwise).
//
// NEWSROOM_GROUP_TOOL_ORDER=1 (exact value, default off): the tools are listed to the model in group order, each description
// starting with a short group label. Tools missing from groups.json keep their place after the groups, unlabeled.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUP_ORDER = ["agent", "knowledge", "visual", "system"];
export const BOUNDARY_REPORT_PATH = "runtime/group-boundary-report.json";

export const boundaryReportEnabled = () => process.env.NEWSROOM_GROUP_BOUNDARY === "1";
/** NEWSROOM_GROUP_ENFORCE (#64 step 3: on unless exactly "0"): refuse a write by a tool outside the owning group. Exactly "1" is on whatever else is set (with HANDOFF "0" newsroom.ts stops at start-up, as before);
 *  unset or any other value is on unless the hand-off is turned off (HANDOFF exactly "0"): the default does not apply there, enforcement is off and the run-end line names HANDOFF as turned off. */
export const groupEnforceEnabled = () => {
  const value = process.env.NEWSROOM_GROUP_ENFORCE;
  if (value === "0") return false;
  return value === "1" || process.env.NEWSROOM_GROUP_HANDOFF !== "0";
};
/** NEWSROOM_GROUP_CALL_REPORT (K307; #64 step 1: on unless exactly "0"): record which tool group reached which cross_calls function at run time. Report only. */
/** NEWSROOM_GROUP_CALL_CHECK (K366; #64 step 2: on unless exactly "0"): the call report also records tool_allow and tool_pin rows per tool, and a call with no asking tool (requester none). Record only.
 *  NEWSROOM_GROUP_CALL_REPORT="0" turns these rows off with the report: the check is part of the report, it never turns the report back on. */
export const callCheckEnabled = () => process.env.NEWSROOM_GROUP_CALL_CHECK !== "0" && process.env.NEWSROOM_GROUP_CALL_REPORT !== "0";
/** NEWSROOM_GROUP_CALL_REFUSE=1 (K381, default off, exact "1"): with ENFORCE and CALL_CHECK also on, a tool off its cross_calls.tool_allow / tool_pin row is refused (the call is recorded first). */
export const callRefuseEnabled = () => process.env.NEWSROOM_GROUP_CALL_REFUSE === "1";
/** NEWSROOM_GROUP_CALL_REFUSE_NOTOOL=1 (K381, default off, exact "1"): on top of CALL_REFUSE, a gated or tool_pin function called with no asking tool is refused too, but only when the run folder is known (NEWSROOM_ARTIFACT_DIR). */
export const callRefuseNoToolEnabled = () => process.env.NEWSROOM_GROUP_CALL_REFUSE_NOTOOL === "1";
/** NEWSROOM_GROUP_CALL_REFUSE_ALL=1 (#66 step 2, default off, exact "1"): implies CALL_REFUSE, and every wrapped function that has a row in cross_calls (not only the gated and tool_pin names) refuses a call from a group its row does not list. A function with no row is never refused. Read when a module is loaded (the wrap is chosen then). */
export const callRefuseAllEnabled = () => process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL === "1";
export const crossCallReportEnabled = () => process.env.NEWSROOM_GROUP_CALL_REPORT !== "0";
/** Tools need their initiating-tool context when either the report or the refusal is on. */
export const boundaryContextEnabled = () => boundaryReportEnabled() || groupEnforceEnabled() || crossCallReportEnabled();
/** NEWSROOM_GROUP_TOOLS (#64 step 4): every file the program writes into a run folder is judged by the table. Exactly "0" is off; exactly "1" is on whatever else is set (with the refusal off the start-up check stops it, GROUP_TOOLS_NEEDS_ENFORCE);
 *  unset or any other value follows the effective refusal switch (groupEnforceEnabled), so a run with the hand-off "0" or ENFORCE "0" keeps starting with the tool check off. */
export const groupToolsEnabled = () => {
  const value = process.env.NEWSROOM_GROUP_TOOLS;
  if (value === "0") return false;
  return value === "1" || groupEnforceEnabled();
};
/** NEWSROOM_GROUP_TOOLS_HASH_ALL=1 (K381, default off, exact "1"; needs TOOLS): runDeclared also takes the content hash of every file in the watched folders (up to HASH_ALL_MAX_BYTES each), so a rewrite that keeps size and time is seen. Only adds: nothing that is refused today passes. */
export const groupToolsHashAllEnabled = () => process.env.NEWSROOM_GROUP_TOOLS_HASH_ALL === "1";
export const HASH_ALL_MAX_BYTES = 16 * 1024 * 1024;
export const groupToolOrderEnabled = () => process.env.NEWSROOM_GROUP_TOOL_ORDER === "1";

let cached = null;
export function loadGroups() {
  if (!cached) cached = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "groups.json"), "utf8"));
  return cached;
}
export const toolGroup = (name) => loadGroups().tools?.[String(name ?? "")]?.group ?? null;

/** Every list entry or directory rule that covers a tracked path. A path must have exactly one. */
export function fileGroupMatches(path, list = loadGroups()) {
  const matches = [];
  if (list.files?.[path]) matches.push({ via: "entry", group: list.files[path].group });
  for (const rule of list.file_rules ?? []) if (path.startsWith(rule.prefix) && (!rule.suffix || path.endsWith(rule.suffix))) matches.push({ via: `rule ${rule.prefix}${rule.suffix ? "*" + rule.suffix : "*"}`, group: rule.group });
  return matches;
}

// ---- tool order and labels -------------------------------------------------------------------------------------------------
export const groupLabel = (group) => `[${group}] `;

/** Tools in group order (stable inside a group), each description prefixed with its group label. Unknown tools go last, unchanged. */
export function orderToolsByGroup(tools) {
  const rank = (tool) => { const index = GROUP_ORDER.indexOf(toolGroup(tool?.name)); return index === -1 ? GROUP_ORDER.length : index; };
  return tools
    .map((tool, position) => ({ tool, position, group: toolGroup(tool?.name) }))
    .sort((a, b) => rank(a.tool) - rank(b.tool) || a.position - b.position)
    .map(({ tool, group }) => (group && typeof tool.description === "string" ? { ...tool, description: groupLabel(group) + tool.description } : tool));
}

// ---- the boundary report ---------------------------------------------------------------------------------------------------
// Who may write which kind of artifact, and which path is which kind. Both tables live in groups.json (artifact_kinds), so the Rust side
// reads the same file and nothing is copied. The pass/publication decision belongs to the agent group alone; the other three groups
// have no right to write it (not merely read-only).
const kindTable = () => loadGroups().artifact_kinds ?? { ownership: {}, rules: [] };
export const OWNERSHIP = (() => { try { return loadGroups().artifact_kinds?.ownership ?? {}; } catch { return {}; } })();

/** First rule that matches wins; a rule is an exact path or a path prefix. Anything that matches no rule is 待查. A table that cannot be read matches nothing. */
export function classifyArtifact(relPath) {
  const path = String(relPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  let table;
  try { table = kindTable(); } catch { return null; }
  for (const rule of table.rules ?? []) {
    const hit = rule.exact !== undefined ? path === rule.exact : typeof rule.prefix === "string" && rule.prefix !== "" && path.startsWith(rule.prefix);
    const owner = table.ownership?.[rule.kind]?.owner;
    if (hit && owner) return { kind: rule.kind, owner, ...(rule.tag ? { tag: rule.tag } : {}) };
  }
  return null;
}

// Known cross-group writes, matched by path so a report line can say which one it is.
function knownTag(path, kind) {
  if (kind !== "evidence") return null;
  if (path === "claims.jsonl") return "claim record";
  if (path.startsWith("computations/")) return "computation record";
  if (path.startsWith("runtime/query-rows/")) return "query-rows helper";
  return null;
}

// What this report cannot see. Listed in every report so a zero is never read as proof.
export const NOT_TRACED = (() => { try { return loadGroups().boundary_report?.not_traced ?? []; } catch { return []; } })();

const store = new AsyncLocalStorage();
/** Run fn with `tool` as the initiating tool of every write made inside it. */
// K315: with NEWSROOM_GROUP_CALL_REPORT on (the default; off only when exactly "0") the context also carries the run folder (`root`), so a function exported from any module can find the report file without
// importing newsroom.ts. Off: the context is {tool} exactly as before.
const callRoot = () => { const value = process.env.NEWSROOM_ARTIFACT_DIR; return value ? resolve(value) : null; };
export const runInTool = (tool, fn) => store.run(crossCallReportEnabled() ? { tool: String(tool ?? ""), root: callRoot() } : { tool: String(tool ?? "") }, fn);
export const currentTool = () => store.getStore()?.tool ?? null;
const currentRoot = () => store.getStore()?.root ?? null;
/**
 * Run fn as a hand-off writer named in groups.json "handoffs".writers (NEWSROOM_GROUP_HANDOFF=1): the writes inside belong to the writer's group and are
 * reported under the writer's name, with the tool that asked for them kept in `requested_by`. The group comes from the table, not from the caller, and
 * with NEWSROOM_GROUP_ENFORCE=1 every write is also checked against the table's rows (path, kind, requester). An unlisted writer name throws.
 */
export function asHandoffWriter(writer, fn) {
  const entry = loadGroups().handoffs?.writers?.[writer];
  if (!entry) throw new Error(`hand-off writer ${writer} is not listed in groups.json handoffs.writers`);
  const root = store.getStore()?.root;
  return store.run({ tool: store.getStore()?.tool ?? "", ...(root ? { root } : {}), writer: { group: entry.group, name: writer } }, fn);
}
const pathInRow = (path, row) => row.paths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
/** Null when the table lets this writer write this path for this asking tool, else the reason it does not. */
function handoffProblem(list, writer, path, requester) {
  const entry = list.handoffs?.writers?.[writer.name];
  if (!entry || entry.group !== writer.group) return "writer is not in the handoffs table";
  const rows = (list.handoffs.rows ?? []).filter((r) => r.writer === writer.name && pathInRow(path, r));
  if (!rows.length) return `no handoffs row lets ${writer.name} write ${path}`;
  if (!rows.some((r) => r.requesters.includes(requester ?? ""))) return `${requester || "no asking tool"} is not a listed requester of ${writer.name} for ${path}`;
  // a requester kept in not_measured is a static inference no run has seen: it stays in the table, and is refused until a run measures it
  if (!rows.some((r) => r.requesters.includes(requester ?? "") && !(r.not_measured ?? []).includes(requester ?? ""))) return `${requester} is listed for ${writer.name} on ${path} but not measured yet (not_measured): refused until a run has seen it`;
  return null;
}
const currentWriter = () => store.getStore()?.writer ?? null;

// ---- review / draw split (NEWSROOM_REVIEW_SPLIT=1, K244) -----------------------------------------------------------------------
/** Only the exact value "1" turns the split on; anything else leaves every tool and record as it was. */
export const reviewSplitEnabled = () => process.env.NEWSROOM_REVIEW_SPLIT === "1";
const pathInReviewPrefixes = (path, table) => (table.review_path_prefixes ?? []).some((p) => path.startsWith(p));
/**
 * Null when the split is off or the write is fine, else {status, reason}. A draw tool may not write a review record (qa, critics, lints, previews,
 * preflight, preferences, award runs); a review tool may not unlink or write into rejected/ itself - the reject writer does that for it.
 * `requester` is the tool that asked (the tool itself, or the tool a hand-off writer writes for).
 */
export function reviewSplitProblem(list, requester, writerName, path, op = "write") {
  if (!reviewSplitEnabled()) return null;
  const table = list.review_split;
  if (!table || !requester) return null;
  if ((table.draw_tools ?? []).includes(requester) && pathInReviewPrefixes(path, table))
    return { status: "review_path_by_draw_tool", reason: `${requester} draws; ${path} is a review record, which only a review tool writes` };
  if ((table.review_tools ?? []).includes(requester) && writerName !== table.reject_writer && (op === "unlink" || op === "rename" || /(^|\/)rejected\//.test(path)))
    return { status: "draw_path_by_review_tool", reason: `${requester} reviews; ${op} ${path} changes a draw product, which ${table.reject_writer} does for a review tool` };
  return null;
}

// ---- per-call staging (NEWSROOM_AGENT=rust, 1011ah step 7a) -----------------------------------------------------------------------
// The Rust side opens <run>/staging/<callId>/ for each tool call and names it in the `go` message. Inside runInStagedCall, the four artifact write
// entry points in newsroom.ts write there instead of into the run folder (stagedWriteRoot); Rust judges the files after the call, with the same
// table, and only moves them in when every one passes. A call a tool starts itself (a chain, parallel tasks) gets its own sibling folder
// <staging>/<its callId>/ (withStagedCall), so its writes are judged as the inner tool's. Outside runInStagedCall nothing changes.
const stagingStore = new AsyncLocalStorage();
/** Layout under a call folder: <own | writer-NAME>/<write | append | once>/<run-relative path>. Fixed here and read back by src/staging.rs. */
export const STAGING_MODES = Object.freeze(["write", "append", "once"]);
/** Run fn as the call `callId` whose staging folder is `dir`; no folder, no staging (fn unchanged). */
export const runInStagedCall = (callId, dir, fn, counted = false) => (dir ? stagingStore.run({ callId: String(callId), dir: String(dir), counted: counted === true }, fn) : fn());
export const stagingActive = () => Boolean(stagingStore.getStore());
/** True inside a staged call whose Rust host counts the passed writes (go.counted): the report part of recordBoundaryWrite is then left to Rust, so no write is counted twice. */
export const countedByRust = () => stagingStore.getStore()?.counted === true;
/**
 * The folder a write inside a staged call goes to instead of `root`; `root` itself outside a staged call. The write mode and, inside a hand-off writer,
 * the writer's name are part of the folder, so Rust can tell a rewrite from an append and who was writing. A path that would leave the folder throws.
 */
export function stagedWriteRoot(root, rel, mode) {
  const ctx = stagingStore.getStore();
  if (!ctx) return root;
  if (!STAGING_MODES.includes(mode)) throw new Error(`boundary: unknown staging mode ${mode}`);
  const writer = currentWriter();
  const base = resolve(ctx.dir, writer ? `writer-${writer.name}` : "own", mode);
  const target = resolve(base, String(rel));
  if (target === base || !target.startsWith(base + sep)) throw new Error(`boundary: ${rel} leaves the call's staging folder`);
  return base;
}
// K241: the steps of a chain run one after the other inside one outer call, so a step must read what the steps before it staged. The chain (agent code)
// passes the tools it has already finished as a plain data object in the sixth argument of execute, { chainDone: [toolName, ...] }; the model's own
// parameters (the second argument) are never read for it. Only a staged call with a non-empty list of names gets any `seen`; anything else adds nothing.
const chainDoneSeen = (ctx, extra) => {
  const done = Array.isArray(extra?.chainDone) ? extra.chainDone.filter((tool) => typeof tool === "string" && tool) : [];
  return done.map((tool) => `${ctx.callId}:${tool}`);
};
/** Wraps a tool's execute: called inside another staged call under a different callId, the call gets its own staging folder next to the outer one. */
export function withStagedCall(tool) {
  if (!tool || typeof tool.execute !== "function") return tool;
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (...args) => {
      const ctx = stagingStore.getStore();
      const callId = String(args[0] ?? "");
      if (!ctx || !callId || callId === ctx.callId) return original(...args);
      const dir = join(dirname(ctx.dir), callId);
      mkdirSync(dir, { recursive: true });
      return stagingStore.run({ callId, dir, counted: ctx.counted, seen: [...(ctx.seen ?? []), ...chainDoneSeen(ctx, args[5])] }, () => original(...args));
    },
  };
}

/**
 * 1011ai step 7b. The call folders a read inside a staged call may see: the call's own, the ones of the calls that started it (callId prefixes) and the
 * ones of the calls it started itself (`<callId>:...`), outermost first. A parallel sibling's folder is never visible. The tools of one chain see each
 * other's writes today because everything is on disk at once; this keeps that, while the run folder stays untouched until the outer call is judged.
 */
function visibleFolders(ctx) {
  const root = dirname(ctx.dir);
  let names = [];
  try { names = readdirSync(root); } catch { return [ctx.dir]; }
  const mine = names.filter((n) => n === ctx.callId);
  const outer = names.filter((n) => ctx.callId.startsWith(`${n}:`)).sort((a, b) => a.length - b.length);
  const seen = (ctx.seen ?? []).filter((n) => names.includes(n) && n !== ctx.callId);
  const inner = names.filter((n) => n.startsWith(`${ctx.callId}:`)).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return [...outer, ...seen, ...mine, ...inner].map((n) => join(root, n));
}
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const journal = (folder) => {
  try { return readFileSync(join(folder, STAGING_OPS_FILE), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
};
export const STAGING_OPS_FILE = "ops.jsonl";
export const STAGING_REPORT_FILE = "report.jsonl";
/** A boundary-report record Node worked out inside a counted staged call, left for Rust (one JSON line in the call folder). */
function handToRust(line) {
  const ctx = stagingStore.getStore();
  if (!ctx) return;
  mkdirSync(ctx.dir, { recursive: true });
  appendFileSync(join(ctx.dir, STAGING_REPORT_FILE), JSON.stringify(line) + "\n", "utf8");
}
/**
 * The bytes a read of run-relative `rel` should see inside a staged call: a staged rewrite or first write replaces the run folder's file, staged appends
 * go after it (after the run folder's content when nothing was rewritten), outermost call first and the latest folder winning. Resolves null when
 * nothing is staged for `rel` (the caller reads the run folder as before). A path this call deleted or renamed away rejects with ENOENT, as the file
 * would be gone. `readBase()` reads the run folder's file. Outside a staged call: always null.
 */
export async function readThroughStaging(rel, readBase) {
  const ctx = stagingStore.getStore();
  if (!ctx) return null;
  const path = String(rel).replace(/\\/g, "/");
  let replaced = null;
  const appended = [];
  let gone = false;
  for (const folder of visibleFolders(ctx)) {
    for (const op of journal(folder)) {
      if (op.op === "unlink" ? op.from === path : op.op === "rename" && (op.from === path || path.startsWith(`${op.from}/`))) { gone = true; replaced = null; appended.length = 0; }
    }
    let whos = [];
    try { whos = readdirSync(folder).filter((n) => n === "own" || n.startsWith("writer-")); } catch {}
    for (const who of whos) {
      for (const mode of ["write", "once"]) {
        const file = join(folder, who, mode, path);
        if (isFile(file)) { replaced = readFileSync(file); gone = false; }
      }
      const part = join(folder, who, "append", path);
      if (isFile(part)) appended.push(readFileSync(part));
    }
  }
  if (replaced === null && appended.length === 0) {
    if (gone) throw Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), { code: "ENOENT" });
    return null;
  }
  let base = replaced;
  if (base === null) {
    try { base = await readBase(); } catch (error) { if (error?.code !== "ENOENT") throw error; base = Buffer.alloc(0); }
  }
  return Buffer.concat([base, ...appended]);
}
/**
 * 1012h: the staged file a read of run-relative `rel` should see, as an absolute path, for a reader that is another process and cannot go through
 * readThroughStaging (DuckDB). The latest visible staged rewrite or first write of a whole file; null outside a staged call, when nothing is staged,
 * or when the call deleted or renamed it away. Appends are never returned (a partial file is not a file to read).
 */
export function stagedFilePath(rel) {
  const ctx = stagingStore.getStore();
  if (!ctx) return null;
  const path = String(rel).replace(/\\/g, "/");
  let found = null;
  for (const folder of visibleFolders(ctx)) {
    for (const op of journal(folder)) {
      if (op.op === "unlink" ? op.from === path : op.op === "rename" && (op.from === path || path.startsWith(`${op.from}/`))) found = null;
    }
    let whos = [];
    try { whos = readdirSync(folder).filter((n) => n === "own" || n.startsWith("writer-")); } catch {}
    for (const who of whos) for (const mode of ["write", "once"]) {
      const file = join(folder, who, mode, path);
      if (isFile(file)) found = file;
    }
  }
  return found;
}
/**
 * 1011ai step 7b: the three protocol operations (a delete, a rename of a file or a folder) inside a staged call are handed to Rust instead of being done
 * here: one JSON line {op, from, to?} in the call folder's ops.jsonl, run-relative paths. Rust judges the destination (the path itself for a delete),
 * runs the operation before it moves the call's files in, or refuses. True when handed over; false outside a staged call (the caller does it).
 */
export function stageOp(op, from, to) {
  const ctx = stagingStore.getStore();
  if (!ctx) return false;
  if (op !== "unlink" && op !== "rename") throw new Error(`boundary: unknown staged operation ${op}`);
  const clean = (value) => {
    const text = String(value ?? "").replace(/\\/g, "/");
    if (!text || isAbsolute(text) || text.split("/").some((part) => part === ".." || part === "")) throw new Error(`boundary: ${text || "(empty)"} is not a run-relative path`);
    return text;
  };
  const line = op === "unlink" ? { op, from: clean(from) } : { op, from: clean(from), to: clean(to) };
  mkdirSync(ctx.dir, { recursive: true });
  appendFileSync(join(ctx.dir, STAGING_OPS_FILE), JSON.stringify(line) + "\n", "utf8");
  return true;
}

/** Wraps a tool's execute so its writes know who initiated them. Only called with the report or the refusal switch on. */
export function withBoundaryContext(tool) {
  if (!tool || typeof tool.execute !== "function") return tool;
  const original = tool.execute.bind(tool);
  return { ...tool, execute: (...args) => runInTool(tool.name, () => original(...args)) };
}

let state = null; // { root, records: Map, writes }
const keyOf = (r) => [r.tool, r.requested_by ?? "", r.op, r.kind, r.status, r.reason].join("|");

const reportMtime = (root) => { try { return statSync(join(root, BOUNDARY_REPORT_PATH)).mtimeMs; } catch { return 0; } };
function load(root) {
  // Rust adds its own counts to the same file between two of ours (1011ai 7b), so a copy kept in memory is reread when the file changed since we last wrote it
  if (state?.root === root && state.mtime === reportMtime(root)) return state;
  state = { root, records: new Map(), writes: 0, mtime: 0 };
  try {
    const previous = JSON.parse(readFileSync(join(root, BOUNDARY_REPORT_PATH), "utf8"));
    for (const record of previous.records ?? []) { state.records.set(keyOf({ ...record, reason: record.reason ?? "" }), record); state.writes += record.count ?? 0; }
  } catch {}
  state.mtime = reportMtime(root);
  return state;
}

export function resetBoundaryReport() { state = null; }

function writeReport(root) {
  const records = [...state.records.values()];
  const count = (status) => records.filter((r) => r.status === status).reduce((sum, r) => sum + r.count, 0);
  const totals = { writes: state.writes, ok: count("ok"), cross_group: count("cross_group"), to_check: count("待查") };
  // only present once a write was handed to a group's own writer (NEWSROOM_GROUP_HANDOFF=1)
  const handedTo = (group) => records.filter((r) => r.requested_by !== undefined && r.tool_group === group).reduce((sum, r) => sum + r.count, 0);
  if (handedTo("knowledge")) totals.handed_to_knowledge = handedTo("knowledge");
  if (handedTo("agent")) totals.handed_to_agent = handedTo("agent");
  const notListed = count("handoff_not_listed");
  if (notListed) totals.handoff_not_listed = notListed;
  const verdicts = count("model_quality_verdict");
  if (verdicts) totals.model_quality_verdict = verdicts;
  const modelPasses = count("model_supplied_pass");
  if (modelPasses) totals.model_supplied_pass = modelPasses;
  const report = {
    schema_version: "0.1.0",
    mode: "report",
    summary: `${totals.writes} writes seen: ${totals.ok} in the owning group, ${totals.cross_group} cross-group, ${totals.to_check} 待查 (could not be classified)${verdicts ? `, ${verdicts} model quality verdict (listed apart, not counted as fixed)` : ""}${modelPasses ? `, ${modelPasses} with a model-supplied pass (listed apart, not counted as fine)` : ""}. Report only; not_traced lists what this report cannot see.`,
    totals,
    complete: false,
    note: (() => { try { return loadGroups().boundary_report?.note ?? ""; } catch { return ""; } })(),
    ownership: OWNERSHIP,
    records,
    not_traced: NOT_TRACED,
  };
  const path = join(root, BOUNDARY_REPORT_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  state.mtime = reportMtime(root);
}

// ---- classification shared by the report and the refusal -------------------------------------------------------------------------
/** Who is writing, which kind of artifact it is and whether the writer's group owns it. `lookup` supplies the group list and the path classifier. */
function evaluateWrite(root, target, lookup = { groups: loadGroups, classify: classifyArtifact }, op = "write") {
  const text = String(target ?? "");
  const path = (isAbsolute(text) ? relative(root, text) : text).replace(/\\/g, "/");
  const writer = currentWriter();
  const requestedBy = writer ? (currentTool() || null) : null;
  const tool = writer ? writer.name : currentTool();
  const list = lookup.groups();
  const group = writer ? writer.group : tool ? list.tools?.[tool]?.group ?? null : null;
  const classified = lookup.classify(path);
  let status, reason = "";
  if (!tool) { status = "待查"; reason = "no initiating tool"; }
  else if (!group) { status = "待查"; reason = "tool is not in groups.json"; }
  else if (!classified) { status = "待查"; reason = "path matches no artifact kind"; }
  else status = group === classified.owner ? "ok" : "cross_group";
  let allowed = Boolean(tool && group && classified && group === classified.owner);
  if (allowed && writer) {
    const problem = handoffProblem(list, writer, path, requestedBy);
    if (problem) { allowed = false; status = "handoff_not_listed"; reason = problem; }
  }
  const split = reviewSplitProblem(list, writer ? requestedBy : tool, writer?.name ?? null, path, op);
  if (split) { allowed = false; status = split.status; reason = split.reason; }
  return { path, writer, requestedBy, tool, group, classified, status, reason, allowed, list };
}

// ---- refusing (NEWSROOM_GROUP_ENFORCE=1) ---------------------------------------------------------------------------------------
export class BoundaryRefusal extends Error {
  constructor(message, detail) { super(message); this.name = "BoundaryRefusal"; this.code = "BOUNDARY_REFUSED"; this.detail = detail; }
}
export const ENFORCE_LIMIT_MS = 250;
export const REFUSAL_LOG_PATH = "runtime/boundary-refusals.jsonl";

// Test-only seams: the group-list read, the classifier, the decision and the clock. Nothing but a test sets them.
const hooks = { groups: loadGroups, classify: classifyArtifact, decide: null, now: () => performance.now() };
export function __setEnforceHooksForTest(next) {
  const before = { ...hooks };
  Object.assign(hooks, next);
  return () => Object.assign(hooks, before);
}

/** Null when the calling tool's group may reach `name` (a knowledge entry function listed in groups.json cross_calls.gated), else the reason it may not. */
export function crossCallProblem(list, name, tool, refuse = false, noTool = false, all = false) {
  const table = list.cross_calls;
  const gated = Boolean(table?.gated?.includes(name));
  // K381 (refuse only): the class-B rows (tool_pin) are judged like the gated names, and a gated name with a tool_allow list is judged per tool
  const pin = refuse ? table?.tool_pin?.[name] : null;
  // #66 step 2 (REFUSE_ALL only): any other name with a row is judged against that row, the same test the call record uses for `declared`
  const entry = all && !gated && !pin ? crossCallEntry(list, name) : null;
  const rowOnly = Boolean(entry?.row);
  if (!gated && !pin && !rowOnly) return null;
  if (!tool) return noTool && !rowOnly ? `${name} was called with no asking tool` : null; // no tool is asking: a command or the program itself (refused only with NOTOOL; a row-only name never)
  const group = list.tools?.[tool]?.group ?? null;
  if (gated && group !== "knowledge") {
    if (!group) return `${tool} has no group in groups.json`;
    if (!(table.functions?.[name]?.groups ?? []).includes(group)) return `${tool} (${group}) is not listed in cross_calls for ${name}`;
    const allow = refuse ? table.tool_allow?.[name] : null;
    if (allow && !(allow.tools ?? []).includes(tool)) return `${tool} (${group}) is not on the tool_allow list of ${name}`;
  }
  if (pin && group !== pin.owner) {
    if (!group) return `${tool} has no group in groups.json`;
    if (!(pin.tools ?? []).includes(tool) && !(pin.runtime_only ?? []).includes(tool)) return `${tool} (${group}) is not on the tool_pin row of ${name}`;
  }
  if (rowOnly) {
    if (!group) return `${tool} has no group in groups.json`;
    if (!(group === entry.owner || entry.groups.includes(group))) return `${tool} (${group}) is not listed in cross_calls for ${name}`;
  }
  return null;
}
/** NEWSROOM_GROUP_ENFORCE=1: called first thing in a gated knowledge function. Same group passes, a listed group passes, anything else is refused and logged. */
export function assertCrossCall(root, name) {
  noteCrossCall(root, name);
  if (!groupEnforceEnabled()) return;
  let problem = null;
  const tool = currentTool();
  const all = callRefuseAllEnabled();
  const refuse = callRefuseEnabled() || all;
  const noTool = refuse && callRefuseNoToolEnabled() && callRoot() !== null;
  try { problem = crossCallProblem(hooks.groups(), name, tool, refuse, noTool, all); } catch { problem = "the group list cannot be read"; }
  if (!problem) return;
  const info = { tool: tool ?? null, group: toolGroup(tool), path: name, kind: "cross_call", owner: "knowledge", writer: null, status: noTool && !tool ? "cross_call_no_tool" : "cross_call_not_listed", reason: problem };
  const logRoot = root || (refuse ? callRoot() : null);
  if (logRoot) noteRefusal(logRoot, { op: "cross_call", ...info });
  throw new BoundaryRefusal(`boundary: ${tool || "unknown tool"}（${info.group || "unknown group"}）may not call ${name}: ${problem}. Ask a knowledge tool, or have fe list the call in groups.json cross_calls.`, info);
}

export const CALL_REPORT_PATH = "runtime/cross-call-report.jsonl";
const noted = new Set();
let noting = false; // the record's own lookups may reach a wrapped export (groups.mjs wraps its own): those are not recorded
/**
 * What the table says about a name. A plain name is a newsroom.ts function (cross_calls.functions; gated = knowledge-owned). A `module::name` key (K315) is an
 * exported function of another module: cross_calls.imported (what newsroom.ts reaches) and cross_calls.modules (what other modules reach) are read together.
 * Returns {row, owner, groups}; row null = not in the table.
 */
export function crossCallEntry(list, name) {
  const table = list.cross_calls ?? {};
  if (String(name).includes("::")) {
    const rows = [table.imported?.[name], table.modules?.[name]].filter(Boolean);
    if (!rows.length) return { row: null, owner: null, groups: [] };
    return { row: rows[0], owner: rows[0].owner ?? null, groups: [...new Set(rows.flatMap((r) => r.groups ?? []))] };
  }
  const row = table.functions?.[name];
  return { row: row ?? null, owner: table.gated?.includes(name) ? "knowledge" : null, groups: row?.groups ?? [] };
}
/**
 * NEWSROOM_GROUP_CALL_REPORT (default on; off only when exactly "0"): one line per (tool, function) pair seen in this process: {tool, tool_group, function, declared}. Never refuses, never throws,
 * never changes a reply; a tool-less call (a command or the program itself) is not recorded. `declared` = the calling group is listed in cross_calls for the
 * function, or the function is not in the table at all (null = not in the table). K321: `tool_allowed` (only for a function with a cross_calls.tool_allow list).
 */
export function noteCrossCall(root, name) {
  if (!crossCallReportEnabled() || noting) return;
  noting = true;
  try {
    const check = callCheckEnabled();
    const tool = currentTool();
    // K366: with the check on a call with no asking tool is recorded too (requester none), and the run folder may come from the environment
    if (!tool && !check) return;
    const rootNow = root || (check ? callRoot() : null);
    if (!rootNow) return;
    const key = `${rootNow}\u0000${tool ?? ""}\u0000${name}`;
    if (noted.has(key)) return;
    noted.add(key);
    const list = hooks.groups();
    const group = tool ? list.tools?.[tool]?.group ?? null : null;
    const { row, owner, groups } = crossCallEntry(list, name);
    const path = join(rootNow, CALL_REPORT_PATH);
    mkdirSync(dirname(path), { recursive: true });
    // K366: a call with no asking tool is one fixed line (requester none); it goes through the same single append below
    let line;
    if (!tool) line = { tool: null, tool_group: null, requester: "none", function: name, callee_owner: owner, declared: null };
    else {
      let declared = !row ? null : group === owner || groups.includes(group);
      // K321: for a function with a per-tool list (cross_calls.tool_allow) the line also says whether this tool is on it (a tool of the owning group always is). Report only.
      const allow = list.cross_calls?.tool_allow?.[name];
      line = { tool, tool_group: group, function: name, callee_owner: owner, declared };
      if (allow) line.tool_allowed = group === owner || (allow.tools ?? []).includes(tool);
      // K366: the class-B rows (cross_calls.tool_pin) the same way; a tool off its row makes the call undeclared. Only with the check on.
      const pin = check ? list.cross_calls?.tool_pin?.[name] : null;
      if (pin) line.tool_allowed = group === pin.owner || (pin.tools ?? []).includes(tool) || (pin.runtime_only ?? []).includes(tool);
      if (check && line.tool_allowed === false) { declared = false; line.declared = false; }
    }
    appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
  } catch { /* report only */ } finally { noting = false; }
}
/** NEWSROOM_GROUP_CALL_REPORT off: returns fn itself (same value, nothing wrapped). On: a function with the same arguments and result that notes the call first. */
export function trackCrossCall(name, fn, rootOf) {
  if (!crossCallReportEnabled() || typeof fn !== "function") return fn;
  if (!callRefuseEnabled() && !callRefuseAllEnabled()) return function tracked(...args) { noteCrossCall(rootOf(), name); return fn.apply(this, args); };
  // K381: with the refusal on the wrap notes the call (first) and then judges it; an async function gets a rejection, a plain one a throw
  const isAsync = fn.constructor?.name === "AsyncFunction";
  return function tracked(...args) {
    try { assertCrossCall(rootOf(), name); } catch (error) { if (isAsync) return Promise.reject(error); throw error; }
    return fn.apply(this, args);
  };
}
/** K315: the same wrap for a function exported from another module, keyed `module::name` (path relative to runtime/pi); the run folder comes from the tool's context. */
export const trackExport = (key, fn) => trackCrossCall(key, fn, currentRoot);

const WRITER_FOR_KIND = { evidence: "knowledge_writer", observation: "shadow_writer", pass_decision: "decision_writer", project_state: "agent_record_writer" };
/** The refusal text. Fixed shape: tool, its group, the path, its kind and owning group, the writer to hand the record to. Nothing else. */
export function refusalText({ tool, group, path, kind, owner, writer }) {
  return `boundary: ${tool || "unknown tool"}（${group || "unknown group"}）may not write ${path}（${kind || "unclassified"}, owner ${owner || "none"}）. Use ${writer || "no writer: the path has no owning group yet"}.`;
}

function noteRefusal(root, entry) {
  try {
    const path = join(root, REFUSAL_LOG_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {}
}

/**
 * Called before a write reaches the disk. With the switch off it does nothing. With it on, anything but a clear "this group owns this path" throws
 * BoundaryRefusal: a cross-group write, a path that cannot be classified, a check that throws, a group list that cannot be read, no root, or a check
 * that ran past ENFORCE_LIMIT_MS. This function has no catch that lets a write through.
 */
function enforceBoundary(root, target, op) {
  if (!groupEnforceEnabled()) return;
  let path = String(target ?? "");
  let info = { tool: null, group: null, path, kind: null, owner: null, writer: null, status: "check_failed" };
  try {
    if (!root) throw new Error("no artifact root");
    const started = hooks.now();
    const verdict = hooks.decide ? hooks.decide(root, target, op) : evaluateWrite(root, target, { groups: hooks.groups, classify: hooks.classify }, op);
    if (!(hooks.now() - started <= ENFORCE_LIMIT_MS)) throw new Error("check too slow");
    path = verdict.path ?? path;
    info = { tool: verdict.tool, group: verdict.group, path, kind: verdict.classified?.kind ?? null, owner: verdict.classified?.owner ?? null, writer: null, status: verdict.status, ...(verdict.reason ? { reason: verdict.reason } : {}) };
    if (verdict.allowed === true) return;
    info.writer = verdict.classified ? WRITER_FOR_KIND[verdict.classified.kind] ?? null : null;
  } catch {
    info.status = "check_failed";
  }
  if (root) noteRefusal(root, { op, ...info });
  throw new BoundaryRefusal(refusalText(info), info);
}

/**
 * Called at every artifact write site, before the write. With NEWSROOM_GROUP_ENFORCE=1 it may throw BoundaryRefusal (nothing is written);
 * with NEWSROOM_GROUP_BOUNDARY=1 it records the call in the report. The report part never throws and never touches the write itself.
 */
export function recordBoundaryWrite(root, target, op = "write", opts = {}) {
  enforceBoundary(root, target, op);
  noteCallWrite(root, target);
  // in a staged call whose Rust host counts passed writes (1011ai 7b) the report part is Rust's, so the same write is not counted twice
  if (opts?.countedByRust === true && countedByRust()) return;
  if (!boundaryReportEnabled() || !root) return;
  try {
    const evaluated = evaluateWrite(root, target);
    const { path, writer, requestedBy, tool, group, classified, list } = evaluated;
    let { status, reason } = evaluated;
    // A decision record the model's own quality verdict is stored in (the vision critic) is listed in its own category with the reason from groups.json,
    // outside the ok and cross-group counts, whether the tool wrote it itself or the agent group's writer saved it for the tool (requested_by).
    const requester = writer ? requestedBy : tool;
    const verdictTool = (status === "cross_group" || status === "ok") && classified?.kind === "pass_decision" && list.tools?.[requester]?.model_quality_verdict ? list.tools[requester] : null;
    if (verdictTool) { status = "model_quality_verdict"; reason = verdictTool.verdict_reason ?? ""; }
    // A decision record whose status the model supplies is never counted as fine, whoever wrote the file. With NEWSROOM_GROUP_REVIEW_FROM_RECORDS=1 its
    // status is computed by the program from its own records and the record is tagged so; otherwise it is tagged model_supplied_pass, and when a group
    // writer saved it (so it would read ok) it is listed apart as model_supplied_pass, not ok.
    let tag = null;
    if ((status === "cross_group" || status === "ok") && classified?.kind === "pass_decision" && list.tools?.[requester]?.model_supplied_pass) {
      tag = (process.env.NEWSROOM_GROUP_REVIEW_FROM_RECORDS === "1" || process.env.NEWSROOM_MODEL_PASS_SELFREPORT === "1") ? "status_computed_by_program" : "model_supplied_pass";
      if (status === "ok" && tag === "model_supplied_pass") { status = "model_supplied_pass"; reason = "The status in this record is supplied by the model; writing the file through the owning group does not make it fine."; }
    }
    const record = { tool: tool ?? null, ...(writer ? { requested_by: requestedBy } : {}), tool_group: group, op, kind: classified?.kind ?? null, owner: classified?.owner ?? null, status, ...(reason ? { reason } : {}), count: 0, examples: [] };
    // 1011aj step 8: in a staged call whose Rust host counts (go.counted) the report file is Rust's alone: this record goes into the call folder
    // (report.jsonl, one line per write) and Rust adds it to the report when the call finishes. Node never writes the file there.
    if (countedByRust()) {
      const known = status === "cross_group" ? knownTag(path, classified.kind) : null;
      handToRust({ ...record, count: undefined, examples: undefined, path, ...(known ? { known } : {}), ...(tag ? { tag } : {}) });
      return;
    }
    const current = load(root);
    const key = keyOf({ ...record, reason });
    const entry = current.records.get(key) ?? record;
    entry.count += 1;
    if (entry.examples.length < 5 && !entry.examples.includes(path)) entry.examples.push(path);
    if (status === "cross_group") {
      const known = knownTag(path, classified.kind);
      if (known) entry.known = known;
    }
    if (tag) entry[tag] = true;
    current.records.set(key, entry);
    current.writes += 1;
    writeReport(root);
  } catch {}
}

// ---- tools under the groups (NEWSROOM_GROUP_TOOLS, on unless exactly "0") ---------------------------------------------------------------------------
/** E1, fixed and pinned by test_group_tools: temp names the program itself makes and removes. Nothing else is skipped by the after-writing check. */
export const E1_TEMP_SUFFIXES = Object.freeze([".tmp", ".write-tmp"]);
export const E1_TEMP_FOLDERS = Object.freeze(["runtime/preview-tmp/"]);
export const TOOLS_REFUSAL_CODE = "GROUP_TOOLS_REFUSED";

const checkedTools = new WeakSet();
export const isGroupChecked = (tool) => checkedTools.has(tool);
let inFlight = 0, overlaps = 0;

// Which call wrote which file. Every tool call (and every runDeclared outside a tool) is one "call"; a judged write (recordBoundaryWrite, which runs before the
// file is written) is noted under the call it was made in, and when that call ends the noted files are hashed (the content the call left behind). Calls that
// were in flight at the same time know each other's notes, so runDeclared can tell a file a sibling call wrote from one its own child process wrote: a file
// counts as the sibling's only while its content is still what the sibling left (an ended sibling's hash must match; if somebody changed it afterwards the
// change is this call's). A sibling that has not ended yet cannot be checked: its notes are accepted as they are (the gap is listed in the report).
// Nothing here lets a write through: a file nobody noted is still refused.
const callStore = new AsyncLocalStorage();
const activeCalls = new Set();
let callSeq = 0;
function startCall() {
  const call = { id: ++callSeq, root: null, notes: new Map(), done: false, overlap: new Map() };
  for (const other of activeCalls) { other.overlap.set(call.id, call); call.overlap.set(other.id, other); }
  activeCalls.add(call);
  return call;
}
function finishCall(call) {
  for (const [path, note] of call.notes) note.hash = hashOf(join(call.root, path));
  call.done = true;
  activeCalls.delete(call);
}
// A wrapped tool call always starts a new call, even when another tool's execute runs inside it (a chain, a parallel task): a write made there is that
// call's own, not the caller's child process's. runDeclared joins the call it is in, or starts one when it runs outside any tool.
const runInCall = async (fn, { join: joinExisting = false } = {}) => {
  if (joinExisting && callStore.getStore()) return fn();
  const call = startCall();
  try { return await callStore.run(call, fn); } finally { finishCall(call); }
};
function noteCallWrite(root, target) {
  if (!groupToolsEnabled() || !root) return;
  const call = callStore.getStore();
  if (!call) return;
  const text = String(target ?? "");
  call.root = root;
  const path = (isAbsolute(text) ? relative(root, text) : text).replace(/\\/g, "/");
  call.notes.set(path, { hash: null });
}

/** Start-up check: the switch needs the refusal switch (and, through it, the hand-off). */
export function assertGroupToolsSwitches() {
  if (callRefuseEnabled() && process.env.NEWSROOM_GROUP_CALL_REPORT === "0") throw new Error("GROUP_CALL_REFUSE_NEEDS_REPORT: refusing a call off its tool list needs the call record, so NEWSROOM_GROUP_CALL_REPORT=0 must be removed (or NEWSROOM_GROUP_CALL_REFUSE=1 removed)");
  if (process.env.NEWSROOM_GROUP_TOOLS === "1" && !groupEnforceEnabled()) throw new Error("GROUP_TOOLS_NEEDS_ENFORCE: checking each tool against its group only works with the refusal of cross-group writes on");
  if (groupToolsHashAllEnabled() && !groupToolsEnabled()) throw new Error("GROUP_TOOLS_HASH_ALL_NEEDS_TOOLS: hashing every watched file only works with the per-tool check (NEWSROOM_GROUP_TOOLS) on");
  if (callRefuseNoToolEnabled() && !callRefuseEnabled() && !callRefuseAllEnabled()) throw new Error("GROUP_CALL_REFUSE_NOTOOL_NEEDS_REFUSE: refusing a call with no asking tool only works with NEWSROOM_GROUP_CALL_REFUSE (or CALL_REFUSE_ALL) on");
  if (callRefuseEnabled() && !(groupEnforceEnabled() && callCheckEnabled())) throw new Error("GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK: refusing a call off its tool list only works with the refusal on (ENFORCE) and the call record on (CALL_CHECK), so every refused call is recorded first");
  if (callRefuseAllEnabled() && !(groupEnforceEnabled() && callCheckEnabled())) throw new Error("GROUP_CALL_REFUSE_ALL_NEEDS_ENFORCE_AND_CHECK: refusing every call off its row only works with the refusal on (ENFORCE) and the call record on (CALL_CHECK), so every refused call is recorded first");
}

/** The tool's group and group.action name from groups.json, or throws: an unknown tool or a row without registered_as is never registered. */
export function assertToolRegistered(name) {
  const row = loadGroups().tools?.[String(name ?? "")];
  if (!row || !GROUP_ORDER.includes(row.group) || typeof row.registered_as !== "string" || row.registered_as !== `${row.group}.${String(name).replace(/^newsroom_/, "")}`) {
    throw new Error(`GROUP_TOOLS_UNREGISTERED: ${JSON.stringify(String(name ?? ""))} has no group.action entry in groups.json, so it is not registered`);
  }
  return row;
}

/** The one wrapper at the registration point: the tool must be listed, its writes know who started them (same context as the boundary report and the
 *  refusal, nothing parallel), and it is marked as checked. Chains calling this tool's execute keep the same context. */
export function withGroupTools(tool) {
  assertToolRegistered(tool?.name);
  const inner = withBoundaryContext(tool);
  const wrapped = typeof inner.execute !== "function" ? { ...inner } : {
    ...inner,
    execute: async (...args) => {
      if (inFlight > 0) overlaps += 1;
      inFlight += 1;
      try { return await runInCall(() => inner.execute(...args)); } finally { inFlight -= 1; }
    },
  };
  checkedTools.add(wrapped);
  return wrapped;
}

/** After registration: every tool handed to Pi must be one the wrapper made. A tool that bypassed it stops the start-up. */
export function assertAllGroupChecked(tools) {
  for (const tool of tools) if (!isGroupChecked(tool)) throw new Error(`GROUP_TOOLS_UNWRAPPED: ${JSON.stringify(String(tool?.name ?? ""))} reached Pi without going through the group check`);
}

/**
 * Every file under dir, recursively, as Map(path relative to dir -> { size, mtimeMs, hash }); null when dir cannot be read. The watched folders are
 * small. `hash` (sha256) is only taken for files the classifier calls evidence (their content is what the run is proven on); every other file is judged
 * by size and modification time. `base` is dir's own path relative to the run folder, so the classifier sees run-relative names.
 */
const listFiles = (root, base, prefix = "") => {
  const hashAll = groupToolsHashAllEnabled();
  const dir = join(root, base === "." ? "" : base, prefix);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return prefix ? new Map() : null; }
  const out = new Map();
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { for (const [inner, info] of listFiles(root, base, name) ?? []) out.set(inner, info); continue; }
    let stat;
    try { stat = lstatSync(join(dir, entry.name)); } catch { out.set(name, { size: -1, mtimeMs: -1, hash: null }); continue; }
    // K381: `full` is the content hash of any file (HASH_ALL only, size-capped); it only adds a way to see a change, `hash` and the size/time rule are as before
    const full = hashAll && stat.size <= HASH_ALL_MAX_BYTES ? hashOf(join(dir, entry.name)) : null;
    out.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, hash: isEvidencePath(base === "." ? name : `${base}/${name}`) ? hashOf(join(dir, entry.name)) : null, full });
  }
  return out;
};
const hashOf = (path) => { try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; } };
const isEvidencePath = (rel) => { try { return classifyArtifact(rel)?.kind === "evidence"; } catch { return false; } };
const isE1Temp = (rel) => E1_TEMP_SUFFIXES.some((suffix) => rel.endsWith(suffix)) || E1_TEMP_FOLDERS.some((folder) => rel.startsWith(folder));

/** The program's own bookkeeping: files it appends to or rewrites while a tool runs. A child process's change to one of these is not judged (pinned by test_group_tools;
 *  every entry was found in groups.json or in the writer's source, an entry missing here would be a false refusal, an entry too many a hole). Only changes and
 *  removals are exempt, a NEW file of this name is still judged. */
export const BOOKKEEPING_FILES = Object.freeze([
  "events.jsonl", "run-metrics.jsonl", "conversation.md", "plan-progress.json",
  "runtime/group-boundary-report.json", "runtime/boundary-refusals.jsonl", "runtime/tool-chain-events.jsonl", "runtime/cross-call-report.jsonl",
]);
export const BOOKKEEPING_FOLDERS = Object.freeze(["session/"]);
const isBookkeeping = (rel) => BOOKKEEPING_FILES.includes(rel) || BOOKKEEPING_FOLDERS.some((folder) => rel.startsWith(folder));

/** Record only (NEWSROOM_GROUP_EXEMPT_RECORD, exactly "1", default off): a write that skips the judgement because of an exemption is appended to the call report as one
 *  {kind:"exempt_write"} row (path, which exemption, side). It never judges, refuses or changes a write, and a failure to record is swallowed. Off: nothing is read or written. */
export const exemptRecordEnabled = () => process.env.NEWSROOM_GROUP_EXEMPT_RECORD === "1";
export const exemptionOf = (rel) => (E1_TEMP_FOLDERS.some((folder) => rel.startsWith(folder)) ? "preview_tmp"
  : E1_TEMP_SUFFIXES.some((suffix) => rel.endsWith(suffix)) ? "temp_suffix"
  : BOOKKEEPING_FOLDERS.some((folder) => rel.startsWith(folder)) ? "session_folder"
  : BOOKKEEPING_FILES.includes(rel) ? "bookkeeping_file" : null);
const exemptNoted = new Set();
function noteExempt(root, path, op) {
  if (!exemptRecordEnabled() || !root || path === CALL_REPORT_PATH) return;
  try {
    const exemption = exemptionOf(path);
    if (!exemption) return;
    const tool = currentTool() ?? null;
    const key = `${root}\u0000${tool ?? ""}\u0000${path}\u0000${exemption}\u0000${op}`;
    if (exemptNoted.has(key)) return;
    exemptNoted.add(key);
    const file = join(root, CALL_REPORT_PATH);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ kind: "exempt_write", side: "js", tool, path, exemption, op })}\n`);
  } catch {}
}

/**
 * Run a child process that writes files, for a tool. `outputs` (artifact-relative paths) are declared before it starts: each is judged now like an
 * in-process write (a refusal here means the process never starts). `watch` (default: the folders of the outputs, or the run folder itself when nothing
 * is declared) is compared before and after, recursively: a new file that was not declared is deleted and the call is refused; a file that already existed
 * and was rewritten (size or time changed; evidence files by content hash) or removed is refused and reported as not restored (nothing can bring the old
 * content back). The program's bookkeeping files (BOOKKEEPING_FILES) may change. A file another tool call that ran at the same time wrote (its judged write
 * was noted under that call) is that call's, not this child process's. A file nobody noted is still this call's: if another call ran at the same time the
 * file cannot be told from its unjudged writes, so it is reported and refused but not deleted. Off: fn() unchanged.
 */
export async function runDeclared(root, outputs, fn, { watch } = {}) {
  if (!groupToolsEnabled()) return fn();
  return runInCall(() => runDeclaredInCall(root, outputs, fn, { watch }), { join: true });
}

async function runDeclaredInCall(root, outputs, fn, { watch }) {
  if (!root) throw new BoundaryRefusal(refusalText({ tool: currentTool(), path: "(no artifact root)" }), { status: "check_failed" });
  const rel = (p) => (isAbsolute(String(p)) ? relative(root, String(p)) : String(p)).replace(/\\/g, "/");
  const declared = new Set(outputs.map(rel));
  for (const path of declared) {
    if (!E1_TEMP_FOLDERS.some((folder) => path.startsWith(folder))) recordBoundaryWrite(root, path, "subprocess_output");
    else noteExempt(root, path, "declared");
  }
  const dirs = new Set((watch ?? (declared.size ? [...declared].map((p) => dirname(p)) : ["."])).map((d) => rel(d) || "."));
  const before = new Map([...dirs].map((d) => [d, listFiles(root, d)]));
  const overlapsBefore = overlaps;
  const me = callStore.getStore();
  let failure = null, value;
  try { value = await fn(); } catch (error) { failure = error; }
  const overlapped = inFlight > 1 || overlaps !== overlapsBefore;
  // a file a call that ran at the same time noted as its own write belongs to that call
  const siblingWrote = (path) => {
    for (const other of me?.overlap.values() ?? []) {
      const note = other.notes.get(path);
      if (!note || other.root !== root) continue;
      // the sibling has not ended: what it left cannot be compared yet. Ended: the file must still be what it left.
      if (!other.done || (note.hash !== null && hashOf(join(root, path)) === note.hash)) return true;
    }
    return false;
  };
  const exempt = (path) => declared.has(path) || isE1Temp(path) || siblingWrote(path);
  const extra = [], changed = [], deleted = [];
  const seen = new Set();
  const priorTo = (dir, name, path) => before.get(dir)?.get(name) ?? [...dirs].map((d) => {
    // the same file can be reached from two watched folders ("." and "data"): a file already present before under any watched folder is not new
    const rest = d === "." ? path : path.startsWith(`${d}/`) ? path.slice(d.length + 1) : null;
    return rest === null ? undefined : before.get(d)?.get(rest);
  }).find((x) => x !== undefined);
  for (const dir of dirs) {
    const now = listFiles(root, dir);
    if (!now) continue;
    for (const [name, info] of now) {
      const path = dir === "." ? name : `${dir}/${name}`;
      if (seen.has(path)) continue;
      const prior = priorTo(dir, name, path);
      if (!prior) {
        if (exempt(path)) { if (isE1Temp(path) && !declared.has(path)) noteExempt(root, path, "new"); continue; }
        seen.add(path); extra.push(path); continue;
      }
      const moved = prior.size !== info.size || prior.mtimeMs !== info.mtimeMs;
      if (isBookkeeping(path) || exempt(path)) {
        if (moved && (isBookkeeping(path) || (isE1Temp(path) && !declared.has(path)))) noteExempt(root, path, "change");
        continue;
      }
      // evidence: judged by content, so a rewrite with the same bytes is not a change; every other file: any size or time change is a rewrite
      let differs = prior.hash !== null ? prior.hash !== info.hash : moved;
      // K381 (HASH_ALL): the same size and time but other bytes is a rewrite too
      if (!differs && prior.full && info.full && prior.full !== info.full) differs = true;
      if (differs) { seen.add(path); changed.push(path); }
    }
    for (const [name] of before.get(dir) ?? []) {
      const path = dir === "." ? name : `${dir}/${name}`;
      if (seen.has(path) || now.has(name)) continue;
      // moved into another watched folder's listing does not count as removed
      const movedAway = () => [...dirs].some((d) => { const rest = d === "." ? path : path.startsWith(`${d}/`) ? path.slice(d.length + 1) : null; return rest !== null && listFiles(root, d)?.has(rest); });
      if (isBookkeeping(path) || exempt(path)) {
        if ((isBookkeeping(path) || (isE1Temp(path) && !declared.has(path))) && !movedAway()) noteExempt(root, path, "delete");
        continue;
      }
      if (movedAway()) continue;
      seen.add(path); deleted.push(path);
    }
  }
  if (extra.length || changed.length || deleted.length) {
    const rolledBack = [];
    if (!overlapped) for (const path of extra) { try { rmSync(join(root, path), { force: true }); rolledBack.push(path); } catch {} }
    const first = extra[0] ?? changed[0] ?? deleted[0];
    const info = {
      tool: currentTool(), group: toolGroup(currentTool()), path: first, kind: null, owner: null, writer: null,
      status: extra.length ? "undeclared_output" : "undeclared_change", extra, rolled_back: rolledBack, overlapped,
      ...(changed.length || deleted.length ? { changed, deleted, restored: false } : {}),
    };
    noteRefusal(root, { op: "subprocess_output", ...info });
    const parts = [];
    if (extra.length) parts.push(`wrote ${extra.length} file(s) it did not declare (first: ${extra[0]})`);
    if (changed.length) parts.push(`rewrote ${changed.length} existing file(s) (first: ${changed[0]}; not restored)`);
    if (deleted.length) parts.push(`removed ${deleted.length} existing file(s) (first: ${deleted[0]}; not restored)`);
    const tail = extra.length ? (overlapped ? "; not deleted because another tool call ran at the same time" : "; deleted again") : "";
    const error = new BoundaryRefusal(`boundary: ${info.tool || "unknown tool"}（${info.group || "unknown group"}）child process ${parts.join(" and ")}${tail}.`, info);
    error.code = TOOLS_REFUSAL_CODE;
    throw error;
  }
  if (failure) throw failure;
  return value;
}

// K315 (NEWSROOM_GROUP_CALL_REPORT, default on; off only when exactly "0"): report-only record of tools reaching this module's exports (key groups.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  recordBoundaryWrite = trackExport("groups.mjs::recordBoundaryWrite", recordBoundaryWrite);
  runDeclared = trackExport("groups.mjs::runDeclared", runDeclared);
  stagedWriteRoot = trackExport("groups.mjs::stagedWriteRoot", stagedWriteRoot);
  readThroughStaging = trackExport("groups.mjs::readThroughStaging", readThroughStaging);
  stagedFilePath = trackExport("groups.mjs::stagedFilePath", stagedFilePath);
  stageOp = trackExport("groups.mjs::stageOp", stageOp);
  asHandoffWriter = trackExport("groups.mjs::asHandoffWriter", asHandoffWriter);
}
