// Shared by check_cross_call_report.mjs and summarize_cross_call_report.mjs: a report row that says kind "exempt_write" must prove it.
// Returns null for a valid row, otherwise the reason it is a bad row. The exemption rules are the ones groups.mjs applies (exemptionOf).
import { exemptionOf } from "../runtime/pi/groups.mjs";

const EXEMPT_ROW_KEYS = ["kind", "side", "tool", "path", "exemption", "op"];
const EXEMPTIONS = ["preview_tmp", "temp_suffix", "session_folder", "bookkeeping_file"];

export const exemptRowProblem = (row) => {
  const extra = Object.keys(row).filter((key) => !EXEMPT_ROW_KEYS.includes(key));
  if (extra.length) return `carries fields an exempt write has no use for (${extra.join(", ")})`;
  if (!EXEMPTIONS.includes(row.exemption)) return `unknown exemption ${JSON.stringify(row.exemption)}`;
  if (typeof row.path !== "string" || !row.path) return "no path";
  if (exemptionOf(row.path) !== row.exemption) return `${row.path} is not exempt as ${row.exemption}`;
  return null;
};
