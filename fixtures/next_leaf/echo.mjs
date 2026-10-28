// Test leaf for src/next_leaf.rs: draws nothing of its own, replies with what its knobs say (texts, lines, frame, a refusal,
// a reservation, an html layer, dropped names), or hangs or exits, and a page line gets back the layers it was sent, so each check of the bridge can be met head on. One JSON
// line in, one line out. fixtures/next_leaf/echo.py does the same in Python.
import readline from "node:readline";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const rl = readline.createInterface({ input: process.stdin });
// A layer's knobs.page_alter: how the page line changes the first layer it was sent ("attr", "own", "other").
let alter = null;
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.phase === "page") {
    const frags = Object.entries(req.layers);
    if (alter && frags.length) {
      const [n, f] = frags[0];
      const add = { attr: ' class="x"', own: ` data-layer="${n}"`, other: ' data-layer="zz"' }[alter];
      frags[0] = [n, f.replace(/^<(\w+)/, (_, t) => `<${t}${add}`)];
    }
    process.stdout.write(JSON.stringify({ html: `<body>${frags.map(([, f]) => f).join("")}</body>` }) + "\n");
    return;
  }
  const k = req.knobs || {};
  if (k.page_alter) alter = k.page_alter;
  if (k.hang) return;
  if (k.exit) process.exit(0);
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
