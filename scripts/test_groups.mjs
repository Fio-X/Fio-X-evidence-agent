// The four-group list (runtime/pi/groups.json): every CLI command, every Pi tool and every tracked source file is in exactly one
// group, and the tool-order switch (NEWSROOM_GROUP_TOOL_ORDER=1) lists tools in group order without changing anything but the
// description label. A new tool, command or file without a group fails here.
//
// Run: node scripts/test_groups.mjs   (offline; loads a type-stripped copy of runtime/pi/newsroom.ts like test_tool_defs_unchanged.mjs)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RAW = readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8");
const { GROUP_ORDER, fileGroupMatches, groupLabel, orderToolsByGroup, toolGroup } = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const results = [];
const check = (name) => results.push(name);

// JSON.parse keeps the last of two equal keys, so a duplicate (a thing listed twice, maybe in two groups) is looked for in the text.
function duplicateKeys(text) {
  const found = [];
  const stack = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*(:)?|([{}[\],])/g;
  let match;
  let expectKey = false;
  while ((match = re.exec(text))) {
    if (match[3] === "{") { stack.push({ type: "o", keys: new Set() }); expectKey = true; }
    else if (match[3] === "[") { stack.push({ type: "a" }); expectKey = false; }
    else if (match[3] === "}" || match[3] === "]") { stack.pop(); expectKey = false; }
    else if (match[3] === ",") expectKey = stack.at(-1)?.type === "o";
    else if (match[2] === ":" && stack.at(-1)?.type === "o") {
      const top = stack.at(-1);
      if (top.keys.has(match[1])) found.push(match[1]);
      top.keys.add(match[1]);
      expectKey = false;
    }
  }
  return found;
}
const groups = JSON.parse(RAW);
const validate = ({ list, text = JSON.stringify(list), commands, tools, files }) => {
  const problems = [];
  for (const key of duplicateKeys(text)) problems.push(`listed twice: ${key}`);
  for (const [section, names] of [["commands", commands], ["tools", tools]]) {
    for (const name of names) if (!list[section]?.[name]?.group) problems.push(`${section.slice(0, -1)} without a group: ${name}`);
    for (const name of Object.keys(list[section] ?? {})) {
      if (!names.includes(name)) problems.push(`${section.slice(0, -1)} listed but not present: ${name}`);
      else if (!list.groups.includes(list[section][name].group)) problems.push(`${section.slice(0, -1)} in an unknown group: ${name}`);
    }
  }
  // Files: each tracked path matches exactly one entry or one directory rule.
  for (const name of files) {
    const matches = fileGroupMatches(name, list);
    if (matches.length === 0) problems.push(`file without a group: ${name}`);
    else if (matches.length > 1) problems.push(`file covered twice (${matches.map((m) => m.via).join(" and ")}): ${name}`);
    else if (!list.groups.includes(matches[0].group)) problems.push(`file in an unknown group: ${name}`);
  }
  for (const name of Object.keys(list.files ?? {})) if (!files.includes(name)) problems.push(`file listed but not present: ${name}`);
  for (const rule of list.file_rules ?? []) if (!files.some((name) => fileGroupMatches(name, { files: {}, file_rules: [rule] }).length)) problems.push(`rule matches nothing: ${rule.prefix}`);
  return problems;
};

// ---- real inputs -------------------------------------------------------------------------------------------------------------
const commandNames = (() => {
  const source = readFileSync(join(ROOT, "src/cli.rs"), "utf8");
  const body = source.slice(source.indexOf("pub enum Commands {"));
  const block = body.slice(0, body.indexOf("\n}\n"));
  // Bare `news` (the interactive launcher) has no enum variant; it is registered as a command of the agent group (K213).
  return [...block.matchAll(/^    ([A-Z][A-Za-z0-9]*)\(/gm)].map((m) => m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()).concat("interactive");
})();
const trackedFiles = spawnSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "src", "runtime/pi"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
assert.ok(commandNames.length >= 7 && trackedFiles.length > 100, "found the commands and the tracked files");

// ---- tools, under every profile, switches off and on ----------------------------------------------------------------------------
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
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
const TREE = mkdtempSync(join(tmpdir(), "groups-tree-"));
process.on("exit", () => rmSync(TREE, { recursive: true, force: true }));
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));

