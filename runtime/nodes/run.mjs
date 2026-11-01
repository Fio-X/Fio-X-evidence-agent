// run.mjs: one JSON request per stdin line, one JSON reply per stdout line, in order. A line that is not a request gets a refusal, never a guess.
import { createInterface } from "node:readline";
import * as base_map from "./base_map.mjs";
import * as flow_lines from "./flow_lines.mjs";
import * as leader_notes from "./leader_notes.mjs";
import * as legend from "./legend.mjs";
export const NODES = { base_map, flow_lines, leader_notes, legend };
export const handle = (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return { svg: "", texts: [], lines: [], frame: null, refused: ["the line is not JSON; send one request object per line, for example {\"node\":\"base_map\",...}"] }; }
  const node = NODES[request?.node];
  if (!node) return { svg: "", texts: [], lines: [], frame: null, refused: [`node ${JSON.stringify(request?.node)} is not here; use one of ${Object.keys(NODES).join(", ")}`] };
  try { return node.draw(request); } catch (e) { return { svg: "", texts: [], lines: [], frame: null, refused: [`node ${request.node} stopped: ${String(e?.message ?? e).slice(0, 200)}`] }; }
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => { if (line.trim()) process.stdout.write(JSON.stringify(handle(line)) + "\n"); });
}
