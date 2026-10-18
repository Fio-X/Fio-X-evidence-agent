// The call-report tests below state exact rows for the legacy writer (NEWSROOM_SPEED_ATOMIC_ARTIFACT="0"). Since #64 the switch is on by default, so each of them
// also runs here with the switch unset and the rows recorded by the recorder (CALL_ROWS_MODE=record, see call_report_expect.mjs); a missing or changed row fails.
// To refresh after a deliberate change: for t in <the three>; do CALL_ROWS_MODE=record node scripts/$t.mjs; done, then read the fixture diff.
// Remove the "0" case in each test when the "0" off value is removed.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TESTS = ["test_editorial_hints", "test_fetch_split_probe", "test_fast_fail_errors"];
let failed = 0;
for (const name of TESTS) {
  const env = { ...process.env, CALL_ROWS_MODE: "default" };
  delete env.NEWSROOM_SPEED_ATOMIC_ARTIFACT;
  const run = spawnSync(process.execPath, [join(here, `${name}.mjs`)], { env, encoding: "utf8" });
  if (run.status !== 0) { failed += 1; console.error(`FAIL ${name} with the switch unset (default on)\n${(run.stderr || run.stdout).split("\n").slice(0, 25).join("\n")}`); }
  else console.log(`${name}: default-on rows -- PASS`);
}
if (failed) process.exit(1);
console.log("call rows with the default on: PASS");
