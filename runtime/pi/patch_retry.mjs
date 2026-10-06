// Send only the change after a refusal (NEWSROOM_SPEED_PLAN_PATCH / NEWSROOM_SPEED_CHAIN_PATCH).
// Pure helpers: no artifact I/O, no check, no status. A patch is RFC 6902 (add, replace, remove, test) and is
// applied all or nothing to a COPY of the refused call's raw parameters; the caller then runs the patched
// parameters through the strict schema check and the unchanged tool, so every gate runs again.
import { createHash } from "node:crypto";

export const PATCH_MAX_OPS = 24;
export class PatchError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const sorted = (value) => (Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);
export const canonicalJson = (value) => JSON.stringify(sorted(value));
export const sha256Of = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const deepEqual = (a, b) => canonicalJson(a) === canonicalJson(b);

function tokens(path, index) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new PatchError("PATCH_INVALID", `op ${index}: path must be a JSON pointer starting with "/"`);
  const parts = path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const part of parts) if (BLOCKED_KEYS.has(part)) throw new PatchError("PATCH_INVALID", `op ${index}: path may not use ${part}`);
  return parts;
}
const isIndex = (token) => /^(0|[1-9]\d*)$/.test(token);
const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));

function walk(root, parts, index) {
  let node = root;
  for (const part of parts) {
    if (Array.isArray(node)) {
      if (!isIndex(part) || Number(part) >= node.length) throw new PatchError("PATCH_INVALID", `op ${index}: no array element ${part}`);
      node = node[Number(part)];
    } else if (node && typeof node === "object") {
      if (!Object.prototype.hasOwnProperty.call(node, part)) throw new PatchError("PATCH_INVALID", `op ${index}: no member ${part}`);
      node = node[part];
    } else throw new PatchError("PATCH_INVALID", `op ${index}: path goes through a value that is not an object or array`);
  }
  return node;
}

/** Applies ops to a copy of base. Throws PatchError (PATCH_INVALID, PATCH_TEST_FAILED, PATCH_ARRAY_UNGUARDED); returns the patched copy. */
export function applyJsonPatch(base, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new PatchError("PATCH_INVALID", "patch must be a non-empty array of ops");
  if (ops.length > PATCH_MAX_OPS) throw new PatchError("PATCH_INVALID", `patch has ${ops.length} ops; the limit is ${PATCH_MAX_OPS}`);
  const doc = structuredClone(base);
  const tests = [];
  ops.forEach((op, index) => {
    if (!op || typeof op !== "object" || Array.isArray(op)) throw new PatchError("PATCH_INVALID", `op ${index}: must be an object`);
    if (!["add", "replace", "remove", "test"].includes(op.op)) throw new PatchError("PATCH_INVALID", `op ${index}: op must be add, replace, remove or test`);
    const parts = tokens(op.path, index);
    if ((op.op === "add" || op.op === "replace" || op.op === "test") && !Object.prototype.hasOwnProperty.call(op, "value")) throw new PatchError("PATCH_INVALID", `op ${index}: ${op.op} needs a value`);
    const last = parts.at(-1);
    const parent = walk(doc, parts.slice(0, -1), index);
    if (op.op === "test") {
      let actual;
      try { actual = walk(doc, parts, index); } catch { throw new PatchError("PATCH_TEST_FAILED", `op ${index}: ${op.path} does not exist`); }
      if (!deepEqual(actual, op.value)) throw new PatchError("PATCH_TEST_FAILED", `op ${index}: ${op.path} does not hold the tested value; nothing was applied`);
      tests.push(op.path);
      return;
    }
    if (Array.isArray(parent)) {
      // An index shifts when an element is added or removed, so these ops need a test op before them on the element or its array.
      const guard = parentOf(op.path);
      if (!tests.some((path) => path === op.path || path === guard)) throw new PatchError("PATCH_ARRAY_UNGUARDED", `op ${index}: ${op.op} on an array element needs an earlier test op on ${op.path} or ${guard || "/"}`);
      if (op.op === "add") {
        const at = last === "-" ? parent.length : isIndex(last) ? Number(last) : -1;
        if (at < 0 || at > parent.length) throw new PatchError("PATCH_INVALID", `op ${index}: bad array index ${last}`);
        parent.splice(at, 0, structuredClone(op.value));
      } else {
        if (!isIndex(last) || Number(last) >= parent.length) throw new PatchError("PATCH_INVALID", `op ${index}: no array element ${last}`);
        if (op.op === "replace") parent[Number(last)] = structuredClone(op.value); else parent.splice(Number(last), 1);
      }
      return;
    }
    if (!parent || typeof parent !== "object") throw new PatchError("PATCH_INVALID", `op ${index}: parent of ${op.path} is not an object`);
    const has = Object.prototype.hasOwnProperty.call(parent, last);
    if (op.op === "add") parent[last] = structuredClone(op.value);
    else if (!has) throw new PatchError("PATCH_INVALID", `op ${index}: ${op.op} needs ${op.path} to exist`);
    else if (op.op === "replace") parent[last] = structuredClone(op.value);
    else delete parent[last];
  });
  return doc;
}

/** The same strict check Pi applies to a call's arguments, run on patched parameters before any other check.
 *  `Compile` is handed in by newsroom.ts (a bare import here is not aliased inside Pi). Fails closed. */
export function strictSchemaIssues(Compile, schema, value) {
  if (typeof Compile !== "function") throw new PatchError("PATCH_SCHEMA_UNAVAILABLE", "the strict schema validator could not be loaded, so the patched call is not run");
  const validator = Compile(schema);
  if (validator.Check(value)) return [];
  const issues = [];
  for (const error of validator.Errors(value)) {
    const base = String(error.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".");
    const props = error.keyword === "required" ? error.params?.requiredProperties : undefined;
    if (props?.length) for (const prop of props) issues.push(`${[base, prop].filter(Boolean).join(".")}: is required`);
    else issues.push(`${base || "(call)"}: ${error.message}`);
  }
  return issues.length ? issues : ["(call): fails the tool schema"];
}
