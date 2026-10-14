#!/usr/bin/env node
// K371: read-only summary of one run's runtime/cross-call-report.jsonl (NEWSROOM_GROUP_CALL_REPORT=1, and NEWSROOM_GROUP_CALL_CHECK=1 for the K366 fields).
// Usage: node scripts/summarize_cross_call_report.mjs <run folder | report file>
// Prints: counts by tool and verdict, every declared=false row, every requester=none row, and the tool_allow / tool_pin verdicts (tool_allowed true/false).
// Reads only that one file (a run folder argument is resolved to runtime/cross-call-report.jsonl and nothing else in it is opened); writes nothing, never judges
// against groups.json (use scripts/check_cross_call_report.mjs for that). Exit 0 when read, 2 when the file cannot be read or a line is not JSON.
// Verdicts, as written by the run: declared true = "declared", false = "undeclared", null = "not in table"; requester "none" = "no asking tool".
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exemptRowProblem } from "./exempt_row_problem.mjs";

const target = process.argv[2];
if (!target) { console.error("usage: summarize_cross_call_report.mjs <run folder | report file>"); process.exit(2); }
const file = existsSync(target) && statSync(target).isDirectory() ? join(target, "runtime/cross-call-report.jsonl") : target;
let allRows;
try {
  allRows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`line ${i + 1} is not JSON`); }
  });
} catch (error) { console.error(`cannot read: ${error.message}`); process.exit(2); }
// exempt-write rows (NEWSROOM_GROUP_EXEMPT_RECORD) are listed apart; every call count below is over the call rows only. A row that says it is exempt but does not prove it is a bad row.
const exemptAll = allRows.filter((r) => r.kind === "exempt_write");
const badExempt = exemptAll.map((r) => ({ r, why: exemptRowProblem(r) })).filter((x) => x.why);
const exemptRows = exemptAll.filter((r) => !exemptRowProblem(r));
const rows = allRows.filter((r) => r.kind !== "exempt_write");

const verdictOf = (r) => (r.requester === "none" ? "no asking tool" : r.declared === true ? "declared" : r.declared === false ? "undeclared" : "not in table");
const show = (r) => `${r.tool ?? "(none)"} [${r.tool_group ?? "-"}] -> ${r.function} (owner ${r.callee_owner ?? "-"})`;
const VERDICTS = ["declared", "undeclared", "not in table", "no asking tool"];

const byTool = new Map();
for (const r of rows) {
  const t = r.tool ?? "(none)";
  const c = byTool.get(t) ?? Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  c[verdictOf(r)]++;
  byTool.set(t, c);
}
console.log(`${rows.length} row(s) in ${file}`);
console.log("\nBY TOOL AND VERDICT");
for (const [tool, c] of [...byTool].sort((a, b) => a[0].localeCompare(b[0], "en-US"))) console.log(`  ${tool}: ${VERDICTS.map((v) => `${v} ${c[v]}`).join(", ")}`);
const total = Object.fromEntries(VERDICTS.map((v) => [v, rows.filter((r) => verdictOf(r) === v).length]));
console.log(`  TOTAL: ${VERDICTS.map((v) => `${v} ${total[v]}`).join(", ")}`);

const undeclared = rows.filter((r) => r.requester !== "none" && r.declared === false);
console.log(`\nDECLARED=FALSE (${undeclared.length})`);
for (const r of undeclared) console.log(`  ${show(r)}${r.tool_allowed === false ? " [tool not on its list]" : ""}`);
const none = rows.filter((r) => r.requester === "none");
console.log(`\nREQUESTER=NONE (${none.length})`);
for (const r of none) console.log(`  ${r.function} (owner ${r.callee_owner ?? "-"})`);
const listed = rows.filter((r) => typeof r.tool_allowed === "boolean");
console.log(`\nTOOL_ALLOW / TOOL_PIN VERDICTS (${listed.length}: ${listed.filter((r) => r.tool_allowed).length} allowed, ${listed.filter((r) => !r.tool_allowed).length} not allowed)`);
for (const r of listed) console.log(`  ${r.tool_allowed ? "allowed    " : "NOT ALLOWED"} ${show(r)}`);
if (exemptRows.length) {
  console.log(`\nEXEMPT WRITES (${exemptRows.length}, record only, never judged)`);
  for (const r of exemptRows) console.log(`  ${[r.side, r.tool, r.op, r.path, r.exemption].map((field) => JSON.stringify(field)).join(" ")}`);
}
if (badExempt.length) {
  console.log(`\nBAD ROWS (${badExempt.length}, said exempt_write but did not prove it)`);
  for (const { r, why } of badExempt) console.log(`  ${JSON.stringify(r.path ?? "(no path)")}: ${why}`);
}
