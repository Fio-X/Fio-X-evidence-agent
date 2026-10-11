// The four-group list (agent, knowledge, visual, system) and the two opt-in helpers built on it. The list itself is groups.json
// (commands, Pi tools and source files, each in exactly one group). Nothing here runs unless a switch is set, and nothing here
// refuses a call or changes any other output.
//
// NEWSROOM_GROUP_BOUNDARY=1 (exact value, default off; report-only, there is no blocking mode): every artifact write made through newsroom.ts is recorded as
// (initiating tool, its group, artifact kind, owning group) in one report file, runtime/group-boundary-report.json. It only reports.
// A write whose tool or path cannot be classified is counted as 待查, never as fine. Write sites this file cannot see are listed in
// the report under not_traced, so the report never claims zero violations.
//
// NEWSROOM_GROUP_ENFORCE=1 (exact value, default off; needs NEWSROOM_GROUP_HANDOFF=1, newsroom.ts stops at start-up without it): the same
// classification, but a write made by a tool outside the owning group is refused before anything reaches the disk. A write that cannot be
// classified (待查) is refused too, and so is a check that fails, errors or runs past its hard limit (fail-closed). Reads, mkdir and a group's own
// writers (runAsWriter) are not refused. Not covered: Rust-side writes and files written by child processes (see NOT_TRACED).
//
// NEWSROOM_GROUP_TOOLS=1 (exact value, default off; needs NEWSROOM_GROUP_ENFORCE=1, newsroom.ts stops at start-up without it): every tool goes through one
// wrapper at the single registration point (withGroupTools). A tool that groups.json does not list with a group and a group.action name stops the start-up.
// A tool that starts a child process declares its output files first (runDeclared): each declared file is judged like an in-process write before the process
// starts, and after it ends any NEW file in the watched folders that was not declared is deleted again and the call is refused. That second part is a check
// AFTER writing with a rollback, not a refusal before writing: a child process can write what it likes in between.
// The only exceptions (E1-E3, each pinned by a test): E1 program bookkeeping (temp files and atomic intermediates, the phase-metrics file, the fault marker; the
// fixed lists below), E2 reads, E3 files a child process keeps inside itself (not visible, only the watched folders are compared).
//
// NEWSROOM_GROUP_TOOL_ORDER=1 (exact value, default off): the tools are listed to the model in group order, each description
// starting with a short group label. Tools missing from groups.json keep their place after the groups, unlabeled.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUP_ORDER = ["agent", "knowledge", "visual", "system"];
export const BOUNDARY_REPORT_PATH = "runtime/group-boundary-report.json";

export const boundaryReportEnabled = () => process.env.NEWSROOM_GROUP_BOUNDARY === "1";
export const groupEnforceEnabled = () => process.env.NEWSROOM_GROUP_ENFORCE === "1";
/** Tools need their initiating-tool context when either the report or the refusal is on. */
export const boundaryContextEnabled = () => boundaryReportEnabled() || groupEnforceEnabled();
export const groupToolsEnabled = () => process.env.NEWSROOM_GROUP_TOOLS === "1";
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
export const NOT_TRACED = [
  "Rust-side writes (src/artifact.rs, audit.rs, commands/*, verify.rs)",
  "directory creation (mkdir): only file writes, appends, renames and unlinks are recorded",
  "files written by child processes (networkx_analyze.py, networkx_reduce.py, rasterize_svg.py, browser_qa.py) and the duckdb process",
  "the phase-metrics file (NEWSROOM_PHASE_METRICS_FILE, outside the run folder), the fault-injection marker (test harness only) and atomic temp files",
  "writes made through closures, callbacks or a chain or edit tool that calls another tool's execute: these are attributed to the tool that was running, or counted 待查 when none was",
  "reads of any kind",
];

