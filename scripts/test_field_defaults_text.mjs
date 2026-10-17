// Field descriptions (K869): language, style_profile, delivery_mode (publication_plan), highlight_values, delivery_role (viz_plan).
// Each description gives the allowed values and what an omitted field does; the text is read against the constants and functions the
// code itself uses. Mutations: a default changed while the text stays (red), a text changed while the code stays (red), a handler that
// bypasses the constant (red). Offline; no model, no network.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function tree(label, edit) {
  const dir = makeTestTmp(`field-defaults-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, "src/runtime.rs"), join(dir, "src/runtime.rs"));
  if (edit) edit((name, fn) => { const path = join(dir, "runtime/pi", name); writeFileSync(path, fn(readFileSync(path, "utf8"))); });
  return dir;
}
const mod = (dir, name) => import(`${pathToFileURL(join(dir, "runtime/pi", name)).href}?t=${Math.random()}`);
const swap = (source, from, to) => { assert.ok(source.includes(from), `fixture text missing: ${from}`); return source.replace(from, to); };
const read = (dir, name) => readFileSync(join(dir, "runtime/pi", name), "utf8");

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
// The tool definitions newsroom.ts registers in a tree (the text builders live in newsroom.ts, so the text is read from the tools).
async function toolsOf(dir) {
  const stub = (name, source) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  };
  stub("typebox", TYPEBOX);
  stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  writeFileSync(join(dir, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  const tools = new Map();
  (await mod(dir, "newsroom.test-copy.mjs")).default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}

async function toolsWith(dir, env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await toolsOf(dir); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const textsOf = async (dir) => {
  const tools = await toolsWith(dir);
  const pub = tools.get("newsroom_publication_plan").parameters.properties;
  const viz = tools.get("newsroom_viz_plan").parameters.properties;
  const contract = (await toolsWith(dir, { NEWSROOM_SPEED_CONTRACT_TEXT: "1" })).get("newsroom_viz_plan").parameters.properties.delivery_role.description ?? "";
  const compat = (await toolsWith(dir, { NEWSROOM_PUBLICATION_STYLE_COMPAT: "1" })).get("newsroom_publication_plan").parameters.properties.style_profile.description ?? "";
  return {
    language: pub.language.description ?? "", languageEnum: pub.language.enum, style: pub.style_profile.description ?? "", styleEnum: pub.style_profile.enum,
    styleCompat: compat, mode: pub.delivery_mode.description ?? "", modeEnum: pub.delivery_mode.enum,
    highlight: viz.highlight_values.description ?? "", role: viz.delivery_role.description ?? "", roleEnum: viz.delivery_role.enum, roleContract: contract,
  };
};

// Text from textDir, checks from checkDir. Returns the list of misalignments (empty = aligned).
async function misalignments(textDir, checkDir) {
  const out = [];
  const t = await textsOf(textDir);
  const publication = await mod(checkDir, "publication.mjs");
  const story = await mod(checkDir, "story_graph.mjs");
  const viz = await mod(checkDir, "viz.mjs");
  const newsroomSource = read(checkDir, "newsroom.ts");

  // Pinned literals: a changed constant goes red here even when the text follows it (and the golden is regenerated).
  if (publication.PUBLICATION_DEFAULT_LANGUAGE !== "en" || publication.pageLanguage({}) !== "en") out.push("pinned: the page language default is no longer en");
  if (publication.PUBLICATION_DEFAULT_DELIVERY_MODE !== "html") out.push("pinned: the delivery_mode default is no longer html");
  if (JSON.stringify(publication.PUBLICATION_DELIVERY_MODES) !== JSON.stringify(["html", "scrollytelling", "hybrid"])) out.push("pinned: the delivery_mode list changed");
  if (publication.PUBLICATION_STYLE_FALLBACK !== "analytical_precision") out.push("pinned: the style_profile fallback is no longer analytical_precision");
  if (JSON.stringify(publication.PUBLICATION_STYLE_BY_DIMENSION) !== JSON.stringify([{ dimensions: ["uncertainty"], profile: "uncertainty_forecast" }, { dimensions: ["network"], profile: "investigative_network" }, { dimensions: ["spatial"], profile: "spatial_monitor" }, { dimensions: ["flow", "mechanism", "model"], profile: "systems_explainer" }])) out.push("pinned: the style_profile table changed");
  if (!/export const DEFAULT_DELIVERY_ROLE = "standalone_visual";/.test(newsroomSource)) out.push("pinned: the delivery_role default is no longer standalone_visual");

  // language
  const lang = t.language.match(/^Page language; when omitted the page is (\w+): lang and the renderer's own labels follow it\.$/);
  if (!lang) out.push("the language sentence has an unexpected shape");
  else {
    if (publication.pageLanguage({}).toString() !== lang[1]) out.push(`language default: text says ${lang[1]}, pageLanguage gives ${publication.pageLanguage({})}`);
    if (publication.pageLanguage({ language: "zh" }) !== "zh") out.push("language zh is not kept");
    if (publication.pageLanguage({ language: "xx" }) !== lang[1]) out.push("language: an unknown value no longer falls back to the default");
    if (JSON.stringify(t.languageEnum) !== JSON.stringify(["zh", "en"])) out.push("language enum changed");
  }

  // style_profile
  const style = t.style.match(/^Style profile; when omitted the program picks it from the modules' explanatory_dimension values, first match wins: (.+); none of these -> (\w+)\.$/);
  if (!style) out.push("the style_profile sentence has an unexpected shape");
  else {
    const rows = style[1].split("; ").map((r) => { const [dims, profile] = r.split(" -> "); return { dims: dims.split("/"), profile }; });
    const stated = new Set(rows.flatMap((r) => r.dims));
    for (const r of rows) for (const d of r.dims) if (publication.defaultPublicationStyleProfile([d]) !== r.profile) out.push(`style_profile: ${d} -> text says ${r.profile}, code gives ${publication.defaultPublicationStyleProfile([d])}`);
    for (const d of story.PUBLICATION_DIMENSIONS) if (!stated.has(d) && publication.defaultPublicationStyleProfile([d]) !== style[2]) out.push(`style_profile: ${d} -> text says ${style[2]}, code gives ${publication.defaultPublicationStyleProfile([d])}`);
    if (publication.defaultPublicationStyleProfile([]) !== style[2]) out.push("style_profile: no dimension does not give the stated fallback");
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      if (publication.defaultPublicationStyleProfile([rows[j].dims[0], rows[i].dims[0]]) !== rows[i].profile) out.push(`style_profile: ${rows[i].dims[0]} does not win over ${rows[j].dims[0]}`);
    }
    for (const p of [...rows.map((r) => r.profile), style[2]]) if (!t.styleEnum.includes(p)) out.push(`style_profile: ${p} is not an allowed value`);
    if (!newsroomSource.includes("const legacyStyleProfile = defaultPublicationStyleProfile(")) out.push("the plan handler no longer picks the style profile with defaultPublicationStyleProfile");
    if (t.styleCompat !== `${t.style} If the render's style check would refuse that pick, another accepted profile is used, or the plan is refused if none fits.`) out.push("style_profile text with the compat switch on has an unexpected shape");
  }

  // delivery_mode
  const mode = t.mode.match(/^Delivery mode \(([^)]+)\); when omitted: (\w+)\.$/);
  if (!mode) out.push("the delivery_mode sentence has an unexpected shape");
  else {
    const stated = mode[1].split(", ");
    if (JSON.stringify(stated) !== JSON.stringify(publication.PUBLICATION_DELIVERY_MODES)) out.push("delivery_mode list != the list the render check accepts");
    if (JSON.stringify(t.modeEnum) !== JSON.stringify(stated)) out.push("delivery_mode enum != the stated list");
    for (const v of ["html", "scrollytelling", "hybrid", "zz_new_value"]) {
      const refused = publication.validatePublicationSpec({ delivery: { mode: v } }).some((e) => e.includes("delivery.mode is invalid"));
      if (refused === stated.includes(v)) out.push(`delivery_mode: the render check ${refused ? "refuses" : "accepts"} ${v}, the text says the opposite`);
    }
    if (mode[2] !== publication.PUBLICATION_DEFAULT_DELIVERY_MODE) out.push(`delivery_mode default: text says ${mode[2]}, constant is ${publication.PUBLICATION_DEFAULT_DELIVERY_MODE}`);
    if (!stated.includes(publication.PUBLICATION_DEFAULT_DELIVERY_MODE)) out.push("delivery_mode default is not an allowed value");
    if (!newsroomSource.includes("mode: params.delivery_mode ?? PUBLICATION_DEFAULT_DELIVERY_MODE,")) out.push("the plan handler no longer defaults delivery_mode to the constant");
  }

  // highlight_values: omitted behaves as the empty list; the text says nothing is highlighted
  const HIGHLIGHT = "Category or series values drawn in the one accent colour, for the chart types that paint it. When omitted nothing is highlighted. On a world-map choropleth they instead choose extra labelled countries.";
  if (!read(checkDir, "choropleth.mjs").includes("spec?.highlight_values")) out.push("highlight_values: the world-map choropleth no longer reads highlight_values for its labels");
  if (t.highlight !== HIGHLIGHT) out.push("highlight_values text has an unexpected shape");
  const spec = { chart_type: "horizontal_bar", category_field: "c", title: "Alpha leads", takeaway: "" };
  const rows = [{ c: "Alpha" }, { c: "Beta" }];
  const omitted = viz.titleNamedHighlightValues(spec, rows);
  if (JSON.stringify(omitted) !== JSON.stringify(viz.titleNamedHighlightValues({ ...spec, highlight_values: [] }, rows)) || omitted.length === 0) out.push("highlight_values: omitted is no longer the same as an empty list in the emphasis hint");
  if (!newsroomSource.includes("highlight_values: params.highlight_values ?? [],")) out.push("the viz handler no longer defaults highlight_values to the empty list");

  // delivery_role
  const newsroom = await mod(checkDir, "newsroom.test-copy.mjs").catch(() => null);
  const role = t.role.match(/^When omitted: (\w+)\.$/);
  if (!role) out.push("the delivery_role sentence has an unexpected shape");
  else {
    if (newsroom && newsroom.DEFAULT_DELIVERY_ROLE !== role[1]) out.push(`delivery_role default: text says ${role[1]}, constant is ${newsroom?.DEFAULT_DELIVERY_ROLE}`);
    if (!t.roleEnum.includes(role[1])) out.push("delivery_role default is not an allowed value");
    if (!newsroomSource.includes("const deliveryRole = params.delivery_role ?? DEFAULT_DELIVERY_ROLE;")) out.push("the viz handler no longer defaults delivery_role to the constant");
  }
  const SWITCH_SENTENCE = "infographic_module also needs story_graph_ref and story_node_ids.";
  const count = (hay, needle) => hay.split(needle).length - 1;
  if (count(t.roleContract, t.role) !== 1 || count(t.roleContract, SWITCH_SENTENCE) !== 1) out.push("delivery_role with the contract-text switch on does not carry the default sentence and the switch sentence once each");
  return out;
}

