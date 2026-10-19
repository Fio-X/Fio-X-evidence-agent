// Shared harness for "mutate one step, the named test must go red" drivers.
// A mutant is applied to runtime/pi/newsroom.ts inside a temp copy of runtime/, config/, scripts/ and fixtures/ (never in the working tree), then
// the real test is run from that copy. A run only counts as red when the test exits non-zero AND prints that mutant's own `mustSay`
// text, so a syntax error or a crash in the copy cannot pass as a catch.
import { createHash } from "node:crypto";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha = (text) => createHash("sha256").update(text).digest("hex");
const TARGET = "runtime/pi/newsroom.ts";

// mutants: [{ name, find, replace, mustSay: RegExp | null (null = must survive), equivalent?: reason }]
// find must occur exactly once in the target. A mutant may give `edits: [{ find, replace }, ...]` instead of find/replace (every find exactly once,
// applied in order to the original text), for a mutant that removes several guards together.
// controlMustSay / controlMustNotSay: regexps the UNMUTATED run's output must / must not match (a test that prints SKIP and exits 0 is not a control).
// args: extra argv for every test run (e.g. ["--only=10", "--config=INLINE_CLAIM"]); env: extra env vars. Both default to empty, so a driver
// that passes neither runs exactly as before.
export function runMutants({ test: testArg, mutants, target = TARGET, timeoutMs = 120000, args = [], env = {}, controlMustSay = null, controlMustNotSay = null }) {
  const tests = [].concat(testArg);
  const test = tests.join(" + ");
  const tree = makeTestTmp("mutants-");
  for (const dir of ["runtime", "config", "scripts", "fixtures"]) cpSync(join(ROOT, dir), join(tree, dir), { recursive: true });
  const file = join(tree, target);
  const original = readFileSync(file, "utf8");
  const originalSha = sha(original);
  // every named test runs; the mutant is red when any exits non-zero, and `out` holds all their text
  const run = () => {
    const rs = tests.map((t) => spawnSync(process.execPath, [join(tree, "scripts", t), ...args], { cwd: tree, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, NODE_NO_WARNINGS: "1", ...env } }));
    return { status: rs.some((r) => r.status !== 0) ? 1 : 0, stdout: rs.map((r) => r.stdout ?? "").join("\n"), stderr: rs.map((r) => r.stderr ?? "").join("\n") };
  };
  const out = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const problems = [];
  const report = [];
  try {
    // 1. the unmutated copy passes
    const base = run();
    if (base.status !== 0) throw new Error(`unmutated copy of ${test} is not green:\n${out(base).slice(-1500)}`);
    if (controlMustSay && !controlMustSay.test(out(base))) throw new Error(`unmutated copy of ${test} is green but did not print ${controlMustSay}:\n${out(base).slice(-1500)}`);
    if (controlMustNotSay && controlMustNotSay.test(out(base))) throw new Error(`unmutated copy of ${test} printed ${controlMustNotSay} (a skipped cell is not a control):\n${out(base).slice(-1500)}`);
    // 2. sentinel: a first-line throw in the target must turn the same copy red, so the child really loads the copy
    writeFileSync(file, `throw new Error("MUTANT_SENTINEL");\n${original}`);
    const sentinel = run();
    if (sentinel.status === 0 || !/MUTANT_SENTINEL/.test(out(sentinel))) throw new Error(`sentinel mutant did not turn ${test} red with its own text: the copy is not what the test loads`);
    writeFileSync(file, original);
    for (const m of mutants) {
      const edits = m.edits ?? [{ find: m.find, replace: m.replace }];
      let bad = false;
      let mutated = original;
      for (const e of edits) {
        const hits = original.split(e.find).length - 1;
        if (hits !== 1) { problems.push(`${m.name}: anchor occurs ${hits} times, need exactly 1`); bad = true; break; }
        mutated = mutated.replace(e.find, () => e.replace);
      }
      if (bad) continue;
      if (mutated === original) { problems.push(`${m.name}: mutant is identical to the source`); continue; }
      try { stripTypeScriptTypes(mutated, { mode: "strip" }); } catch (e) { problems.push(`${m.name}: mutant does not parse after type stripping: ${String(e.message).slice(0, 200)}`); continue; }
      writeFileSync(file, mutated);
      const r = run();
      writeFileSync(file, original);
      if (sha(readFileSync(file, "utf8")) !== originalSha) throw new Error("restore failed: target differs from the original");
      const red = r.status !== 0;
      if (process.env.MUTANT_SHOW && red) console.log(`--- ${m.name}\n${out(r).split("\n").filter((l) => /AssertionError|^Error|Error:/.test(l)).slice(0, 4).join("\n")}`);
      if (m.mustSay === null) {
        if (red) problems.push(`${m.name}: harmless mutant turned the test red (the harness is unreliable)`);
        report.push({ name: m.name, result: red ? "RED(unexpected)" : "survived(as intended)" });
      } else if (!red) {
        if (m.equivalent) report.push({ name: m.name, result: "survived", equivalent: m.equivalent });
        else { problems.push(`${m.name}: SURVIVED, no test caught it`); report.push({ name: m.name, result: "SURVIVED" }); }
      } else if (!m.mustSay.test(out(r))) {
        problems.push(`${m.name}: red, but without the expected text ${m.mustSay}; tail:\n${out(r).slice(-600)}`);
        report.push({ name: m.name, result: "red(wrong reason)" });
      } else {
        if (m.equivalent) problems.push(`${m.name}: marked equivalent but a test caught it; drop the mark`);
        report.push({ name: m.name, result: "red" });
      }
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  for (const r of report) console.log(`  ${r.result.padEnd(22)} ${r.name}${r.equivalent ? ` [equivalent: ${r.equivalent}]` : ""}`);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exitCode = 1;
  } else console.log(`${mutants.length} mutants checked against ${test}`);
  return report;
}
