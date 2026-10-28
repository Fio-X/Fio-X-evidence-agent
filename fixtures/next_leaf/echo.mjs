// Test leaf for src/next_leaf.rs: draws nothing of its own, replies with what its knobs say (texts, lines, frame, a refusal),
// or hangs or exits, so each check of the bridge can be met head on. One JSON line in, one line out.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const k = req.knobs || {};
  if (k.hang) return;
  if (k.exit) process.exit(0);
  const seen = k.echo_frame ? JSON.stringify(req.panel.frame) : "";
  process.stdout.write(
    JSON.stringify({
      svg: `<g data-layer="${req.layer}">${seen}</g>`,
      texts: k.texts || [],
      lines: k.lines || [],
      frame: k.frame || null,
      refused: k.refused || [],
    }) + "\n",
  );
});