const PROFILES = ["investigate", "visual", "publication", "visual-story", "competition", "full"];
const SWITCHES = ["NEWSROOM_GROUP_TOOL_ORDER", "NEWSROOM_GROUP_BOUNDARY", "NEWSROOM_PHASE"];
let n = 0;
async function registered(profile, env = {}) {
  for (const key of SWITCHES) delete process.env[key];
  process.env.NEWSROOM_TOOL_PROFILE = profile;
  Object.assign(process.env, env);
  const tools = [];
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.push(tool) : () => {}) }));
  return tools;
}
const seen = new Set();
const perProfile = {};
for (const profile of PROFILES) {
  const off = await registered(profile);
  const on = await registered(profile, { NEWSROOM_GROUP_TOOL_ORDER: "1" });
  const names = off.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, `${profile}: a tool is registered twice`);
  assert.deepEqual(on.map((t) => t.name).sort(), [...names].sort(), `${profile}: the order switch registers the same tools`);
  for (const name of names) seen.add(name);
  perProfile[profile] = { off, on };
}
// Hidden and conditional tools are not in every profile: the hidden chart tool and the conditional ones come from direct
// registration under their own conditions, so look for them with the conditions that register them.
for (const env of [{ NEWSROOM_PHASE: "all" }]) for (const t of await registered("full", env)) seen.add(t.name);
const toolNames = [...seen].sort();
const listed = Object.keys(groups.tools).sort();
assert.deepEqual(toolNames.filter((name) => !listed.includes(name)), [], "every registered tool is in groups.json");
{
  const registeredEverywhere = new Set(PROFILES.flatMap((p) => perProfile[p].off.map((t) => t.name)));
  const hiddenOrConditional = Object.entries(groups.tools).filter(([, v]) => v.hidden || v.conditional).map(([k]) => k);
  const missing = listed.filter((name) => !registeredEverywhere.has(name) && !hiddenOrConditional.includes(name));
  assert.deepEqual(missing, [], "a tool in groups.json that no profile registers must be marked hidden or conditional");
}
check(`tools: ${toolNames.length} registered across ${PROFILES.length} profiles, every one in exactly one group, none listed twice`);

