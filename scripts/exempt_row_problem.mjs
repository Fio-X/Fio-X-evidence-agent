// Shared by check_cross_call_report.mjs and summarize_cross_call_report.mjs: a report row that says kind "exempt_write" must prove it.
// Returns null for a valid row, otherwise the reason it is a bad row. The exemption rules are the ones groups.mjs applies (exemptionOf).
import { exemptionOf, toolGroup } from "../runtime/pi/groups.mjs";

const EXEMPT_ROW_KEYS = ["kind", "side", "tool", "path", "exemption", "op"];
const EXEMPTIONS = ["preview_tmp", "temp_suffix", "session_folder", "bookkeeping_file"];
const SIDES = ["js", "rust"];
// What the two writers emit: groups.mjs noteExempt (declared, new, change, delete) and the staging judge in Rust (write, append, write_if_absent, unlink, rename).
const OPS = ["declared", "new", "change", "delete", "write", "append", "write_if_absent", "unlink", "rename"];

export const exemptRowProblem = (row) => {
  const extra = Object.keys(row).filter((key) => !EXEMPT_ROW_KEYS.includes(key));
  if (extra.length) return `carries fields an exempt write has no use for (${extra.join(", ")})`;
  const missing = EXEMPT_ROW_KEYS.filter((key) => !(key in row));
  if (missing.length) return `lacks fields an exempt write must carry (${missing.join(", ")})`;
  if (!SIDES.includes(row.side)) return `unknown side ${JSON.stringify(row.side)}`;
  if (!OPS.includes(row.op)) return `unknown op ${JSON.stringify(row.op)}`;
  if (row.tool !== null && (typeof row.tool !== "string" || !toolGroup(row.tool))) return `unknown tool ${JSON.stringify(row.tool)}`;
  if (!EXEMPTIONS.includes(row.exemption)) return `unknown exemption ${JSON.stringify(row.exemption)}`;
  if (typeof row.path !== "string" || !row.path) return "no path";
  // eslint-disable-next-line no-control-regex
  if (row.path.startsWith("/") || row.path.includes("\\") || /[\u0000-\u001f\u007f]/.test(row.path) || row.path.split("/").includes("..")) return `${JSON.stringify(row.path)} is not a plain relative path`;
  if (exemptionOf(row.path) !== row.exemption) return `${JSON.stringify(row.path)} is not exempt as ${row.exemption}`;
  return null;
};
