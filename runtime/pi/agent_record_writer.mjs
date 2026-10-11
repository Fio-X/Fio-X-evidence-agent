// The agent group's writer for the run records a visual-side tool leaves: the refused-call store of the plan tool (infographics/plan-rejections/)
// and the tool-chain event log (runtime/tool-chain-events.jsonl). With NEWSROOM_GROUP_HANDOFF=1 (exact value, default off) the flow layer passes each
// of them to this writer instead of the tool writing the file itself. Same store call, same arguments, same order: paths, bytes and the number of
// writes do not change; only who the boundary report names as the writer does (the asking tool stays listed as requested_by). Only these folders
// and this one file are accepted.
import { asHandoffWriter } from "./groups.mjs";

export const AGENT_RECORD_WRITER = "agent_record_writer";
export const AGENT_RECORD_FOLDERS = ["infographics/plan-rejections/", "infographics/chain-rejections/"];
export const CHAIN_EVENT_FILE = "runtime/tool-chain-events.jsonl";

/** deps: { writeArtifactIfAbsent(ref, value), appendArtifact(ref, value) } from the flow layer. */
export function agentRecordWriter(deps) {
  return {
    writeRejection(ref, record) {
      if (typeof ref !== "string" || ref.includes("..") || !AGENT_RECORD_FOLDERS.some((folder) => ref.startsWith(folder))) {
        throw new Error(`AGENT_RECORD_WRITER_REF: a refused-call record must be saved under ${AGENT_RECORD_FOLDERS.join(", ")}`);
      }
      return asHandoffWriter(AGENT_RECORD_WRITER, () => deps.writeArtifactIfAbsent(ref, record));
    },
    appendChainEvent(event) {
      return asHandoffWriter(AGENT_RECORD_WRITER, () => deps.appendArtifact(CHAIN_EVENT_FILE, event));
    },
  };
}
