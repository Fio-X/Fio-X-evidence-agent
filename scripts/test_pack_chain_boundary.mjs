// Page build: the design pack runs the two chain tools through their own execute. The chain tools it holds are wrapped with withBoundaryContext (as the
// registered ones are), so a write made inside a chain is judged as the chain's, exactly as when the model calls the chain itself.
// Shows, with the real groups.json table and the real write check (NEWSROOM_GROUP_ENFORCE=1):
//   (a) inside the chain the asking tool is the chain's name, outside it (the pack's own writes) it is still newsroom_design_pack, and after the chain it is again;
//   (b) every write judged inside a pack-run chain gets the same answer as the same write inside a directly-called chain; at least one is refused;
//   (c) the pack's own writes are not widened: the chain-event log is refused for the pack itself (the gap the wrapper closes is for the chain only).
// No provider, no network, no model; only groups.mjs and the table.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pack-chain-boundary-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_") || name.startsWith("NEWSROOM_SPEED_")) delete process.env[name];
Object.assign(process.env, { NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_ARTIFACT_DIR: scratch });
const { asHandoffWriter, currentTool, recordBoundaryWrite, runInTool, withBoundaryContext, resetBoundaryReport } = await import(`${ROOT}/runtime/pi/groups.mjs`);
const results = [];
const check = (name) => results.push(name);

const CHAIN = "newsroom_infographic_chain";
const PACK = "newsroom_design_pack";
// A write judged by the real check: "ok", or the refusal's text.
const judge = (writer, path, op) => {
  try { asHandoffWriter(writer, () => recordBoundaryWrite(scratch, join(scratch, path), op)); return "ok"; } catch (error) { return `refused: ${String(error?.message ?? error).split("\n")[0]}`; }
};
const chainTool = (seen) => ({ name: CHAIN, execute: async (probe) => { seen.during = currentTool(); return probe(); } });

// The writes a chain makes (and some it must not): [writer, path, op].
const WRITES = [
  ["agent_record_writer", "runtime/tool-chain-events.jsonl", "append"],
  ["agent_record_writer", `infographics/chain-rejections/${"a".repeat(64)}.json`, "write_if_absent"],
  ["agent_record_writer", "claims.jsonl", "append"],
  ["agent_record_writer", "runtime/query-rows/x.json", "write_if_absent"],
  ["knowledge_writer", "runtime/tool-chain-events.jsonl", "append"],
  ["decision_writer", "publications/x/decision.json", "write_if_absent"],
];
const direct = (seen) => runInTool(CHAIN, () => WRITES.map((w) => judge(...w)));
const viaPack = async (seen) => runInTool(PACK, async () => withBoundaryContext(chainTool(seen)).execute(() => WRITES.map((w) => judge(...w))));
const unwrappedUnderPack = async (seen) => runInTool(PACK, async () => chainTool(seen).execute(() => WRITES.map((w) => judge(...w))));

{
  const seenPack = {};
  const a = await viaPack(seenPack);
  const b = direct({});
  assert.equal(seenPack.during, CHAIN, "inside the wrapped chain the asking tool is the chain");
  assert.deepEqual(a, b, "every write inside a pack-run chain is judged as inside a directly-called chain");
  assert.ok(b.includes("ok") && b.some((x) => x.startsWith("refused")), `the table gives both answers (${JSON.stringify(b)})`);
  check(`(b) ${WRITES.length} writes: the pack-run chain and the directly-called chain get the same answer (${b.filter((x) => x === "ok").length} ok, ${b.filter((x) => x !== "ok").length} refused), no extra allowed write`);
}
{
  const seen = {};
  const outer = await runInTool(PACK, async () => {
    const before = currentTool();
    await withBoundaryContext(chainTool(seen)).execute(() => null);
    return { before, after: currentTool() };
  });
  assert.equal(outer.before, PACK);
  assert.equal(seen.during, CHAIN);
  assert.equal(outer.after, PACK, "after the chain the asking tool is the pack again");
  check("(a) the asking tool is newsroom_design_pack outside the chain, the chain's name inside it, newsroom_design_pack again after it");
}
{
  const own = runInTool(PACK, () => WRITES.map((w) => judge(...w)));
  assert.ok(own[0].startsWith("refused"), "the pack itself may not write the chain-event log");
  const gap = await unwrappedUnderPack({});
  assert.deepEqual(gap, own, "without the wrapper the chain runs as the pack (the gap the wrapper closes)");
  const direct1 = direct({});
  own.forEach((answer, i) => { if (answer === "ok") assert.equal(direct1[i], "ok", `the pack is never allowed what the chain is not (write ${i})`); });
  check("(c) the pack's own writes are judged as the pack's: the chain-event log stays refused for it, nothing the chain may not write is allowed to it");
}
resetBoundaryReport();
console.log(results.map((r) => `PASS ${r}`).join("\n"));
console.log(`${results.length} checks passed`);
