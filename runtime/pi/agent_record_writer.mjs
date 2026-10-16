// The agent group's writer for the run records a visual-side tool leaves: the refused-call store of the plan tool (infographics/plan-rejections/)
// and the tool-chain event log (runtime/tool-chain-events.jsonl). With NEWSROOM_GROUP_HANDOFF=1 (exact value, default off) the flow layer passes each
// of them to this writer instead of the tool writing the file itself. Same store call, same arguments, same order: paths, bytes and the number of
// writes do not change; only who the boundary report names as the writer does (the asking tool stays listed as requested_by). Only these folders
// and this one file are accepted.
import { asHandoffWriter, groupEnforceEnabled, crossCallReportEnabled, trackExport } from "./groups.mjs";

export const AGENT_RECORD_WRITER = "agent_record_writer";
export const AGENT_RECORD_FOLDERS = ["infographics/plan-rejections/", "infographics/chain-rejections/"];
export const CHAIN_EVENT_FILE = "runtime/tool-chain-events.jsonl";

// With the refusal on (NEWSROOM_GROUP_ENFORCE, on unless exactly "0"; K214 part B): these are bookkeeping, not evidence, so only fixed fields of fixed types are accepted, and the file name is exact.
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const REJECTION_TOOLS = { "infographics/plan-rejections/": "newsroom_infographic_plan", "infographics/chain-rejections/": "newsroom_infographic_chain" };
const CHAIN_EVENT_FIELDS = {
  tool_execution_start: { type: "string", chain: "string", toolCallId: "string", toolName: "string", step: "any", args: "any", _newsroom_recorded_at: "string" },
  tool_execution_end: { type: "string", chain: "string", toolCallId: "string", toolName: "string", step: "any", isError: "any", error: "any", result: "any", _newsroom_recorded_at: "string" },
  setup_input_form: { type: "string", toolName: "string", input_form: "string", _newsroom_recorded_at: "string" },
};
const fieldProblem = (record, fields) => {
  for (const [key, value] of Object.entries(record)) {
    const kind = fields[key];
    if (!kind) return `field ${key} is not allowed`;
    if (kind !== "any" && typeof value !== kind) return `field ${key} must be a ${kind}`;
  }
  return null;
};
export function rejectionProblem(ref, record) {
  const folder = Object.keys(REJECTION_TOOLS).find((f) => ref.startsWith(f));
  if (!folder || !new RegExp(`^${folder}[0-9a-f]{64}\\.json$`).test(ref)) return "the file name is not <folder>/<64 hex>.json";
  if (!isObject(record)) return "the record is not an object";
  const bad = fieldProblem(record, { schema_version: "string", kind: "string", tool: "string", params: "any" });
  if (bad) return bad;
  if (record.kind !== "rejected_call" || record.tool !== REJECTION_TOOLS[folder]) return "kind or tool does not belong to this folder";
  return null;
}
export function chainEventProblem(event) {
  if (!isObject(event)) return "the event is not an object";
  const fields = CHAIN_EVENT_FIELDS[event.type];
  return fields ? fieldProblem(event, fields) : `event type ${String(event.type)} is not allowed`;
}
const content = (problem, what) => { if (groupEnforceEnabled() && problem) throw new Error(`AGENT_RECORD_WRITER_CONTENT: ${what}: ${problem}`); };

/** deps: { writeArtifactIfAbsent(ref, value), appendArtifact(ref, value) } from the flow layer. */
export function agentRecordWriter(deps) {
  return {
    writeRejection(ref, record) {
      if (typeof ref !== "string" || ref.includes("..") || !AGENT_RECORD_FOLDERS.some((folder) => ref.startsWith(folder))) {
        throw new Error(`AGENT_RECORD_WRITER_REF: a refused-call record must be saved under ${AGENT_RECORD_FOLDERS.join(", ")}`);
      }
      content(rejectionProblem(ref, record), ref);
      return asHandoffWriter(AGENT_RECORD_WRITER, () => deps.writeArtifactIfAbsent(ref, record));
    },
    appendChainEvent(event) {
      content(chainEventProblem(event), CHAIN_EVENT_FILE);
      return asHandoffWriter(AGENT_RECORD_WRITER, () => deps.appendArtifact(CHAIN_EVENT_FILE, event));
    },
  };
}

// K315 (NEWSROOM_GROUP_CALL_REPORT, default on; off only when exactly "0"): report-only record of tools reaching this module's exports (key agent_record_writer.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  agentRecordWriter = trackExport("agent_record_writer.mjs::agentRecordWriter", agentRecordWriter);
}
