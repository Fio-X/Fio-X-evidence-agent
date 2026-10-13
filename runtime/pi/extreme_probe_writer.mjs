// The agent group's writer for the K117 diagnosis file (NEWSROOM_EXTREME_PROBE=1). The probe is computed by a visual-side tool (chart render), but the
// file it leaves is a run record, so it goes under runtime/extreme-probe/ (an agent-group folder) and is written here, as the agent group, with the
// asking tool kept as requested_by in the boundary report (NEWSROOM_GROUP_BOUNDARY=1). Same hand-off as decision_writer.mjs, same wx write-once rule
// as shadow/: an existing file was produced by identical inputs and is left alone. Nothing reads this folder back.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { recordBoundaryWrite, asHandoffWriter, crossCallReportEnabled, trackExport } from "./groups.mjs";

export const EXTREME_PROBE_WRITER = "extreme_probe_writer";
export const EXTREME_PROBE_FOLDER = "runtime/extreme-probe/";

/** Write one diagnosis record under runtime/extreme-probe/ as the agent group. Returns the relative path. */
export function writeExtremeProbeRecord(root, relativePath, body) {
  if (typeof relativePath !== "string" || relativePath.includes("..") || !relativePath.startsWith(EXTREME_PROBE_FOLDER)) {
    throw new Error(`EXTREME_PROBE_WRITER_REF: a diagnosis record must be saved under ${EXTREME_PROBE_FOLDER}`);
  }
  return asHandoffWriter(EXTREME_PROBE_WRITER, async () => {
    const absolute = join(root, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    recordBoundaryWrite(root, relativePath, "write_if_absent");
    try {
      await writeFile(absolute, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    return relativePath;
  });
}

// K315 (NEWSROOM_GROUP_CALL_REPORT=1, default off): report-only record of tools reaching this module's exports (key extreme_probe_writer.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  writeExtremeProbeRecord = trackExport("extreme_probe_writer.mjs::writeExtremeProbeRecord", writeExtremeProbeRecord);
}
