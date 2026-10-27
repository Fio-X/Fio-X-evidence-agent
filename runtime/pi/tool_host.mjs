// Tool host (1011ab step 1): the Node process that only runs tools. The Rust side starts it, sends a hello, gets the tool list, then
// sends calls; this process never holds a model key. Messages are one JSON object per line on stdin/stdout (only "\n" splits lines);
// anything else goes to stderr. Per call: call -> validated (arguments after conversion) -> go -> progress* -> result | error.
// Nothing here runs unless the Rust client starts it; no tool code is changed. Protocol: agent-spec sections 9 and 10.
import { createInterface } from "node:readline";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validationFailure, sqlRefusalText } from "./tool_host_schema.mjs";
import { toolGroup, runInStagedCall } from "./groups.mjs";

const PROTOCOL = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (text) => process.stderr.write(`[tool-host] ${text}\n`);
const KEYLIKE = /(_API_KEY|_BASE_URL|_TOKEN|_SECRET|PASSWORD)$/i;

// newsroom.ts imports tool_api.ts; in this process that name is answered by tool_host_api.mjs (no model-side package needed).
const shimUrl = pathToFileURL(join(HERE, "tool_host_api.mjs")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./tool_api.ts" && String(context.parentURL ?? "").endsWith("/newsroom.ts")) return { url: shimUrl, shortCircuit: true };
    return next(specifier, context);
  },
});

const tools = new Map();
const pending = new Map(); // callId -> { controller, go, state }

function register(allowed) {
  const names = new Set(allowed);
  return {
    registerTool(tool) {
      if (!names.has(tool.name)) return;
      tools.set(tool.name, tool);
    },
  };
}

async function onHello(message) {
  if (message.protocol !== PROTOCOL) { send({ type: "error", kind: "protocol", message: `unsupported protocol ${message.protocol}` }); process.exit(2); }
  if (message.cwd) process.chdir(message.cwd);
  if (message.runDir && !process.env.NEWSROOM_ARTIFACT_DIR) process.env.NEWSROOM_ARTIFACT_DIR = message.runDir;
  const allowed = Array.isArray(message.allowedTools) ? message.allowedTools : [];
  if (message.metricsFile && !process.env.NEWSROOM_PHASE_METRICS_FILE) process.env.NEWSROOM_PHASE_METRICS_FILE = message.metricsFile;
  const loaded = await import(pathToFileURL(join(HERE, "newsroom.ts")).href);
  try { loaded.default(register(allowed)); } catch (error) { send({ type: "error", kind: "startup", message: String(error?.message ?? error) }); process.exit(3); }
  send({
    type: "ready",
    protocol: PROTOCOL,
    tools: [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })),
      group: toolGroup(tool.name),
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length ? { promptGuidelines: tool.promptGuidelines } : {}),
    })),
    // names only, never values: lets the Rust side refuse a host that was started with a key in its environment
    envNames: Object.keys(process.env).sort(),
  });
}

async function onCall(message) {
  const { callId, name } = message;
  const tool = tools.get(name);
  if (!tool) return send({ type: "error", callId, kind: "unknown_tool", message: `No tool named ${name} is registered` });
  const checked = validationFailure(name, tool.parameters, message.args ?? {});
  if (!checked.ok) return send({ type: "error", callId, kind: "invalid_args", message: checked.text });
  const entry = { controller: new AbortController(), go: null, staging: null, counted: false };
  pending.set(callId, entry);
  const approved = new Promise((resolve) => { entry.go = resolve; });
  send({ type: "validated", callId, args: checked.args });
  if (!(await approved)) { pending.delete(callId); return send({ type: "error", callId, kind: "cancelled", message: "cancelled before start" }); }
  try {
    const onUpdate = (partial) => send({ type: "progress", callId, partial: { content: partial?.content ?? [], ...(partial?.details ? { details: partial.details } : {}) } });
    const result = await runInStagedCall(callId, entry.staging, () => tool.execute(callId, checked.args, entry.controller.signal, onUpdate, {}), entry.counted);
    if (entry.controller.signal.aborted) return send({ type: "error", callId, kind: "cancelled", message: "cancelled" });
    send({ type: "result", callId, content: result?.content ?? [], ...(result?.details !== undefined ? { details: result.details } : {}), isError: Boolean(result?.isError) });
  } catch (error) {
    if (entry.controller.signal.aborted) return send({ type: "error", callId, kind: "cancelled", message: "cancelled" });
    send({ type: "result", callId, content: [{ type: "text", text: sqlRefusalText(error) }], isError: true });
  } finally {
    pending.delete(callId);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line); } catch { return log("unparseable line ignored"); }
  if (message.type === "hello") chain = chain.then(() => onHello(message)).catch((e) => { send({ type: "error", kind: "startup", message: String(e?.message ?? e) }); process.exit(3); });
  else if (message.type === "call") void onCall(message).catch((e) => send({ type: "error", callId: message.callId, kind: "crashed", message: String(e?.message ?? e) }));
  else if (message.type === "go") { const entry = pending.get(message.callId); if (entry) { entry.staging = typeof message.staging === "string" ? message.staging : null; entry.counted = message.counted === true; entry.go?.(true); } }
  else if (message.type === "cancel") { const entry = pending.get(message.callId); entry?.controller.abort(); entry?.go?.(false); }
  else if (message.type === "shutdown") process.exit(0);
});
lines.on("close", () => process.exit(0));
export { KEYLIKE };
