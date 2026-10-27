// Who may write the chain's rejection record (infographics/chain-rejections/<sha>.json)?
// 1. through the registered entry (the model's path, boundary context = newsroom_infographic_chain) the record is stored;
// 2. the same call made the way the design pack makes it (stagedChainTools): in context newsroom_design_pack the record is stored too (it is a listed requester
//    of the chain-rejections row of groups.json), in context newsroom_design_pack_draft it is refused with nothing stored and no hint;
// 3. the patch tool reads and accepts the records from 1 and 2;
// 4. mutation: the same checks on a copy of the table without newsroom_design_pack in that row turn red.
// Offline, node only. The loader is the one of test_patch_retry.mjs; the only addition is an export appended to the type-stripped copy so the test can
// reach stagedChainTools (the product file is untouched).
import "./location_backing_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { checkSchema } = await import(join(ROOT, "runtime/pi/tool_chain.mjs"));

const stub = (dir, name, source, extra = {}) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js", ...extra }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
const TREE = makeTestTmp("chain-req-tree-");
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX, { exports: { ".": "./index.js", "./compile": "./compile.js" } });
writeFileSync(join(TREE, "node_modules", "typebox", "compile.js"), `import { checkSchema } from ${JSON.stringify(pathToFileURL(join(ROOT, "runtime/pi/tool_chain.mjs")).href)};
export const Compile = (schema) => ({ Check: (v) => checkSchema(schema, v).length === 0, Errors: (v) => checkSchema(schema, v).map((message) => ({ instancePath: "", message })) });\n`);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }) + "\nexport const __stagedChainTools = stagedChainTools;\n");

// Must be the tree's own groups.mjs: the copy of newsroom.ts uses that module instance (its AsyncLocalStorage), not the repository's.
const { runInTool } = await import(pathToFileURL(join(TREE, "runtime/pi/groups.mjs")).href);

const art = join(makeTestTmp("chain-req-run-"), "run");
mkdirSync(join(art, "infographics"), { recursive: true });
cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
for (const k of ["NEWSROOM_PHASE", "NEWSROOM_GROUP_ENFORCE"]) delete process.env[k]; // enforcement stays at its default (on)
Object.assign(process.env, { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_CHAIN_PATCH: "1" });
const tools = new Map();
const mod = await import(`${pathToFileURL(COPY).href}?v=1`);
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const staged = mod.__stagedChainTools.get("newsroom_infographic_chain");
assert.ok(tools.get("newsroom_infographic_chain") && tools.get("newsroom_infographic_chain_patch") && staged, "chain, chain patch and staged chain are registered");

const HINT = /\nSend only the change: (newsroom_infographic_chain_patch) patch_of=(infographics\/chain-rejections\/[0-9a-f]{64}\.json)$/;
const listing = () => { try { return readdirSync(join(art, "infographics/chain-rejections")); } catch { return []; } };
// Not a valid plan: the chain's own validation refuses it before anything is built.
const bad = () => ({ title: "x" });
// The chain refuses either by throwing or, more often, by returning a STOPPED result; the refusal text is the message or the result's first text block.
const refusal = async (promise) => {
  let result;
  try { result = await promise; } catch (error) { return String(error.message); }
  if (result?.details?.chainStatus !== "STOPPED") throw new Error(`expected a refusal, got ${JSON.stringify(result?.details?.chainStatus)}`);
  return String(result.content.find((block) => block?.type === "text")?.text ?? "");
};
const results = [];
const ok = async (name, f) => { await f(); results.push(name); console.log(`  ok  ${name}`); };

let ref;
await ok("1 registered entry (context newsroom_infographic_chain): refused, record stored, hint names it", async () => {
  assert.deepEqual(listing(), []);
  const message = await refusal(tools.get("newsroom_infographic_chain").execute("c1", bad()));
  const hint = HINT.exec(message);
  assert.ok(hint, `no patch hint in: ${message.slice(-300)}`);
  ref = hint[2];
  assert.deepEqual(listing(), [ref.split("/").pop()]);
  const record = JSON.parse(readFileSync(join(art, ref), "utf8"));
  assert.deepEqual(Object.keys(record).sort(), ["kind", "params", "schema_version", "tool"]);
  assert.equal(record.kind, "rejected_call");
  assert.equal(record.tool, "newsroom_infographic_chain");
  assert.deepEqual(record.params, bad());
  assert.match(ref, /^infographics\/chain-rejections\/[0-9a-f]{64}\.json$/);
});


// Own params (the record name is the hash of the params, so the same params as in 1 would give the same file).
const PACK_PARAMS = { title: "pack" };
// One check, usable on any tree: the design-pack context stores the record and names it in the hint. Throws when it does not.
const designPackStores = async (stagedTool, runIn, list, dir) => {
  const before = list();
  const message = await refusal(runIn("newsroom_design_pack", () => stagedTool.execute(`d:pack:${before.length}`, PACK_PARAMS, undefined, undefined, undefined, { chainDone: [] })));
  const hint = HINT.exec(message);
  assert.ok(hint, `no hint: ${message.slice(-300)}`);
  assert.deepEqual(list().filter((f) => !before.includes(f)), [hint[2].split("/").pop()]);
  const record = JSON.parse(readFileSync(join(dir, hint[2]), "utf8"));
  assert.equal(record.kind, "rejected_call");
  assert.deepEqual(record.params, PACK_PARAMS);
  return hint[2];
};

