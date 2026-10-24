#!/usr/bin/env node
// Mutants for the judgements of the candidate step. Two targets: the real reference gate in newsroom.ts (a candidate cannot serve as a source or a
// computation) and the candidate module (only the picked are registered, the unselected are not, the sheet lives under shadow/, the tie goes to the SQL).
// Usage: node scripts/test_claim_candidates_mutants.mjs
import { runMutants } from "./mutant_lib.mjs";

const test = "test_claim_candidates.mjs";
const controlMustSay = /PASS test_claim_candidates/;
runMutants({
  test,
  controlMustSay,
  mutants: [
    { name: "real gate also accepts shadow/ as a source", find: 'kind === "source" && !(rel.startsWith("sources/") || rel.startsWith("data/"))', replace: 'kind === "source" && !(rel.startsWith("sources/") || rel.startsWith("data/") || rel.startsWith("shadow/"))', mustSay: /Missing expected rejection|source reference/ },
    { name: "real gate also accepts shadow/ as a computation", find: 'kind === "computation" && !rel.startsWith("computations/")', replace: 'kind === "computation" && !(rel.startsWith("computations/") || rel.startsWith("shadow/"))', mustSay: /Missing expected rejection|computation reference/ },
  ],
});
runMutants({
  test,
  controlMustSay,
  target: "runtime/pi/claim_candidates.mjs",
  mutants: [
    { name: "register every candidate, not only the picked", find: "  const claims = [];\n  for (const id of picks) {", replace: "  const claims = [];\n  for (const c of candidates) await register(c);\n  for (const id of picks) {", mustSay: /deepEqual|Expected values|not equal/ },
    { name: "register one unselected candidate as well", find: "  const claims = [];\n  for (const id of picks) {", replace: "  const claims = [];\n  await register(candidates.find((c) => !seen.has(c.id)));\n  for (const id of picks) {", mustSay: /deepEqual|Expected values|not equal/ },
    { name: "sheet written where a computation reference can name it", find: 'export const SHEET_PREFIX = "shadow/candidate_sheet-";', replace: 'export const SHEET_PREFIX = "computations/candidate_sheet-";', mustSay: /strictly equal|Missing expected rejection/ },
    { name: "sheet written where a source reference can name it", find: 'export const SHEET_PREFIX = "shadow/candidate_sheet-";', replace: 'export const SHEET_PREFIX = "data/candidate_sheet-";', mustSay: /Missing expected rejection|strictly equal/ },
    { name: "rank_top tie left to file order", find: "${yearSel} FROM ${src}${at(latest)} ORDER BY ${m} DESC, ${d} LIMIT 1`, `{first.name} has the highest", replace: "${yearSel} FROM ${src}${at(latest)} ORDER BY ${m} DESC LIMIT 1`, `{first.name} has the highest", mustSay: /tie|ZZ|AA/ },
    { name: "writeSheet does not wait for the write", find: "  await write(path, record);", replace: "  write(path, record);", mustSay: /the sheet is the only new file|waits for the write/ },
  ],
});
