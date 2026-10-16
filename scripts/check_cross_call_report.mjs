#!/usr/bin/env node
// K307: reconcile runtime/cross-call-report.jsonl (always written; there is no switch for it) against groups.json cross_calls.
// Usage: node scripts/check_cross_call_report.mjs <run folder | report file> [--groups <groups.json>]
// Prints one line per undeclared (tool group, function) pair; exit 1 when there is any, 2 when the report cannot be read. Only this checker exits
// nonzero: the run itself never refuses or fails because of the report. The table is re-read here, the `declared` field written during the run is not trusted.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exemptRowProblem } from "./exempt_row_problem.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--groups");
const groupsPath = at >= 0 ? args.splice(at, 2)[1] : join(dirname(fileURLToPath(import.meta.url)), "../runtime/pi/groups.json");
const target = args[0];
if (!target) { console.error("usage: check_cross_call_report.mjs <run folder | report file> [--groups groups.json]"); process.exit(2); }
const file = existsSync(target) && statSync(target).isDirectory() ? join(target, "runtime/cross-call-report.jsonl") : target;
let list, lines;
try { list = JSON.parse(readFileSync(groupsPath, "utf8")); lines = readFileSync(file, "utf8").split("\n").filter(Boolean); } catch (error) { console.error(`cannot read: ${error.message}`); process.exit(2); }

const table = list.cross_calls ?? {};
// A plain name is a newsroom.ts function (cross_calls.functions; gated entries are owned by knowledge). A `module::name` key (K315, an export of another module) is read from
// cross_calls.imported and cross_calls.modules together: its owner is the module's group, its groups are every group that imports it. Same meaning as groups.mjs crossCallEntry.
const entryOf = (name) => {
  if (String(name).includes("::")) {
    const rows = [table.imported?.[name], table.modules?.[name]].filter(Boolean);
    return rows.length ? { owner: rows[0].owner ?? null, groups: [...new Set(rows.flatMap((r) => r.groups ?? []))] } : null;
  }
  const row = table.functions?.[name];
  return row ? { owner: table.gated?.includes(name) ? "knowledge" : null, groups: row.groups ?? [] } : null;
};
let noTool = 0;
let exemptRows = 0;
const badExempt = [];
const pairs = new Map();
const notAllowed = new Map(); // K321: tool_allowed is recomputed from the table here, like `declared`; the written field is not trusted
for (const line of lines) {
  let row;
  try { row = JSON.parse(line); } catch { console.error(`unreadable line: ${line.slice(0, 80)}`); process.exit(2); }
  // an exempt-write row (NEWSROOM_GROUP_EXEMPT_RECORD) is not a call: counted, never judged as a call, but it must prove it is exempt (a forged one is a bad row)
  if (row.kind === "exempt_write") { const why = exemptRowProblem(row); if (why) badExempt.push(why); else exemptRows++; continue; }
  // K366: a call with no asking tool (NEWSROOM_GROUP_CALL_CHECK=1 writes requester "none") has no group to judge; it is counted, not listed as undeclared
  if (row.requester === "none") { noTool++; continue; }
  const group = list.tools?.[row.tool]?.group ?? null;
  const entry = entryOf(row.function);
  const owner = entry?.owner ?? null;
  const allow = table.tool_allow?.[row.function];
  if (allow && group && group !== owner && !(allow.tools ?? []).includes(row.tool)) { const k = `${row.tool}\t${row.function}`; if (!notAllowed.has(k)) notAllowed.set(k, { tool: row.tool, group, function: row.function, list: "tool_allow" }); }
  // K330: the class-B pins (cross_calls.tool_pin) are checked here only; the run writes no field for them
  const pin = table.tool_pin?.[row.function];
  if (pin && group && group !== pin.owner && !(pin.tools ?? []).includes(row.tool) && !(pin.runtime_only ?? []).includes(row.tool)) { const k = `${row.tool}\t${row.function}`; if (!notAllowed.has(k)) notAllowed.set(k, { tool: row.tool, group, function: row.function, list: "tool_pin" }); }
  let problem = null;
  if (!entry) problem = "function is not in cross_calls";
  else if (!group) problem = `${row.tool} has no group in groups.json`;
  else if (group !== owner && !entry.groups.includes(group)) problem = `group ${group} is not listed for ${row.function}`;
  if (!problem) continue;
  const key = `${group ?? "?"}\t${row.function}`;
  if (!pairs.has(key)) pairs.set(key, { group, function: row.function, tools: new Set(), problem });
  pairs.get(key).tools.add(row.tool);
}
for (const p of pairs.values()) console.log(`UNDECLARED ${p.group ?? "?"} -> ${p.function}: ${p.problem} (tools: ${[...p.tools].join(", ")})`);
for (const p of notAllowed.values()) console.log(`NOT ALLOWED ${p.group} ${p.tool} -> ${p.function}: tool is not in cross_calls.${p.list}`);
for (const why of badExempt) console.log(`BAD EXEMPT ROW ${why}`);
console.log(`${lines.length} record(s), ${pairs.size} undeclared pair(s), ${notAllowed.size} tool-not-allowed pair(s)${noTool ? `, ${noTool} call(s) with no asking tool` : ""}${exemptRows ? `, ${exemptRows} exempt-write row(s) not judged` : ""}${badExempt.length ? `, ${badExempt.length} bad exempt-write row(s)` : ""}`);
process.exit(pairs.size || notAllowed.size || badExempt.length ? 1 : 0);
