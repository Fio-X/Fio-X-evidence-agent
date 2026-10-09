// NEWSROOM_LOCAL_SOURCE_NOTE=1: acceptedLocalSourceNote builds the chart's source line from the accepted `source_note_file`
// the program recorded in a user file's origin record. Loads runtime/pi/newsroom.ts from a type-stripped copy (no provider, no network).
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "local-source-note-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_")) delete process.env[name];

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const dir = mkdtempSync(join(scratch, "tree-"));
cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
stub(dir, "typebox", `const mk = (b) => (o = {}) => ({ ...b, ...(o && typeof o === "object" && !Array.isArray(o) ? o : {}) });
export const Type = { String: mk({type:"string"}), Number: mk({type:"number"}), Integer: mk({type:"integer"}), Boolean: mk({type:"boolean"}), Any: () => ({}), Null: () => ({}), Unknown: () => ({}), Literal: (v) => ({const:v}), Optional: (s) => ({...s, __optional:true}), Array: (i,o={}) => ({type:"array",items:i,...o}), Union: (a) => ({anyOf:a}), Record: () => ({type:"object"}), Object: (p={},o={}) => ({type:"object",properties:p,required:Object.keys(p).filter((k)=>!p[k].__optional),...o}) };\n`);
stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const pi = join(dir, "runtime", "pi");
const source = readFileSync(join(pi, "newsroom.ts"), "utf8");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(source, { mode: "strip" }));
const { acceptedLocalSourceNote } = await import(join(pi, "newsroom.test-copy.mjs"));

const art = join(scratch, "artifact");
mkdirSync(join(art, "data", "origins"), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
let n = 0;
const origin = (file, extra) => writeFileSync(join(art, "data", "origins", `${String(n++).padStart(4, "0")}.json`), JSON.stringify({ schema_version: "0.7.0", origin: "local_file", original_filename: "X.csv", sha256: "a".repeat(64), file, ...extra }));
const note = (extra = {}) => ({ source_note_file: { publisher: "Our World in Data", dataset: "Energy mix", license: "CC BY 4.0", sha256: "a".repeat(64), note_sha256: "b".repeat(64), ...extra } });
origin("data/a.csv", note());
origin("data/nolicense.csv", note({ license: "" }));
origin("data/badsha.csv", note({ sha256: "c".repeat(64) }));
origin("data/plain.csv", {});
origin("data/long.csv", note({ dataset: "x".repeat(121) }));

// 5. switch off (unset, "0", "true"): nothing
for (const off of [undefined, "0", "true", ""]) {
  if (off === undefined) delete process.env.NEWSROOM_LOCAL_SOURCE_NOTE; else process.env.NEWSROOM_LOCAL_SOURCE_NOTE = off;
  assert.equal(await acceptedLocalSourceNote(["data/a.csv"], "zh"), null, `switch ${off}`);
}
process.env.NEWSROOM_LOCAL_SOURCE_NOTE = "1";
// 1. accepted note: zh and en wording
assert.equal(await acceptedLocalSourceNote(["data/a.csv", "computations/x.json"], "zh"), "Our World in Data《Energy mix》，CC BY 4.0");
assert.equal(await acceptedLocalSourceNote(["data/a.csv"], "en"), 'Our World in Data, "Energy mix", CC BY 4.0');
assert.equal(await acceptedLocalSourceNote(["data/a.csv"]), 'Our World in Data, "Energy mix", CC BY 4.0');
// 2-4. not accepted: null, so the chart keeps today's line
for (const ref of ["data/nolicense.csv", "data/badsha.csv", "data/plain.csv", "data/long.csv", "data/missing.csv"]) assert.equal(await acceptedLocalSourceNote([ref], "zh"), null, ref);
// a chart that also reads a file with no accepted note keeps today's line rather than a partial source
assert.equal(await acceptedLocalSourceNote(["data/a.csv", "data/plain.csv"], "en"), null);
assert.equal(await acceptedLocalSourceNote([], "en"), null);
assert.equal(await acceptedLocalSourceNote(["sources/s.json"], "en"), null);
// a downloaded file's origin is never read as a user note
origin("data/dl.csv", { origin: "download", ...note() });
assert.equal(await acceptedLocalSourceNote(["data/dl.csv"], "en"), null, "downloaded data is unchanged");

// 6. the plan builder lets the program's text win over a model-written source_note: the override spreads after the plan's own params.
const specCore = source.slice(source.indexOf("const programSourceNote = await acceptedLocalSourceNote"));
const afterParams = specCore.indexOf("...normalizedParams,");
const overrideAt = specCore.indexOf("...(programSourceNote ? { source_note: programSourceNote, source_note_program: true } : process.env.NEWSROOM_LOCAL_SOURCE_NOTE === \"1\" ? { source_note_program: undefined } : {}),");
assert.ok(afterParams > 0 && overrideAt > afterParams && overrideAt - afterParams < 140, "the program's source_note is spread right after the model's params");
// 7. K177 part 2: a noted origin plus a later origin of the same file without a note is not accepted; two equal notes still are
origin("data/redo.csv", note());
origin("data/redo.csv", {});
assert.equal(await acceptedLocalSourceNote(["data/redo.csv"], "en"), null, "note, then re-import without the note");
origin("data/twice.csv", note());
origin("data/twice.csv", note());
assert.equal(await acceptedLocalSourceNote(["data/twice.csv"], "en"), 'Our World in Data, "Energy mix", CC BY 4.0', "two imports with the same note");
console.log("PASS local source note: zh/en wording, off unchanged, invalid or partial notes ignored, downloaded data untouched, program text spread after model params");