const base = tree("base");
// stage the test-copy the delivery_role check imports (toolsOf writes it next to newsroom.ts)
await toolsOf(base);
assert.deepEqual(await misalignments(base, base), [], "real code is aligned");
console.log("alignment: PASS (language, style_profile, delivery_mode, highlight_values, delivery_role)");

const caught = [];
const withCopy = async (dir) => { await toolsOf(dir); return dir; };
const expectRed = async (label, textDir, checkDir, needle) => {
  await withCopy(checkDir); if (textDir !== checkDir) await withCopy(textDir);
  const found = await misalignments(textDir, checkDir);
  assert.ok(found.some((m) => m.includes(needle)), `mutation not caught: ${label} (got: ${found.join(" | ") || "aligned"})`);
  caught.push(label);
};
const edit = (label, name, from, to) => tree(label, (e) => e(name, (s) => swap(s, from, to)));
// language
await expectRed("language default changed in the renderer, text unchanged", base, edit("lang-default", "publication.mjs", "PUBLICATION_DEFAULT_LANGUAGE='en'", "PUBLICATION_DEFAULT_LANGUAGE='zh'"), "language default");
await expectRed("language text changed, code unchanged", edit("lang-text", "newsroom.ts", "when omitted the page is ${PUBLICATION_DEFAULT_LANGUAGE}:", "when omitted the page is zh:"), base, "language default");
// style_profile
await expectRed("style row changed in the table, text unchanged", base, edit("style-row", "publication.mjs", "profile:'spatial_monitor'", "profile:'systems_explainer'"), "style_profile: spatial");
await expectRed("style fallback changed, text unchanged", base, edit("style-fallback", "publication.mjs", "PUBLICATION_STYLE_FALLBACK='analytical_precision'", "PUBLICATION_STYLE_FALLBACK='systems_explainer'"), "style_profile");
await expectRed("style row order swapped, text unchanged", base, edit("style-order", "publication.mjs", "[{dimensions:['uncertainty'],profile:'uncertainty_forecast'},{dimensions:['network'],profile:'investigative_network'}", "[{dimensions:['network'],profile:'investigative_network'},{dimensions:['uncertainty'],profile:'uncertainty_forecast'}"), "does not win");
await expectRed("style handler bypasses the table", base, edit("style-bypass", "newsroom.ts", "const legacyStyleProfile = defaultPublicationStyleProfile(modules.map((m: any) => m.explanatory_dimension));", "const legacyStyleProfile = \"analytical_precision\";"), "no longer picks the style profile");
// delivery_mode
await expectRed("delivery mode added to the render check, text unchanged", base, edit("mode-added", "publication.mjs", "PUBLICATION_DELIVERY_MODES=['html','scrollytelling','hybrid']", "PUBLICATION_DELIVERY_MODES=['html','scrollytelling','hybrid','zz_new_value']"), "delivery_mode list");
await expectRed("delivery mode default changed, text unchanged", base, edit("mode-default", "publication.mjs", "PUBLICATION_DEFAULT_DELIVERY_MODE='html'", "PUBLICATION_DEFAULT_DELIVERY_MODE='hybrid'"), "delivery_mode default");
await expectRed("delivery mode handler hard-codes the default", base, edit("mode-hardcode", "newsroom.ts", "mode: params.delivery_mode ?? PUBLICATION_DEFAULT_DELIVERY_MODE,", "mode: params.delivery_mode ?? \"html\","), "no longer defaults delivery_mode");
// highlight_values
await expectRed("highlight text changed, code unchanged", edit("hl-text", "newsroom.ts", "When omitted nothing is highlighted.", "When omitted two colours are used."), base, "highlight_values text");
await expectRed("highlight default changed in the handler", base, edit("hl-default", "newsroom.ts", "highlight_values: params.highlight_values ?? [],", "highlight_values: params.highlight_values ?? [\"x\"],"), "no longer defaults highlight_values");
// delivery_role
await expectRed("delivery_role default changed in the constant, text unchanged", base, edit("role-default", "newsroom.ts", 'export const DEFAULT_DELIVERY_ROLE = "standalone_visual";', 'export const DEFAULT_DELIVERY_ROLE = "infographic_module";'), "delivery_role default");
await expectRed("delivery_role handler hard-codes the default", base, edit("role-hardcode", "newsroom.ts", "const deliveryRole = params.delivery_role ?? DEFAULT_DELIVERY_ROLE;", 'const deliveryRole = params.delivery_role ?? "standalone_visual";'), "no longer defaults delivery_role");
// Constants changed with the text following them (text and checks read the same edited tree): only the pinned literals catch these.
const same = async (label, name, from, to, needle) => { const d = edit(label, name, from, to); await expectRed(label, d, d, needle); };
await same("pinned: language default en -> zh, text follows", "publication.mjs", "PUBLICATION_DEFAULT_LANGUAGE='en'", "PUBLICATION_DEFAULT_LANGUAGE='zh'", "pinned: the page language");
await same("pinned: delivery mode default html -> hybrid, text follows", "publication.mjs", "PUBLICATION_DEFAULT_DELIVERY_MODE='html'", "PUBLICATION_DEFAULT_DELIVERY_MODE='hybrid'", "pinned: the delivery_mode default");
await same("pinned: hybrid dropped from the modes, text follows", "publication.mjs", "PUBLICATION_DELIVERY_MODES=['html','scrollytelling','hybrid']", "PUBLICATION_DELIVERY_MODES=['html','scrollytelling']", "pinned: the delivery_mode list");
await same("pinned: style fallback changed, text follows", "publication.mjs", "PUBLICATION_STYLE_FALLBACK='analytical_precision'", "PUBLICATION_STYLE_FALLBACK='systems_explainer'", "pinned: the style_profile fallback");
await same("pinned: a style table row dropped, text follows", "publication.mjs", "{dimensions:['network'],profile:'investigative_network'},", "", "pinned: the style_profile table");
await same("pinned: delivery_role default changed, text follows", "newsroom.ts", 'export const DEFAULT_DELIVERY_ROLE = "standalone_visual";', 'export const DEFAULT_DELIVERY_ROLE = "infographic_module";', "pinned: the delivery_role default");
await expectRed("style compat sentence goes back to first-accepted wording", edit("sc-text", "newsroom.ts", "another accepted profile is used, or the plan is refused if none fits.", "the first profile it accepts is used instead."), base, "compat switch");
await expectRed("highlight text claims the grey chart again", edit("hl-grey", "newsroom.ts", "When omitted nothing is highlighted. On a world-map", "When omitted nothing is highlighted and the chart is one neutral grey. On a world-map"), base, "highlight_values text");
await expectRed("choropleth stops reading highlight_values", base, edit("hl-choro", "choropleth.mjs", "spec?.highlight_values", "spec?.highlights"), "world-map choropleth");
console.log(`mutations: PASS (${caught.length} caught)`);
for (const label of caught) console.log(`  caught: ${label}`);
