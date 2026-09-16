#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const expectedKinds = [
  'local_hash',
  'local_text',
  'local_metadata',
  'local_image_info',
  'local_search',
  'sqlite_query',
];

const canonical = JSON.parse(await read('../config/tool-registry.json'));
const canonicalTask = canonical.tools.find((tool) => tool.name === 'newsroom_parallel_tasks');
assert.ok(canonicalTask, 'canonical registry must contain newsroom_parallel_tasks');
assert.deepEqual(canonicalTask.execution, {
  parallel: true,
  max_concurrency: 8,
  local_first_on_macos: true,
  mutating: false,
});

const rust = await read('../src/tool_registry.rs');
const generatedRustNames = rust.match(/pub const NEWSROOM_TOOLS: &str = "([^"]+)"/)?.[1].split(',') ?? [];
assert.ok(generatedRustNames.includes('newsroom_parallel_tasks'), 'generated Rust full registry is missing parallel tool');
for (const profile of ['INVESTIGATE', 'VISUAL', 'COMPETITION', 'FULL']) {
  const names = rust.match(new RegExp(`pub const NEWSROOM_TOOLS_${profile}: &str = "([^"]+)"`))?.[1].split(',') ?? [];
  assert.ok(names.includes('newsroom_parallel_tasks'), `generated Rust ${profile} registry is missing parallel tool`);
}
const publicationNames = rust.match(/pub const NEWSROOM_TOOLS_PUBLICATION: &str = "([^"]+)"/)?.[1].split(',') ?? [];
assert.ok(!publicationNames.includes('newsroom_parallel_tasks'), 'publication profile must not expose parallel tool');
assert.match(rust, /"newsroom_parallel_tasks" => Some\("synthesis"\)/);
assert.match(rust, /Retained as the canonical static registry for contract validation\.\n#\[allow\(dead_code\)\]/);

const generatedJs = await import(new URL('../runtime/pi/tool_registry.mjs', import.meta.url));
const generatedJsTask = generatedJs.TOOL_REGISTRY.tools.find((tool) => tool.name === 'newsroom_parallel_tasks');
assert.deepEqual(generatedJsTask, canonicalTask, 'generated JS metadata must match canonical registry');

const runtime = await read('../src/runtime.rs');
assert.match(runtime, /const PARALLEL_SCHEDULER_RUNTIME[\s\S]*?include_str!\("\.\.\/runtime\/pi\/parallel_scheduler\.mjs"\)/);
assert.match(runtime, /const LOCAL_BACKEND_RUNTIME[\s\S]*?include_str!\("\.\.\/runtime\/pi\/local_backend\.mjs"\)/);
assert.match(runtime, /write_if_changed\(&parallel_scheduler_path, PARALLEL_SCHEDULER_RUNTIME\)/);
assert.match(runtime, /write_if_changed\(&local_backend_path, LOCAL_BACKEND_RUNTIME\)/);

const extension = await read('../runtime/pi/newsroom.ts');
assert.match(extension, /import \{ runTaskDag \} from "\.\/parallel_scheduler\.mjs";/);
assert.match(extension, /import \{ localHash, localImageInfo, localMetadata, localSpotlight, localSqliteQuery, localText \} from "\.\/local_backend\.mjs";/);
const registrations = [...extension.matchAll(/registerScopedTool\(pi,\s*\{\s*name: "newsroom_parallel_tasks"/g)];
assert.equal(registrations.length, 1, 'parallel tool must be registered exactly once');
const start = registrations[0].index;
const nextRegistration = extension.indexOf('\n  registerScopedTool(pi, {', start + 1);
const block = extension.slice(start, nextRegistration === -1 ? undefined : nextRegistration);
const kindMatch = block.match(/kind: StringEnum\(\[([^\]]+)\] as const\)/s);
assert.ok(kindMatch, 'parallel tool kind enum is missing');
assert.deepEqual([...kindMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]), expectedKinds);
assert.doesNotMatch(block, /\bresource_(?:class|key)\b/, 'public parallel schema must not expose scheduler resource controls');
for (const marker of [
  'localHash(required("path"))',
  'localText(required("path"))',
  'localMetadata(required("path"))',
  'localImageInfo(required("path"))',
  'localSpotlight(required("query"), { limit:',
  'localSqliteQuery(required("path"), required("sql"))',
]) {
  assert.ok(block.includes(marker), `runner mapping is missing: ${marker}`);
}
assert.match(block, /maxConcurrency = clampInt\(params\.max_concurrency, 1, 8, 8\)/);
assert.match(block, /artifactRoot: root/);
assert.match(block, /appendArtifact\("runtime\/parallel-events\.jsonl", event\)/);

console.log(JSON.stringify({ status: 'PASS', registration_count: registrations.length, supported_kinds: expectedKinds }, null, 2));
