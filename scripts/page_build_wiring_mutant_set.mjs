#!/usr/bin/env node
// Mutants for the judgements of the page-build data tool: the refill gate, the key compare, the rebuild from the data file, the inner-call chain,
// the roles, the failure count and the next-step line. Two targets: newsroom.ts and the candidate module. Run in record-only mode for the group
// call refusal (PAGE_BUILD_RECORD_ONLY=1), since the strict level needs the groups.json row that waits for approval.
// The mutants are cut into parts (test_page_build_wiring_mutants*.mjs), each under the per-file time limit of the full test run; a part is one
// target and a slice of its mutants. Usage: node scripts/test_page_build_wiring_mutants.mjs (part 1) or _2 ... _13.
import { runMutants } from "./mutant_lib.mjs";

const test = "test_page_build_wiring.mjs";
const controlMustSay = /test_page_build_wiring: \d+ checks passed/;
const env = { PAGE_BUILD_RECORD_ONLY: "1" };

export const BLOCKS = [
  {
  mutants: [
    { name: "chainDone not passed to the inner calls", find: "{ chainDone: call.finished });\n    book.ok(call);\n    return result;\n  };\n  const onData", replace: "undefined);\n    book.ok(call);\n    return result;\n  };\n  const onData", mustSay: /record_claim read the computation|computation reference does not exist|NOT VERIFIED|strictly equal|AssertionError/ },
    { name: "the sheet key is not compared", find: "if (params.sheet !== sheetKey) return data.finish(", replace: "if (false) return data.finish(", mustSay: /AssertionError/ },
    { name: "R2 reads the candidates from the sheet file instead of rebuilding", find: "        conclusions: made.conclusions,\n        picks: params.picks,", replace: "        conclusions: JSON.parse(await readFile(join(artifactRoot() as string, sheetPath), \"utf8\")).candidates,\n        picks: params.picks,", mustSay: /AssertionError/ },
    { name: "the next-step line is not added", find: "if (!/^STOPPED /.test(last) && !PAGE_BUILD_TOOLS.some((name) => last.includes(name)))", replace: "if (false)", mustSay: /names no next step|AssertionError/ },
    { name: "a search with hits counts as a failure", find: "else if (noHits || PAGE_BUILD_FAILING_MODES.has(mode)) {", replace: "else if (mode === \"search\" || noHits || PAGE_BUILD_FAILING_MODES.has(mode)) {", mustSay: /AssertionError/ },
    { name: "candidates do not reset the failure count", find: 'if (mode === "candidates") pageBuildFailures = 0;', replace: 'if (mode === "candidates") pageBuildFailures += 0;', mustSay: /AssertionError/ },
    { name: "twin: the runtime's fill rounds to two places (the candidate fill alone keeps one)", find: "    if (Math.abs(value) >= 1) return value.toFixed(1);", replace: "    if (Math.abs(value) >= 1) return value.toFixed(2);", mustSay: /fill: /, },
    { name: "the qualifier dimensions are not passed to the roles", find: "qualifiers: dataPrepareQualifiers(provider) });", replace: "qualifiers: [] });", mustSay: /units mixed/ },
    { name: "the frequency dimension is not in the provider table", find: 'frequency_dimension: { value: "freq"', replace: 'frequency_dimension_off: { value: "freq"', mustSay: /frequency mixed/ },
    { name: "the chart row limit is not handed to the candidates", find: "runSql, fill, seriesMaxRows: MAX_CHART_ROWS });", replace: "runSql, fill });", mustSay: /series over the chart limit/ },
    { name: "the page build also runs under Pi", find: 'process.env.NEWSROOM_SPEED_PAGE_BUILD === "1" && process.env.NEWSROOM_AGENT === "rust" && dataPrepareEnabled()', replace: 'process.env.NEWSROOM_SPEED_PAGE_BUILD === "1" && dataPrepareEnabled()', mustSay: /AssertionError/ },
  ],
  },
  {
  target: "runtime/pi/claim_candidates.mjs",
  mutants: [
    { name: "no refill gate at all: the sheet's sentence is the claim", edits: [
      { find: '    if (text !== byId.get(id).text) return stoppedState("claim_replay_failed", "picks", { candidate: id, claim_id: null, registered: [], detail: differs(id) });\n', replace: "" },
      { find: "      if (text !== c.text) return { claim_id: null, verified: false, detail: differs(c.id) };\n", replace: "" },
      { find: "return record({ claim: text,", replace: "return record({ claim: c.text," },
    ], mustSay: /AssertionError/ },
    { name: "the dry run does not compare (registration alone compares)", find: '    if (text !== byId.get(id).text) return stoppedState("claim_replay_failed", "picks", { candidate: id, claim_id: null, registered: [], detail: differs(id) });\n', replace: "", mustSay: /AssertionError/ },
    { name: "registration does not compare the sentence filled from the recorded query's rows (the dry run compares)", find: "      if (text !== c.text) return { claim_id: null, verified: false, detail: differs(c.id) };\n", replace: "", mustSay: /AssertionError/ },
    { name: "registration fills from a rerun of the SQL instead of the recorded query's rows", find: "const text = fill(c.template, computed.rows).text;", replace: "const text = fill(c.template, await runSql(c.sql)).text;", mustSay: /AssertionError/ },
    { name: "a unit or frequency that varies is still part of the entity", find: "  if (mixed.length > 0) return", replace: "  if (mixed.length < 0) return", mustSay: /units mixed/ },
    { name: "the series size is not checked at the candidate step", find: "if (Array.isArray(rows) && rows.length > seriesMaxRows) return", replace: "if (Array.isArray(rows) && rows.length > seriesMaxRows * 1000) return", mustSay: /series over the chart limit/ },
    { name: "the series size limit is off by one", find: "rows.length > seriesMaxRows) return", replace: "rows.length >= seriesMaxRows) return", mustSay: /exactly \d+ rows still fit/ },
    { name: "the claim is the sheet's text (both compares kept)", find: "return record({ claim: text,", replace: "return record({ claim: c.text,", mustSay: null, equivalent: "the compare just before makes text and c.text equal" },
    { name: "the series result is not cited by the claim", find: "const refs = c.series_sql ? [computationRef, (await query(c.series_sql)).ref] : [computationRef];", replace: "const refs = [computationRef];", mustSay: /computation_refs|AssertionError/ },
    { name: "the series result is cited first", find: "const refs = c.series_sql ? [computationRef, (await query(c.series_sql)).ref] : [computationRef];", replace: "const refs = c.series_sql ? [(await query(c.series_sql)).ref, computationRef] : [computationRef];", mustSay: /AssertionError/ },
    { name: "sum candidates are offered", find: "const offered = specs.filter((spec) => !SUM_KINDS.includes(spec.kind) && !flat(spec));", replace: "const offered = specs.filter((spec) => !flat(spec));", mustSay: /AssertionError/ },
    { name: "roles without the duplicate (dimension, time) check", find: "    if (seen.has(key)) return {", replace: "    if (false) return {", mustSay: /AssertionError/ },
    { name: "a change over one time value is offered", find: 'spec.kind.startsWith("change_") && times === 1', replace: 'spec.kind.startsWith("change_") && false', mustSay: /AssertionError/ },
    { name: "twin: the candidate fill rounds to two places", find: "if (Math.abs(value) >= 1) return value.toFixed(1);", replace: "if (Math.abs(value) >= 1) return value.toFixed(2);", mustSay: /fill: /, },
    { name: "twin: the candidate fill lets a null through as text", find: 'if (value === null || value === undefined) throw candidateError(`${placeholder} selects a null value (row ${rowIndex})`);', replace: 'if (value === null || value === undefined) return "";', mustSay: /fill: /, },
    { name: "twin: the candidate fill cuts a string at 81 characters", find: "const CANDIDATE_STRING_MAX_CHARS = 80;", replace: "const CANDIDATE_STRING_MAX_CHARS = 81;", mustSay: /fill: /, },
    { name: "twin: the candidate call book numbers its steps differently", find: "const suffix = `s${seq}:${tool}`;\n      return { callId: `${outerId}:${suffix}`, suffix, finished: [...finished], nested };\n    },\n    ok(call) { finished.push(call.nested ? `${call.suffix}:*` : call.suffix); },\n    get seq() { return seq; },\n  };\n}\n", replace: "const suffix = `x${seq}:${tool}`;\n      return { callId: `${outerId}:${suffix}`, suffix, finished: [...finished], nested };\n    },\n    ok(call) { finished.push(call.nested ? `${call.suffix}:*` : call.suffix); },\n    get seq() { return seq; },\n  };\n}\n", mustSay: /each query is a call of its own|call book for/ },
    { name: "operator: the highest-value operator ranks upward (same slice, so same_sql still holds)", find: 'const top = (dir) => over(level, `name, value${yearCol}`, ` ORDER BY value ${dir}, name LIMIT 1`);\n  add("rank_top", "comparative", top("DESC")', replace: 'const top = (dir) => over(level, `name, value${yearCol}`, ` ORDER BY value ${dir}, name LIMIT 1`);\n  add("rank_top", "comparative", top("ASC")', mustSay: /shapes: every operator's chart binds as same_sql[\s\S]*operator values/ },
    { name: "operator: the gap adds instead of subtracting (same slice, so same_sql still holds)", find: "MAX(value) - MIN(value) AS gap", replace: "MAX(value) + MIN(value) AS gap", mustSay: /could not be registered as a verified claim|operator values/ },
    { name: "slice: the latest slice reads every time, not the latest", find: '${t ? ` WHERE ${t} = ${latest}` : ""} ORDER BY name`;', replace: '${t ? ` WHERE ${t} IS NOT NULL` : ""} ORDER BY name`;', mustSay: /AssertionError/ },
    { name: "entity: a flow's key is its first dimension only (the move join)", find: "const on = ds.map((d) => `a.${d} = b.${d}`).join(\" AND \");", replace: "const on = ds.slice(0, 1).map((d) => `a.${d} = b.${d}`).join(\" AND \");", mustSay: /AssertionError/ },
    { name: "entity: the name is the first dimension only", find: "(ds.length === 1 ? `${alias}${ds[0]}` :", replace: "(ds.length >= 1 ? `${alias}${ds[0]}` :", mustSay: /AssertionError/ },
    { name: "roles: uniqueness is judged on the first varying dimension only", find: "const key = `${d.map((i) => row[i]).join(\"\\u0000\")}\\u0000${row[t]}`;", replace: "const key = `${row[d[0]]}\\u0000${row[t]}`;", mustSay: /AssertionError/ },
    { name: "one failed data step stops the run", find: "failures >= 2 ?", replace: "failures >= 1 ?", mustSay: /AssertionError/ },
    { name: "three failed data steps are needed to stop", find: "failures >= 2 ?", replace: "failures >= 3 ?", mustSay: /AssertionError/ },
  ],
  },

// the other twin: the design pack's call book, changed alone
  {
  target: "runtime/pi/design_pack.mjs",
  mutants: [
    { name: "twin: the design pack's call book names its steps differently", find: "const suffix = `s${seq}:${tool}`;", replace: "const suffix = `t${seq}:${tool}`;", mustSay: /call book for/ },
  ],
  },
];

export function runPart(block, from, to) {
  const { target, mutants } = BLOCKS[block];
  runMutants({ test, controlMustSay, env, ...(target ? { target } : {}), mutants: mutants.slice(from, to) });
}