let packRef;
await ok("2a design-pack context (the product table): refused, record stored, hint names it", async () => { packRef = await designPackStores(staged, runInTool, listing, art); });
await ok("2b draft context (visual group): still refused, nothing stored, no hint", async () => {
  const before = listing();
  const message = await refusal(runInTool("newsroom_design_pack_draft", () => staged.execute("d:draft", bad(), undefined, undefined, undefined, { chainDone: [] })));
  assert.ok(!HINT.test(message) && !/Send only the change/.test(message), `unexpected hint: ${message.slice(-300)}`);
  assert.deepEqual(listing(), before, "no new record");
});
await ok("2c control: context newsroom_infographic_chain stores a record as before", async () => {
  const before = listing();
  const message = await refusal(runInTool("newsroom_infographic_chain", () => staged.execute("d:control", { title: "control" }, undefined, undefined, undefined, { chainDone: [] })));
  assert.ok(HINT.test(message), `no hint: ${message.slice(-300)}`);
  assert.equal(listing().length, before.length + 1);
});

for (const [name, r] of [["1", () => ref], ["2a", () => packRef]]) {
  await ok(`3(${name}) patch tool reads the stored record and accepts it (the patched call is judged by the chain again)`, async () => {
    const message = await refusal(tools.get("newsroom_infographic_chain_patch").execute(`p:${name}`, { patch_of: r(), patch: [{ op: "replace", path: "/title", value: "y" }] }));
    assert.ok(!/PATCH_BASE_NOT_FOUND/.test(message), `record not found: ${message.slice(0, 300)}`);
    assert.ok(!/PATCH_INVALID/.test(message), `patch_of not accepted: ${message.slice(0, 300)}`);
    console.log(`      patch tool answer: ${message.slice(0, 160).replace(/\n/g, " ")}`);
  });
}

// 4. Mutation: the same table with newsroom_design_pack taken out of the row. The design-pack check must then fail, the draft one and the control are unchanged.
const TREE2 = makeTestTmp("chain-req-tree2-");
cpSync(TREE, TREE2, { recursive: true });
const tablePath = join(TREE2, "runtime/pi/groups.json");
const table = JSON.parse(readFileSync(tablePath, "utf8"));
let rows = 0;
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (!o || typeof o !== "object") return;
  if (o.writer === "agent_record_writer" && Array.isArray(o.paths) && o.paths.includes("infographics/chain-rejections/")) {
    assert.ok(o.requesters.includes("newsroom_design_pack") && !o.requesters.includes("newsroom_design_pack_draft"), "product row lists the pack, not the draft");
    o.requesters = o.requesters.filter((name) => name !== "newsroom_design_pack");
    rows += 1;
  }
  Object.values(o).forEach(walk);
})(table);
assert.equal(rows, 1, "exactly one chain-rejections row");
writeFileSync(tablePath, JSON.stringify(table, null, 2));
const art2 = join(makeTestTmp("chain-req-run2-"), "run");
mkdirSync(join(art2, "infographics"), { recursive: true });
cpSync(join(ROOT, "config"), join(art2, "config"), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art2;
const tools2 = new Map();
const mod2 = await import(`${pathToFileURL(join(TREE2, "runtime/pi/newsroom.test-copy.mjs")).href}?v=2`);
mod2.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools2.set(tool.name, tool) : () => {}) }));
const staged2 = mod2.__stagedChainTools.get("newsroom_infographic_chain");
const { runInTool: runInTool2 } = await import(pathToFileURL(join(TREE2, "runtime/pi/groups.mjs")).href);
const listing2 = () => { try { return readdirSync(join(art2, "infographics/chain-rejections")); } catch { return []; } };
await ok("4 mutation (name removed from the row): the design-pack check goes red, nothing is stored", async () => {
  await assert.rejects(() => designPackStores(staged2, runInTool2, listing2, art2), /no hint/);
  assert.deepEqual(listing2(), []);
});
await ok("4c mutation tree: the control context still stores (the check is about the one name)", async () => {
  const message = await refusal(runInTool2("newsroom_infographic_chain", () => staged2.execute("d:control2", { title: "control" }, undefined, undefined, undefined, { chainDone: [] })));
  assert.ok(HINT.test(message));
  assert.equal(listing2().length, 1);
});

// 5. The draft tool carries the skeleton op (wiring only: its token is private to newsroom.ts, so the op itself is tested through the pure functions in
//    test_page_skeleton.mjs). With the pack on, the tool is registered, accepts refs/charts/claims, and still refuses a call without the pack's token.
Object.assign(process.env, { NEWSROOM_SPEED_DESIGN_PACK: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1" });
const tools3 = new Map();
const mod3 = await import(`${pathToFileURL(COPY).href}?v=3`);
mod3.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools3.set(tool.name, tool) : () => {}) }));
await ok("5 draft tool: skeleton op is wired, its parameters exist, a call without the pack's token is refused", async () => {
  const draft = tools3.get("newsroom_design_pack_draft");
  assert.ok(draft, "draft tool registered with the pack on");
  for (const key of ["refs", "charts", "claims"]) assert.ok(draft.parameters.properties[key], key);
  await assert.rejects(() => draft.execute("s1", { op: "skeleton", refs: {}, charts: [], claims: [] }), /DESIGN_PACK_DRAFT_INTERNAL/);
});
console.log(`\n${results.length} checks passed`);
