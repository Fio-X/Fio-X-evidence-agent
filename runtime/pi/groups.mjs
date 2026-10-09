// The four-group list (agent, knowledge, visual, system) and the two opt-in helpers built on it. The list itself is groups.json
// (commands, Pi tools and source files, each in exactly one group). Nothing here runs unless a switch is set, and nothing here
// refuses a call or changes any other output.
//
// NEWSROOM_GROUP_BOUNDARY=1 (exact value, default off; report-only, there is no blocking mode): every artifact write made through newsroom.ts is recorded as
// (initiating tool, its group, artifact kind, owning group) in one report file, runtime/group-boundary-report.json. It only reports.
// A write whose tool or path cannot be classified is counted as 待查, never as fine. Write sites this file cannot see are listed in
// the report under not_traced, so the report never claims zero violations.
//
// NEWSROOM_GROUP_TOOL_ORDER=1 (exact value, default off): the tools are listed to the model in group order, each description
// starting with a short group label. Tools missing from groups.json keep their place after the groups, unlabeled.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUP_ORDER = ["agent", "knowledge", "visual", "system"];
export const BOUNDARY_REPORT_PATH = "runtime/group-boundary-report.json";

export const boundaryReportEnabled = () => process.env.NEWSROOM_GROUP_BOUNDARY === "1";
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
// Who may write which kind of artifact. The pass/publication decision belongs to the agent group alone;
// the other three groups have no right to write it (not merely read-only).
export const OWNERSHIP = {
  evidence: { owner: "knowledge", what: "claims, computation records, sources, searches, data files and origins, query-row tables" },
  project_state: { owner: "agent", what: "plan, run telemetry, rejected-call and patch stores" },
  visual_spec: { owner: "visual", what: "chart, page, illustration, map, model-spec and publication specs, renders, critics, QA" },
  pass_decision: { owner: "agent", what: "review and award records, vision verdicts, competition preflight" },
  rules: { owner: "system", what: "config and the registry" },
};

// First match wins. Anything that matches no rule is 待查.
const KIND_RULES = [
  [/^claims\.jsonl$/, "evidence"],
  [/^(computations|sources|searches|data)\//, "evidence"],
  [/^runtime\/query-rows\//, "evidence"],
  [/^visualizations\/graph-analysis\//, "evidence"],
  [/^editorial\/(preferences|award-runs)\//, "pass_decision"],
  [/^infographics\/(vision-critics|competition-preflight)\//, "pass_decision"],
  [/^plan\.json$/, "project_state"],
  [/^runtime\//, "project_state"],
  [/^infographics\/(plan-rejections|plan-patches|chain-rejections|chain-patches)\//, "project_state"],
  [/^(visualizations|infographics|editorial|maps|models|publications|lieflat)\//, "visual_spec"],
  [/^config\//, "rules"],
];
export function classifyArtifact(relPath) {
  const path = String(relPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  for (const [pattern, kind] of KIND_RULES) if (pattern.test(path)) return { kind, owner: OWNERSHIP[kind].owner };
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
  "Rust-side writes (src/artifact.rs, audit.rs, commands/*, verify.rs, agent/tools/*)",
  "direct fs writes in lieflat.mjs, parallel_scheduler.mjs and shadow.mjs",
  "files written by child processes (networkx_analyze.py, networkx_reduce.py, rasterize_svg.py, browser_qa.py) and the duckdb process",
  "the phase-metrics file (NEWSROOM_PHASE_METRICS_FILE, outside the run folder), the fault-injection marker (test harness only) and atomic temp files",
  "writes made through closures, callbacks or a chain or edit tool that calls another tool's execute: these are attributed to the tool that was running, or counted 待查 when none was",
  "reads of any kind",
];

const store = new AsyncLocalStorage();
/** Run fn with `tool` as the initiating tool of every write made inside it. */
export const runInTool = (tool, fn) => store.run({ tool: String(tool ?? "") }, fn);
export const currentTool = () => store.getStore()?.tool ?? null;

/** Wraps a tool's execute so its writes know who initiated them. Only called with the switch on. */
export function withBoundaryContext(tool) {
  if (!tool || typeof tool.execute !== "function") return tool;
  const original = tool.execute.bind(tool);
  return { ...tool, execute: (...args) => runInTool(tool.name, () => original(...args)) };
}

let state = null; // { root, records: Map, writes }
const keyOf = (r) => [r.tool, r.op, r.kind, r.status, r.reason].join("|");

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
  const report = {
    schema_version: "0.1.0",
    mode: "report",
    summary: `${totals.writes} writes seen: ${totals.ok} in the owning group, ${totals.cross_group} cross-group, ${totals.to_check} 待查 (could not be classified). Report only; not_traced lists what this report cannot see.`,
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

/** Records one artifact write call. Never throws and never touches the write itself. */
export function recordBoundaryWrite(root, target, op = "write") {
  if (!boundaryReportEnabled() || !root) return;
  try {
    const text = String(target ?? "");
    const path = (isAbsolute(text) ? relative(root, text) : text).replace(/\\/g, "/");
    const tool = currentTool();
    const group = tool ? toolGroup(tool) : null;
    const classified = classifyArtifact(path);
    let status, reason = "";
    if (!tool) { status = "待查"; reason = "no initiating tool"; }
    else if (!group) { status = "待查"; reason = "tool is not in groups.json"; }
    else if (!classified) { status = "待查"; reason = "path matches no artifact kind"; }
    else status = group === classified.owner ? "ok" : "cross_group";
    const record = { tool: tool ?? null, tool_group: group, op, kind: classified?.kind ?? null, owner: classified?.owner ?? null, status, ...(reason ? { reason } : {}), count: 0, examples: [] };
    const current = load(root);
    const key = keyOf({ ...record, reason });
    const entry = current.records.get(key) ?? record;
    entry.count += 1;
    if (entry.examples.length < 5 && !entry.examples.includes(path)) entry.examples.push(path);
    if (status === "cross_group") {
      const known = knownTag(path, classified.kind);
      if (known) entry.known = known;
      if (loadGroups().tools?.[tool]?.model_supplied_pass && classified.kind === "pass_decision") entry.model_supplied_pass = true;
    }
    current.records.set(key, entry);
    current.writes += 1;
    writeReport(root);
  } catch {}
}