const store = new AsyncLocalStorage();
/** Run fn with `tool` as the initiating tool of every write made inside it. */
export const runInTool = (tool, fn) => store.run({ tool: String(tool ?? "") }, fn);
export const currentTool = () => store.getStore()?.tool ?? null;
/**
 * Run fn as a group's own writer (NEWSROOM_GROUP_HANDOFF=1): the writes inside belong to that group and are reported under the writer's name,
 * with the tool that asked for them kept in `requested_by`, so a hand-off is visible and never hidden.
 */
export const runAsWriter = (group, writer, fn) => store.run({ tool: store.getStore()?.tool ?? "", writer: { group, name: writer } }, fn);
const currentWriter = () => store.getStore()?.writer ?? null;

/** Wraps a tool's execute so its writes know who initiated them. Only called with the report or the refusal switch on. */
export function withBoundaryContext(tool) {
  if (!tool || typeof tool.execute !== "function") return tool;
  const original = tool.execute.bind(tool);
  return { ...tool, execute: (...args) => runInTool(tool.name, () => original(...args)) };
}

let state = null; // { root, records: Map, writes }
const keyOf = (r) => [r.tool, r.requested_by ?? "", r.op, r.kind, r.status, r.reason].join("|");

function load(root) {
  if (state?.root === root) return state;
  state = { root, records: new Map(), writes: 0 };
  try {
    const previous = JSON.parse(readFileSync(join(root, BOUNDARY_REPORT_PATH), "utf8"));
    for (const record of previous.records ?? []) { state.records.set(keyOf({ ...record, reason: record.reason ?? "" }), record); state.writes += record.count ?? 0; }
  } catch {}
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
    note: "Report only: nothing was refused. 待查 writes could not be classified and are not counted as fine. not_traced lists write sites this report cannot see, so it does not show zero violations.",
    ownership: OWNERSHIP,
    records,
    not_traced: NOT_TRACED,
  };
  const path = join(root, BOUNDARY_REPORT_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

// ---- classification shared by the report and the refusal -------------------------------------------------------------------------
/** Who is writing, which kind of artifact it is and whether the writer's group owns it. `lookup` supplies the group list and the path classifier. */
function evaluateWrite(root, target, lookup = { groups: loadGroups, classify: classifyArtifact }) {
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
  const allowed = Boolean(tool && group && classified && group === classified.owner);
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
    const verdict = hooks.decide ? hooks.decide(root, target, op) : evaluateWrite(root, target, { groups: hooks.groups, classify: hooks.classify });
    if (!(hooks.now() - started <= ENFORCE_LIMIT_MS)) throw new Error("check too slow");
    path = verdict.path ?? path;
    info = { tool: verdict.tool, group: verdict.group, path, kind: verdict.classified?.kind ?? null, owner: verdict.classified?.owner ?? null, writer: null, status: verdict.status };
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
export function recordBoundaryWrite(root, target, op = "write") {
  enforceBoundary(root, target, op);
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
      tag = process.env.NEWSROOM_GROUP_REVIEW_FROM_RECORDS === "1" ? "status_computed_by_program" : "model_supplied_pass";
      if (status === "ok" && tag === "model_supplied_pass") { status = "model_supplied_pass"; reason = "The status in this record is supplied by the model; writing the file through the owning group does not make it fine."; }
    }
    const record = { tool: tool ?? null, ...(writer ? { requested_by: requestedBy } : {}), tool_group: group, op, kind: classified?.kind ?? null, owner: classified?.owner ?? null, status, ...(reason ? { reason } : {}), count: 0, examples: [] };
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

// ---- tools under the groups (NEWSROOM_GROUP_TOOLS=1) ---------------------------------------------------------------------------
/** E1, fixed and pinned by test_group_tools: temp names the program itself makes and removes. Nothing else is skipped by the after-writing check. */
export const E1_TEMP_SUFFIXES = Object.freeze([".tmp", ".write-tmp"]);
export const E1_TEMP_FOLDERS = Object.freeze(["runtime/preview-tmp/"]);
export const TOOLS_REFUSAL_CODE = "GROUP_TOOLS_REFUSED";

const checkedTools = new WeakSet();
export const isGroupChecked = (tool) => checkedTools.has(tool);
let inFlight = 0, overlaps = 0;

/** Start-up check: the switch needs the refusal switch (and, through it, the hand-off). */
export function assertGroupToolsSwitches() {
  if (groupToolsEnabled() && !groupEnforceEnabled()) throw new Error("GROUP_TOOLS_NEEDS_ENFORCE: checking each tool against its group only works with the refusal of cross-group writes on");
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
      try { return await inner.execute(...args); } finally { inFlight -= 1; }
    },
  };
  checkedTools.add(wrapped);
  return wrapped;
}

