// Recorded output of an OLD commit that is not in the pushed history, for the byte-for-byte "off is identical to the old code" tests.
// Normal run: reads scripts/fixtures/base-output/<name>.json. A missing file, a different source commit or an input that was never recorded FAILS (throws); there is no skip path.
// Record run (only scripts/gen_base_output_fixtures.mjs sets NEWSROOM_BASE_RECORD_WT): the test runs the old tree on its own inputs, and the result is written to the fixture file.
// An entry is keyed by the sha256 of its inputs, so a changed input is not silently compared with an old answer. It holds sha256 + bytes of the old output, and the text itself when `text` is set.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const DIR = dirname(fileURLToPath(import.meta.url));

export function baseOutputs({ name, commit, text = false }) {
  const file = join(DIR, `${name}.json`);
  const recordWt = process.env.NEWSROOM_BASE_RECORD_WT || null;
  const outputs = {};
  if (recordWt) {
    const head = execFileSync("git", ["-C", recordWt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!head.startsWith(commit)) throw new Error(`${recordWt} is at ${head.slice(0, 7)}, not ${commit}`);
    process.on("exit", (code) => {
      if (code !== 0) return;
      const sorted = Object.fromEntries(Object.keys(outputs).sort().map((k) => [k, outputs[k]]));
      writeFileSync(file, JSON.stringify({ source_commit: commit, outputs: sorted }, null, 1) + "\n");
      console.log(`recorded ${Object.keys(outputs).length} outputs of ${commit} -> ${name}.json`);
    });
  } else {
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    if (fixture.source_commit !== commit) throw new Error(`${name}.json was made from ${fixture.source_commit}, the test names ${commit}`);
    Object.assign(outputs, fixture.outputs);
  }
  return {
    recordWt,
    // inputs: any JSON value that fully determines the old output; thunk: runs the OLD code (only called when recording)
    get(inputs, thunk) {
      const key = sha256(JSON.stringify(inputs));
      if (recordWt) {
        const out = thunk();
        const body = typeof out === "string" ? out : JSON.stringify(out);
        outputs[key] = { sha256: sha256(body), bytes: Buffer.byteLength(body), ...(text ? { text: body } : {}) };
      }
      const rec = outputs[key];
      if (!rec) throw new Error(`${name}: no recorded base output for inputs ${key.slice(0, 12)} (regenerate with scripts/gen_base_output_fixtures.mjs)`);
      return rec;
    },
  };
}
