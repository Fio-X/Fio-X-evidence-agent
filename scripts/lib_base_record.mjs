// Committed output records of an older runtime, for the byte-parity tests.
//
// A byte-parity test compares what the current runtime produces with what an older newsroom.ts produced (tool definitions, handler results,
// files written). The older output is data: it is read from scripts/fixtures/base_records/<name>.json, not from a commit in the history.
// A record is generated, never typed: the test that owns it runs in record mode once,
//   BASE_RECORD_OUT=1 BASELINE_NEWSROOM_TS=<the older newsroom.ts> node scripts/<test>.mjs
// which runs the older file through the same code the test runs it through, checks that the values survive JSON unchanged (so comparing
// against the record equals comparing against a live run), and writes the record. The record holds the sha256 of the older file it came from.
// Normal runs only read the record; a missing or malformed record fails the test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definitionOf } from "./lib_pin_patch.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "base_records");
export const recordPath = (name) => join(DIR, `${name}.json`);
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** True when the test was started in record mode. */
export const recording = () => process.env.BASE_RECORD_OUT === "1";

/** The older source for record mode: only the file named by the environment variable (BASELINE_NEWSROOM_TS unless the test says otherwise). */
export function recordSource(envName = "BASELINE_NEWSROOM_TS") {
  const file = process.env[envName];
  assert.ok(file, `record mode needs ${envName}=<the older file>`);
  return readFileSync(file, "utf8");
}

/** Tools registered by one run, as [name, definition] in registration order. The definition is what the tests compare (definitionOf), parsed. */
export const definitionsOf = (tools) => [...tools].map(([name, tool]) => [name, JSON.parse(definitionOf(tool))]);

/** The inverse, for the pin checker: a Map of name -> tool-shaped object whose definitionOf() is the recorded string. */
export const toolMap = (list) => new Map(list);

/** A value that is recorded must come back from JSON exactly as it went in (no undefined, no Map, no class instance, no key reordering). */
export function lossless(value, label) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), value, `${label}: the value is not unchanged by JSON`);
  return value;
}

export function writeRecord(name, record) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(recordPath(name), `${JSON.stringify(record)}\n`);
}

/** Definitions of several runs (key -> [name, definition] list) stored once per distinct definition: { pool: {hash: definition}, sets: {key: [[name, hash]]} }. */
export function poolDefinitions(byKey) {
  const pool = {}, sets = {};
  for (const [key, list] of Object.entries(byKey)) sets[key] = list.map(([name, definition]) => { const hash = sha256(JSON.stringify(definition)); pool[hash] = definition; return [name, hash]; });
  return { pool, sets };
}
export function unpoolDefinitions(pooled, key) {
  assert.ok(pooled.sets[key], `the record holds ${key}`);
  return toolMap(pooled.sets[key].map(([name, hash]) => [name, pooled.pool[hash]]));
}

export function readRecord(name, requiredKeys, shaKey = "newsroom_ts_sha256") {
  const record = JSON.parse(readFileSync(recordPath(name), "utf8"));
  assert.match(record[shaKey] ?? "", /^[0-9a-f]{64}$/, `${name}: the record names the sha256 of the older source (${shaKey})`);
  for (const key of requiredKeys) assert.ok(record[key] !== undefined, `${name}: the record holds ${key}`);
  return record;
}
