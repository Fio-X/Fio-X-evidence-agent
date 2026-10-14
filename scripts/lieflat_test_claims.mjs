// Test shim for 1011w: lieflat.mjs no longer reads claims.jsonl; the calling tool passes `verified_claims`. Tests that call renderLieflatPublication
// directly stand in for that tool with this wrapper, which reads the artifact's claims.jsonl the way the runtime does (the latest record of each claim
// counts, a later non-verified record revokes it, a line that is not a claim record closes the registry) and passes the verified ones in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSystemVerifiedClaim } from "../runtime/pi/evidence_gate.mjs";
import { renderLieflatPublication as renderRaw } from "../runtime/pi/lieflat.mjs";
import { runInTool } from "../runtime/pi/groups.mjs";

export function verifiedClaimsOf(root) {
  const latest = new Map();
  let raw = "";
  try { raw = readFileSync(join(root, "claims.jsonl"), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; return latest; }
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let record;
    try { record = JSON.parse(lines[index]); } catch { record = undefined; }
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.claim_id !== "string" || !record.claim_id) {
      throw new Error(`CLAIMS_REGISTRY_CORRUPT: claims.jsonl line ${index + 1} is not a claim record with a claim_id, so the verified-claim list cannot be trusted; this run's claims file is damaged, so stop and report it instead of continuing`);
    }
    latest.set(record.claim_id, record);
  }
  return new Map([...latest].filter(([, record]) => isSystemVerifiedClaim(record)));
}

export async function renderLieflatPublication(input) {
  // the shim stands in for the calling tool, so it also runs in that tool's context (what the group boundary judges the writes by)
  return runInTool("newsroom_lieflat_render", () => renderRaw({ ...input, verified_claims: verifiedClaimsOf(input.artifact_root) }));
}
