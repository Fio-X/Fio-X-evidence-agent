// Seam check (1011y): only runtime/pi/tool_api.ts may import a Pi package (@earendil-works/*, typebox). Every other runtime file
// reaches them through it, so replacing the agent loop later touches one file. Counter-tests prove the check turns red.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI = join(ROOT, "runtime", "pi");
const SEAM = "tool_api.ts";
const PI_IMPORT = /(?:^|[\s;])(?:import|export)\b[^;'"]*?\bfrom\s*["'](?:@earendil-works\/|typebox)[^"']*["']|(?:import|require)\s*\(\s*["'](?:@earendil-works\/|typebox)[^"']*["']\s*\)|^\s*import\s*["'](?:@earendil-works\/|typebox)/m;

export const importsPi = (source) => PI_IMPORT.test(source);
export function offenders(files) {
  return Object.entries(files).filter(([name, source]) => name !== SEAM && importsPi(source)).map(([name]) => name);
}

const files = Object.fromEntries(
  readdirSync(PI).filter((n) => /\.(ts|mjs|js)$/.test(n) && !n.includes(".test-copy.")).map((n) => [n, readFileSync(join(PI, n), "utf8")]),
);
assert.ok(files[SEAM], `${SEAM} is missing`);
assert.ok(importsPi(files[SEAM]), `${SEAM} must be the file that imports the Pi packages`);
assert.deepEqual(offenders(files), [], "files other than tool_api.ts import a Pi package directly");
assert.match(files["newsroom.ts"], /from "\.\/tool_api\.ts"/, "newsroom.ts must import from ./tool_api.ts");

// counter-tests
for (const bad of [
  'import { Type } from "typebox";',
  'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  "import { StringEnum } from '@earendil-works/pi-ai';",
  'export { Type } from "typebox";',
  'const m = await import("typebox");',
  'import "@earendil-works/pi-ai";',
  'import {\n  Type,\n} from "typebox";',
]) assert.deepEqual(offenders({ [SEAM]: bad, "x.mjs": bad }), ["x.mjs"], `not caught: ${bad}`);
assert.deepEqual(offenders({ "x.mjs": 'import { a } from "./tool_api.ts"; import fs from "node:fs";' }), [], "false positive");
console.log("tool_api seam OK:", Object.keys(files).length, "runtime files checked");
