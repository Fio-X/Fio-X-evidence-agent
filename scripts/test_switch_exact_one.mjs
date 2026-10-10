// The runtime side of the "only exactly "1" turns it on" rule for the seven switches the Rust prompt side used to read
// as "1" or "true" (src/pi.rs env_switch, hide_lieflat_switch_enabled; the Rust test is
// seven_switches_set_to_true_are_off_on_the_prompt_side_like_the_runtime). Static and read-only: for each switch, every
// place runtime/pi reads it must compare to exactly "1" (the speed table is read in one place, `=== "1"`), and no read
// may mention "true". A reader that accepted anything else would let `=true` turn the runtime on while Rust stays off.
// Usage: node scripts/test_switch_exact_one.mjs [repo-root]
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const piDir = join(root, "runtime", "pi");
const SWITCHES = [
  "NEWSROOM_SPEED_PARALLEL_HINTS", "NEWSROOM_SPEED_COMPUTE_BATCH", "NEWSROOM_SPEED_CHAIN_VIZ",
  "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PREFLIGHT", "NEWSROOM_SPEED_PLAN_EDIT", "NEWSROOM_HIDE_LIEFLAT",
];
const files = readdirSync(piDir).filter((f) => /\.(ts|mjs)$/.test(f));
const lines = files.flatMap((f) => readFileSync(join(piDir, f), "utf8").split("\n").map((text, i) => ({ f, n: i + 1, text })));
const code = (l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text);

let checks = 0;
for (const name of SWITCHES) {
  const reads = lines.filter((l) => code(l) && l.text.includes(name));
  assert.ok(reads.length > 0, `${name}: no code reads it`);
  for (const l of reads) {
    assert.ok(!/["']true["']/i.test(l.text), `${name}: ${l.f}:${l.n} mentions "true"`);
    const direct = new RegExp(`${name}\\s*(===|!==)\\s*"1"`).test(l.text);
    const tableEntry = new RegExp(`env:\\s*"${name}"`).test(l.text);
    assert.ok(direct || tableEntry, `${name}: ${l.f}:${l.n} is neither an exact "1" comparison nor a speed-table entry`);
    checks++;
  }
}
// the speed table is read in exactly one place and compares to exactly "1"
const tableReads = lines.filter((l) => code(l) && /process\.env\[entry\.env\]/.test(l.text));
assert.equal(tableReads.length, 1, "the speed table has one reader");
assert.ok(/process\.env\[entry\.env\]\s*===\s*"1"/.test(tableReads[0].text), "the speed table reader compares to exactly \"1\"");
console.log(`test_switch_exact_one: ${checks} reads of ${SWITCHES.length} switches are exact "1"; PASS`);
