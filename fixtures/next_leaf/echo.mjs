// Test leaf for src/next_leaf.rs: draws nothing of its own, replies with what its knobs say (texts, lines, frame, a refusal,
// a reservation, an html layer, dropped names, the panel's size), or hangs or exits, and a page line gets back the layers it was sent (changed as a
// layer's knobs.page_alter says), so each check of the bridge can be met head on. One JSON
// line in, one line out. fixtures/next_leaf/echo.py does the same in Python.
import readline from "node:readline";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const rl = readline.createInterface({ input: process.stdin });
// A layer's knobs.page_alter: how the page line changes the first layer it was sent (see changed).
let alter = null;
const COPY = "<g><text>24%</text></g>"; // a copy of a layer with its number changed
const changed = (n, f) => {
  if (["attr", "own", "other"].includes(alter)) {
    const add = { attr: ' class="x"', own: ` data-layer="${n}"`, other: ' data-layer="zz"' }[alter];
    return f.replace(/^<(\w+)/, (_, t) => `<${t}${add}`);
  }
  const page = { comment: `<!--${f}-->${COPY}`, template: `<template>${f}</template>`, twice: f + f, extra: f + COPY, drop: "",
    wrap: `<g data-layer="${n}">${f}</g>`, moved: `<g transform="translate(400,0)">${f}</g>`,
    hidden: `<g style="display:none">${f}</g>`, stranger: `<g data-layer="zz">${f}</g>` };
  return alter in page ? page[alter] : f;
};
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.phase === "page") {
    // the svg layers (`<g` first) in one <svg>, the html ones after it
    const frags = Object.entries(req.layers).map(([n, f], i) => [i === 0 ? changed(n, f) : f, f.startsWith("<g")]);
    const svg = frags.filter(([, s]) => s).map(([f]) => f);
    if (alter === "reverse") svg.reverse();
    const html = frags.filter(([, s]) => !s).map(([f]) => f).join("");
    process.stdout.write(JSON.stringify({ html: `<body><svg>${svg.join("")}</svg>${html}</body>` }) + "\n");
    return;
  }
  const k = req.knobs || {};
  if (k.page_alter) alter = k.page_alter;
  if (k.hang) return;
  if (k.exit) process.exit(0);
  if (req.phase === "size") {
    // the panel it says when the height is left to it: knobs.size [w, h], or knobs.size_refused
    const [w, h] = k.size || [];
    process.stdout.write(JSON.stringify(k.size_refused ? { refused: k.size_refused } : { w, h }) + "\n");
    return;
  }
  if (req.phase === "reserve") {
    process.stdout.write(JSON.stringify({ boxes: k.reserve_boxes || [], lines: k.reserve_lines || [], refused: [] }) + "\n");
    return;
  }
  const seen = k.echo_frame ? esc(JSON.stringify(req.panel.frame)) : "";
  const occ = k.echo_occ ? esc(JSON.stringify(req.occ)) : "";
  const texts = (k.texts || []).map((t) => `<text data-src="${esc(t.src)}">${esc(t.text)}</text>`).join("");
  const reply = k.html
    ? { html: k.html, texts: k.texts || [] }
    : { svg: `<g data-layer="${req.layer}">${seen}${occ}${k.extra_svg || texts}</g>`, texts: k.texts || [], lines: k.lines || [] };
  process.stdout.write(
    JSON.stringify({ ...reply, frame: k.frame || null, refused: k.refused || [], dropped: k.dropped || [] }) + "\n",
  );
});
