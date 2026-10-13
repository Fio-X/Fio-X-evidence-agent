// Recorded output of an OLD runtime that is not part of the pushed history, for the byte-for-byte "the new code equals the old code" tests.
// Normal run: reads <dir>/<name>.json. A missing file, a record made from a different source or an input that was never recorded FAILS (throws); there is no skip path.
// Record run (only scripts/gen_base_output_fixtures.mjs sets NEWSROOM_BASE_RECORD_WT and NEWSROOM_BASE_RECORD_COMMIT): the test runs the old tree on its own inputs and the result is written to the fixture file.
// The source is named by content: the sha256 over `git ls-tree -r HEAD runtime config` of the worktree the record was made from (every file's mode, blob and path). The commit id the generator is given is only
// checked against the worktree and is never written anywhere.
// An entry is keyed by the sha256 of its inputs, so a changed input is not silently compared with an old answer. It holds sha256 + bytes of the old output and the output text itself.
// A record that was edited after it was made (its text no longer matches its own sha256 and byte count) fails when it is read.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const DIR = dirname(fileURLToPath(import.meta.url));

export function contentOf(worktree) {
  return sha256(execFileSync("git", ["-C", worktree, "ls-tree", "-r", "HEAD", "runtime", "config"], { encoding: "utf8" }));
}

// source: the expected content hash (64 hex digits) the test names; dir: where the fixture is read from (the mutation check reads an edited copy)
export function baseOutputs({ name, source, dir = DIR }) {
  const file = join(dir, `${name}.json`);
  const recordWt = process.env.NEWSROOM_BASE_RECORD_WT || null;
  const outputs = {};
  let head = null;
  if (recordWt) {
    head = execFileSync("git", ["-C", recordWt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const commit = process.env.NEWSROOM_BASE_RECORD_COMMIT || "";
    if (!commit || !head.startsWith(commit)) throw new Error(`${recordWt} is not at the commit the generator was given`);
    const content = contentOf(recordWt);
    if (content !== source) throw new Error(`the worktree content is ${content}, the test names ${source}`);
    process.on("exit", (code) => {
      if (code !== 0) return;
      const sorted = Object.fromEntries(Object.keys(outputs).sort().map((k) => [k, outputs[k]]));
      writeFileSync(file, JSON.stringify({ source_content: content, outputs: sorted }, null, 1) + "\n");
      console.log(`recorded ${Object.keys(outputs).length} outputs of ${content.slice(0, 12)} -> ${name}.json`);
    });
  } else {
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    if (fixture.source_content !== source) throw new Error(`${name}.json was made from ${fixture.source_content}, the test names ${source}`);
    Object.assign(outputs, fixture.outputs);
  }
  return {
    recordWt,
    head,
    // inputs: any JSON value that fully determines the old output; thunk: runs the OLD code (only called when recording); returns the recorded output text
    async get(inputs, thunk) {
      const key = sha256(JSON.stringify(inputs));
      if (recordWt) {
        const out = await thunk();
        const body = typeof out === "string" ? out : JSON.stringify(out);
        outputs[key] = { sha256: sha256(body), bytes: Buffer.byteLength(body), text: body };
      }
      const rec = outputs[key];
      if (!rec) throw new Error(`${name}: no recorded base output for inputs ${key.slice(0, 12)} (regenerate with scripts/gen_base_output_fixtures.mjs)`);
      if (typeof rec.text !== "string" || sha256(rec.text) !== rec.sha256 || Buffer.byteLength(rec.text) !== rec.bytes) throw new Error(`${name}: the record for inputs ${key.slice(0, 12)} does not match its own sha256`);
      return rec.text;
    },
  };
}
