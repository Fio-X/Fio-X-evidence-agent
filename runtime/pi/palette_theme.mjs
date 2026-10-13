// Topic-driven colour themes for charts and the page shell.
//
// NEWSROOM_PALETTE_BY_THEME=1 (exact "1", default off): a chart or page plan may carry a closed `theme` (the topic) and an optional
// closed `value_direction`; the renderers pick a muted or bright-but-softened colour family from them. The model only ever names the topic, never a colour.
// A missing or unknown topic is the blue-grey family. When higher values are worse, the green family is never used, for ramps or
// accents. Only the renderers (viz.mjs, infographic.mjs) import this module; no gate reads a theme or a colour.

export const PALETTE_THEME_TOPICS = ["money", "energy", "trade", "climate", "environment", "agriculture", "land", "population", "health", "culture", "conflict", "refugees"];
export const PALETTE_VALUE_DIRECTIONS = ["higher_better", "higher_worse", "neutral"];

export function paletteByThemeEnabled() { return process.env.NEWSROOM_PALETTE_BY_THEME === "1"; }

const TOPIC_FAMILY = {
  money: "blue_grey", energy: "blue_grey", trade: "blue_grey", climate: "lake",
  environment: "olive_green", agriculture: "olive_green", land: "olive_green",
  population: "coral",
  health: "grey_purple", culture: "lavender",
  conflict: "graphite", refugees: "graphite",
};
// Environment and agriculture use the fresh green only when the plan says higher is better; neutral or missing stays olive, and
// higher-is-worse never reaches a green family at all (see resolvePaletteTheme).
const TOPIC_FAMILY_WHEN_BETTER = { environment: "fresh_green", agriculture: "fresh_green" };

// Seven classes, light to dark. `green` marks a family that reads as green and so is never used when higher is worse.
export const PALETTE_FAMILIES = {
  blue_grey: { green: false, ramp7: ["#e3e7ea", "#bac7d4", "#95a8bb", "#75889e", "#596a7f", "#404d5f", "#293240"], accent: "#5b6b4e" },
  olive_green: { green: true, ramp7: ["#e2e5d3", "#c4c7b6", "#afa88d", "#928c6a", "#757152", "#5b563c", "#413d2a"], accent: "#5a6e92" },
  bean_pink: { green: false, ramp7: ["#f0e1e7", "#d7bbc8", "#b69ba1", "#967d7b", "#76605c", "#564442", "#382a29"], accent: "#5a6e92" },
  grey_purple: { green: false, ramp7: ["#e9e0f3", "#cac1d4", "#aca3b4", "#8e8696", "#706a79", "#52515e", "#3d363f"], accent: "#5a6e92" },
  graphite: { green: false, ramp7: ["#e3e3e0", "#c4c3bf", "#a7a39f", "#898580", "#6b6865", "#504b4f", "#333238"], accent: "#3a5f7e" },
  lake: { green: false, ramp7: ["#d6effa", "#addbf0", "#81c8e5", "#58b1d1", "#2a97b8", "#067997", "#015a71"], accent: "#0481a1" },
  fresh_green: { green: true, ramp7: ["#e2f3da", "#c1e0b4", "#a3cc93", "#85b574", "#6b9a5b", "#537c46", "#3f5f34"], accent: "#58814a" },
  lavender: { green: false, ramp7: ["#ede8fc", "#d8d0f2", "#c2b8e8", "#a99fd5", "#8e84bf", "#72689e", "#564f7c"], accent: "#776da3" },
  coral: { green: false, ramp7: ["#ffe5e3", "#ffc7c2", "#f6aba5", "#e7918b", "#d0746f", "#ad5a56", "#84413e"], accent: "#b05c58" },
};
// Blue-grey's own accent is green, so a higher-is-worse topic on it takes this one instead.
const BLUE_GREY_WORSE_ACCENT = "#7a4f6d";
// Five of the seven for the map: the lightest band is left out (it sits next to the no-data grey), the rest are chosen to be
// evenly spaced in lightness.
const MAP_PICK = { blue_grey: [2, 3, 4, 5, 6], olive_green: [1, 2, 3, 4, 5], bean_pink: [1, 2, 3, 4, 5], grey_purple: [1, 2, 3, 4, 5], graphite: [1, 2, 3, 4, 5],
  lake: [0, 2, 4, 5, 6], fresh_green: [0, 2, 4, 5, 6], lavender: [0, 2, 4, 5, 6], coral: [0, 1, 3, 4, 5] };
// Multi-series colours (painting set A). Its fifth colour, #bfac9e, is 2.19:1 on white, so it is left out: a series that is not
// directly labelled must keep 3:1 against the page.
const CATEGORY_SET = ["#535260", "#615c40", "#483224", "#88756e"];

export function resolvePaletteTheme(spec) {
  if (!paletteByThemeEnabled()) return null;
  const topic = PALETTE_THEME_TOPICS.includes(spec?.theme) ? spec.theme : null;
  const worse = spec?.value_direction === "higher_worse";
  const better = spec?.value_direction === "higher_better";
  let family = (better && TOPIC_FAMILY_WHEN_BETTER[topic]) || TOPIC_FAMILY[topic] || "blue_grey";
  if (worse && PALETTE_FAMILIES[family].green) family = "blue_grey";
  const entry = PALETTE_FAMILIES[family];
  const ramp7 = entry.ramp7;
  const accent = worse && family === "blue_grey" ? BLUE_GREY_WORSE_ACCENT : entry.accent;
  return {
    topic, family, accent, ramp7,
    ramp5: MAP_PICK[family].map((i) => ramp7[i]),
    heatLow: ramp7[0], heatHigh: ramp7[6],
    series: CATEGORY_SET,
  };
}

export function hexChannels(hex) { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); }

// What a plan or page manifest records so a render can be replayed: the topic as given, the direction, and the family that was used.
export function paletteThemeMeta(spec) {
  const theme = resolvePaletteTheme(spec);
  if (!theme) return {};
  const value_direction = PALETTE_VALUE_DIRECTIONS.includes(spec?.value_direction) ? spec.value_direction : "neutral";
  return { palette_theme: { topic: theme.topic, value_direction, family: theme.family } };
}
