import { createHash } from "node:crypto";
import { crossCallReportEnabled, trackExport } from "./groups.mjs";

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function sourceContentHash({ finalUrl, status, contentType, truncated, text }) {
  return sha256Hex(JSON.stringify({ content_type: contentType, final_url: finalUrl, status, text, truncated }));
}

export function datasetRelativePath(bytes, extension) {
  const ext = /^[a-z0-9]{1,8}$/i.test(String(extension ?? "")) ? String(extension).toLowerCase() : "data";
  const hash = sha256Hex(bytes);
  return { sha256: hash, relativeFile: `data/${hash}.${ext}` };
}

export function computationRelativePath(sql, inputSnapshotHash, resultHash) {
  const key = sha256Hex(`${sql}\n${inputSnapshotHash}\n${resultHash}`);
  return `computations/${key}.json`;
}

// K315 (NEWSROOM_GROUP_CALL_REPORT, default on; off only when exactly "0"): report-only record of tools reaching this module's exports (key provenance.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  computationRelativePath = trackExport("provenance.mjs::computationRelativePath", computationRelativePath);
  sha256Hex = trackExport("provenance.mjs::sha256Hex", sha256Hex);
  sourceContentHash = trackExport("provenance.mjs::sourceContentHash", sourceContentHash);
}
