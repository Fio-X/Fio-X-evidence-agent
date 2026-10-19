// One of two places the symbol map switch is read (K1122, K1199): this file (the chart code, the grammar table and the page lint take it) and newsroom.ts's inline copy of the rule in its grammar table (so the agent group needs no import from here). scripts/test_flip_defaults_switches.mjs pins them equal; removing the "0" means changing both.
// NEWSROOM_SYMBOL_MAP is on unless the value is exactly "0": unset, an empty value, false, off, no, " 0" and "00" all leave it on.
// The other gated forms in the table (NEWSROOM_TILE_MAP, NEWSROOM_STORY_FORMS, and the not yet signed crop switch, whose name starts with this one) stay exactly "1": the comparison below is on the whole name, never a prefix.
// No imports, so every reader here (the chart code, the grammar table, the page lint) can take it without loading anything else.
const SYMBOL_MAP_NAME = "NEWSROOM_SYMBOL_MAP";

export function symbolMapOn(env = process.env) {
  return env[SYMBOL_MAP_NAME] !== "0";
}

// A gated grammar form is on when its switch is exactly "1"; the symbol map's own switch is on unless exactly "0".
export function gatedFormOn(envName, env = process.env) {
  return envName === SYMBOL_MAP_NAME ? symbolMapOn(env) : env[envName] === "1";
}
