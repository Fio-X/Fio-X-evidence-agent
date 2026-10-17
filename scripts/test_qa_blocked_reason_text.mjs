#!/usr/bin/env node
// K805: the newsroom_publication_qa result text carries the blocked-module reasons of a FAILED report (module id, width, reason; at most 3,
// then "(+N more ...)"); a PASS report or a failure without blocked_reasons adds nothing. The helper is cut out of newsroom.ts and run as is
// (type-stripped); a second check pins that the tool's text uses it only for a non-PASS report and puts the note before the revision note.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = process.env.K805_NEWSROOM_TS || `${ROOT}/runtime/pi/newsroom.ts`;
const src = readFileSync(SRC, "utf8");
const start = src.indexOf("const BLOCKED_NOTE_CAP");
const end = src.indexOf("function textResult", start);
assert.ok(start > 0 && end > start, "helper found in newsroom.ts");
const code = stripTypeScriptTypes(src.slice(start, end), { mode: "strip" });
const blockedReasonNote = new Function(`${code}\nreturn blockedReasonNote;`)();

const vp = (width, ...reasons) => ({ width, status: "FAIL", blocked_reasons: reasons.map(([module_id, reason]) => ({ module_id, reason })) });
const one = { status: "FAIL", viewports: [vp(1440, ["m1", "runtime: TypeError: x is not a function"])] };
assert.equal(blockedReasonNote(one), "\nBlocked modules:\n  m1 @1440px: runtime: TypeError: x is not a function");

const four = { status: "FAIL", viewports: [vp(1440, ["m1", "runtime: A"], ["m2", "runtime: B"]), vp(768, ["m1", "runtime: A"], ["m3", "webgl"])] };
const note = blockedReasonNote(four);
assert.equal(note.split("\n  ").length - 1, 3 + 1, "three entries and the count line");
assert.ok(note.includes("m1 @1440px: runtime: A") && note.includes("m2 @1440px: runtime: B") && note.includes("m1 @768px: runtime: A"));
assert.ok(!note.includes("m3"), "the fourth entry is not listed");
assert.ok(note.endsWith("(+1 more in the report)"));

assert.equal(blockedReasonNote({ status: "FAIL", viewports: [{ width: 1440, status: "FAIL" }] }), "", "no blocked_reasons: nothing added");
assert.equal(blockedReasonNote({ status: "FAIL", viewports: [vp(1440)] }), "", "empty list: nothing added");
assert.equal(blockedReasonNote({ status: "FAIL" }), "");

// the tool text: note only for a non-PASS report, ahead of the revision note
assert.match(src, /const blockedNote = report\.status === "PASS" \? "" : blockedReasonNote\(report\);/);
assert.match(src, /Interaction replay: \$\{report\.interaction_replay\?\.status \?\? "n\/a"\}\$\{blockedNote\}\$\{revisionNote\}`/);
console.log("test_qa_blocked_reason_text: ok");