/** After registration: every tool handed to Pi must be one the wrapper made. A tool that bypassed it stops the start-up. */
export function assertAllGroupChecked(tools) {
  for (const tool of tools) if (!isGroupChecked(tool)) throw new Error(`GROUP_TOOLS_UNWRAPPED: ${JSON.stringify(String(tool?.name ?? ""))} reached Pi without going through the group check`);
}

const listFiles = (dir) => { try { return new Set(readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => e.name)); } catch { return null; } };
const isE1Temp = (rel) => E1_TEMP_SUFFIXES.some((suffix) => rel.endsWith(suffix)) || E1_TEMP_FOLDERS.some((folder) => rel.startsWith(folder));

/**
 * Run a child process that writes files, for a tool. `outputs` (artifact-relative paths) are declared before it starts: each is judged now like an
 * in-process write (a refusal here means the process never starts). `watch` (default: the folders of the outputs, or the run folder itself when nothing
 * is declared) is compared before and after, non-recursively; a new file that was not declared is deleted and the call is refused. If another tool call
 * ran at the same time the new file cannot be told from that call's own, so it is reported and refused but not deleted. Off: fn() unchanged.
 */
export async function runDeclared(root, outputs, fn, { watch } = {}) {
  if (!groupToolsEnabled()) return fn();
  if (!root) throw new BoundaryRefusal(refusalText({ tool: currentTool(), path: "(no artifact root)" }), { status: "check_failed" });
  const rel = (p) => (isAbsolute(String(p)) ? relative(root, String(p)) : String(p)).replace(/\\/g, "/");
  const declared = new Set(outputs.map(rel));
  for (const path of declared) if (!E1_TEMP_FOLDERS.some((folder) => path.startsWith(folder))) recordBoundaryWrite(root, path, "subprocess_output");
  const dirs = new Set((watch ?? (declared.size ? [...declared].map((p) => dirname(p)) : ["."])).map((d) => rel(d) || "."));
  const before = new Map([...dirs].map((d) => [d, listFiles(join(root, d))]));
  const overlapsBefore = overlaps;
  let failure = null, value;
  try { value = await fn(); } catch (error) { failure = error; }
  const overlapped = inFlight > 1 || overlaps !== overlapsBefore;
  const extra = [];
  for (const dir of dirs) {
    const now = listFiles(join(root, dir));
    if (!now) continue;
    for (const name of now) {
      const path = dir === "." ? name : `${dir}/${name}`;
      if (before.get(dir)?.has(name) || declared.has(path) || isE1Temp(path)) continue;
      extra.push(path);
    }
  }
  if (extra.length) {
    const rolledBack = [];
    if (!overlapped) for (const path of extra) { try { rmSync(join(root, path), { force: true }); rolledBack.push(path); } catch {} }
    const info = { tool: currentTool(), group: toolGroup(currentTool()), path: extra[0], kind: null, owner: null, writer: null, status: "undeclared_output", extra, rolled_back: rolledBack, overlapped };
    noteRefusal(root, { op: "subprocess_output", ...info });
    const error = new BoundaryRefusal(`boundary: ${info.tool || "unknown tool"}（${info.group || "unknown group"}）child process wrote ${extra.length} file(s) it did not declare (first: ${extra[0]})${overlapped ? "; not deleted because another tool call ran at the same time" : "; deleted again"}.`, info);
    error.code = TOOLS_REFUSAL_CODE;
    throw error;
  }
  if (failure) throw failure;
  return value;
}