// ---- commands, files, duplicates, and the negative cases -----------------------------------------------------------------------
assert.deepEqual(validate({ list: groups, text: RAW, commands: commandNames, tools: toolNames.concat(listed.filter((n) => !toolNames.includes(n))), files: trackedFiles }).filter((p) => !p.startsWith("tool listed but not present")), [], "groups.json covers what exists");
check(`commands: ${commandNames.length}, each in one group (read from the Commands enum in src/cli.rs)`);
check(`files: ${trackedFiles.length} tracked under src/ and runtime/pi/, each covered by exactly one entry or one directory rule (${Object.keys(groups.file_rules).length} rules), none missing, none extra`);
{
  const base = { list: groups, commands: commandNames, tools: listed, files: trackedFiles };
  assert.deepEqual(validate(base), [], "the real list passes its own validator");
  const without = (section, name) => ({ ...groups, [section]: Object.fromEntries(Object.entries(groups[section]).filter(([k]) => k !== name)) });
  assert.match(validate({ ...base, list: without("tools", "newsroom_update_plan") }).join(), /tool without a group: newsroom_update_plan/);
  assert.match(validate({ ...base, list: without("files", "src/verify.rs") }).join(), /file without a group: src\/verify\.rs/);
  assert.match(validate({ ...base, list: { ...groups, files: { ...groups.files, "runtime/pi/vendor/plotly-3.3.1.min.js": { group: "visual" } } } }).join(), /file covered twice .*plotly/, "an entry under a directory rule is covered twice");
  assert.match(validate({ ...base, files: [...base.files, "runtime/pi/vendor/new-lib.js"] }).join(), /^$/, "a new file under a directory rule is covered by it");
  assert.match(validate({ ...base, list: { ...groups, file_rules: [...groups.file_rules, { prefix: "runtime/pi/nowhere/", group: "visual" }] } }).join(), /rule matches nothing: runtime\/pi\/nowhere\//);
  assert.match(validate({ ...base, list: without("commands", "verify") }).join(), /command without a group: verify/);
  assert.match(validate({ ...base, tools: [...listed, "brand_new_tool"] }).join(), /tool without a group: brand_new_tool/);
  assert.match(validate({ ...base, files: [...base.files, "src/new_file.rs"] }).join(), /file without a group: src\/new_file\.rs/);
  assert.match(validate({ ...base, list: { ...groups, tools: { ...groups.tools, ghost_tool: { group: "visual" } } } }).join(), /tool listed but not present: ghost_tool/);
  assert.match(validate({ ...base, list: { ...groups, tools: { ...groups.tools, newsroom_update_plan: { group: "nonsense" } } } }).join(), /unknown group: newsroom_update_plan/);
  const twice = `{"groups":["agent"],"tools":{"a":{"group":"agent"},"a":{"group":"visual"}}}`;
  assert.deepEqual(duplicateKeys(twice), ["a"], "a duplicate key is found in the text");
  assert.deepEqual(duplicateKeys(RAW), [], "no key is listed twice in groups.json");
  check("negative: a missing tool, command or file, an extra entry, an unknown group and a duplicate key each fail");
}
assert.deepEqual(GROUP_ORDER, groups.groups, "the order the module uses is the order the list gives");
for (const [section, entries] of Object.entries({ commands: groups.commands, tools: groups.tools, files: groups.files })) {
  for (const [name, value] of Object.entries(entries)) assert.ok(GROUP_ORDER.includes(value.group), `${section}/${name}`);
}

{ // newsroom_illustration_generate is registered only when an illustration adapter is configured (NEWSROOM_REFUSED_OPTIONS_FIX on unless exactly "0"); "0" registers it as before.
  const names = async (env) => (await registered("full", env)).map((t) => t.name);
  const tool = "newsroom_illustration_generate";
  const on = { NEWSROOM_REFUSED_OPTIONS_FIX: "1", NEWSROOM_ILLUSTRATION_ADAPTER: "" };
  assert.equal((await names(on)).includes(tool), false, "default, no adapter: not registered");
  assert.equal((await names({ ...on, NEWSROOM_ILLUSTRATION_ADAPTER: "test-adapter" })).includes(tool), true, "adapter set: registered");
  assert.equal((await names({ ...on, NEWSROOM_REFUSED_OPTIONS_FIX: "0" })).includes(tool), true, '"0", no adapter: registered as before');
  assert.equal(groups.tools[tool].conditional, true);
  assert.equal(groups.tools[tool].group, "visual");
  assert.equal(toolGroup(tool), "visual", "in its group when registered");
  check("tools: newsroom_illustration_generate is conditional (adapter set, or REFUSED_OPTIONS_FIX=0, registers it)");
}

{ // The hidden chart tool and the ten conditional tools are listed, flagged, and counted in the 62 entries.
  const flagged = (flag) => Object.entries(groups.tools).filter(([, v]) => v[flag]).map(([k]) => k).sort();
  assert.deepEqual(flagged("hidden"), ["newsroom_chart"]);
  assert.equal(flagged("conditional").length, 10);
  assert.equal(Object.keys(groups.tools).length, 62);
  check("tools: 62 entries = 51 registered under a profile + 10 conditional + the hidden newsroom_chart, the last ten flagged");
}

// ---- the order switch ----------------------------------------------------------------------------------------------------------
const bytes = {};
for (const profile of PROFILES) {
  const { off, on } = perProfile[profile];
  assert.equal(on.length, off.length);
  const rank = (name) => { const i = GROUP_ORDER.indexOf(toolGroup(name)); return i === -1 ? GROUP_ORDER.length : i; };
  const ranks = on.map((t) => rank(t.name));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${profile}: tools come in group order`);
  const position = new Map(off.map((t, i) => [t.name, i]));
  for (let i = 1; i < on.length; i++) if (rank(on[i].name) === rank(on[i - 1].name)) assert.ok(position.get(on[i].name) > position.get(on[i - 1].name), `${profile}: stable inside a group`);
  const byName = new Map(off.map((t) => [t.name, t]));
  for (const tool of on) {
    const base = byName.get(tool.name);
    const label = toolGroup(tool.name) ? groupLabel(toolGroup(tool.name)) : "";
    assert.equal(tool.description, label + base.description, `${profile}/${tool.name}: only the label is added to the description`);
    for (const key of ["name", "label", "promptSnippet", "promptGuidelines", "parameters"]) assert.deepEqual(tool[key], base[key], `${profile}/${tool.name}: ${key} unchanged`);
  }
  const size = (list) => Buffer.byteLength(JSON.stringify(list.map(({ name, label, description, promptSnippet, promptGuidelines, parameters }) => ({ name, label, description, promptSnippet, promptGuidelines, parameters }))));
  bytes[profile] = { tools: off.length, off: size(off), on: size(on) };
}
check("order switch: group order, stable inside a group, only the description label differs, nothing else in any definition (6 profiles)");
{ // Unknown tool: last, unlabeled, unchanged.
  const out = orderToolsByGroup([{ name: "zz_unknown", description: "x" }, { name: "newsroom_update_plan", description: "y" }]);
  assert.deepEqual(out.map((t) => t.name), ["newsroom_update_plan", "zz_unknown"]);
  assert.equal(out[1].description, "x");
  check("order switch: a tool missing from the list goes last, unlabeled");
}
{ // Exact value only.
  for (const value of ["true", "yes", "on", "0", ""]) {
    const tools = await registered("investigate", { NEWSROOM_GROUP_TOOL_ORDER: value });
    assert.deepEqual(tools.map((t) => t.description), perProfile.investigate.off.map((t) => t.description), `value ${JSON.stringify(value)} leaves the switch off`);
  }
  check("switch: only the exact value 1 turns the order on");
{ // Phase filtering and the boundary switch are independent of the order switch.
  for (const phase of ["core", "visual", "publication", "all"]) {
    const off = (await registered("full", { NEWSROOM_PHASE: phase })).map((t) => t.name).sort();
    const on = (await registered("full", { NEWSROOM_PHASE: phase, NEWSROOM_GROUP_TOOL_ORDER: "1" })).map((t) => t.name).sort();
    const both = (await registered("full", { NEWSROOM_PHASE: phase, NEWSROOM_GROUP_TOOL_ORDER: "1", NEWSROOM_GROUP_BOUNDARY: "1" })).map((t) => t.name).sort();
    const boundaryOnly = await registered("full", { NEWSROOM_PHASE: phase, NEWSROOM_GROUP_BOUNDARY: "1" });
    assert.deepEqual(on, off, `phase ${phase}: same tool set with the order on`);
    assert.deepEqual(both, off, `phase ${phase}: same tool set with both switches on`);
    const plain = await registered("full", { NEWSROOM_PHASE: phase });
    assert.deepEqual(boundaryOnly.map((t) => [t.name, t.description, JSON.stringify(t.parameters)]), plain.map((t) => [t.name, t.description, JSON.stringify(t.parameters)]), `phase ${phase}: the boundary switch alone changes no definition or order`);
  }
  check("switches are independent: phases keep the same tool set with the order on, and the boundary switch alone changes no definition or order");
}
}
{ // Every Pi tool carries its group.action name in a separate field (no tool is renamed); no CLI entry exists yet, so none is claimed.
  const table = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
  const seen = new Set();
  for (const [name, row] of Object.entries(table.tools)) {
    assert.equal(row.registered_as, `${row.group}.${name.replace(/^newsroom_/, "")}`, `${name}: registered_as is group.action`);
    assert.ok(!seen.has(row.registered_as), `${name}: registered_as is unique`);
    seen.add(row.registered_as);
    assert.ok(Object.hasOwn(row, "cli_entry"), `${name}: cli_entry is stated`);
    assert.equal(row.cli_entry, null, `${name}: no CLI entry exists, none is claimed`);
  }
  check(`tool table: all ${seen.size} tools carry registered_as (group.action, unique) and an explicit cli_entry`);
}
console.log(JSON.stringify({ bytes }));
for (const name of results) console.log(`  ok  ${name}`);
console.log(`groups: PASS (${results.length} checks)`);
