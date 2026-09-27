#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVisualRecipeV2 } from '../runtime/visual/visual_recipe_v2.mjs';
import { buildSemanticContract } from '../runtime/visual/semantic_contract.mjs';
import { runtimeForBackend } from '../runtime/visual/runtime_registry.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const m=JSON.parse(fs.readFileSync(path.join(root,'fixtures/benchmarks/v2/manifest.json'),'utf8'));
assert.equal(m.status,'qualification_corpus_v1'); assert.ok(m.cases.length>=32);
const ids=new Set();
for(const c of m.cases){
  assert.ok(!ids.has(c.id),`duplicate ${c.id}`); ids.add(c.id);
  const recipe=normalizeVisualRecipeV2(c.recipe); assert.equal(recipe.story_family,c.story_family);
  const semantic=buildSemanticContract(root,c.semantic_contract); assert.match(semantic.fingerprint,/^[0-9a-f]{64}$/);
  assert.deepEqual([...recipe.claim_ids].sort(),[...semantic.claim_ids].sort(),`${c.id}: recipe/semantic claim ids differ`);
  assert.ok(c.candidate_backends.length>=2,`${c.id}: need >=2 candidates`);
  for(const b of c.candidate_backends){ assert.ok(runtimeForBackend(b),`${c.id}: unknown backend ${b}`); assert.ok(c.render_requests[b],`${c.id}: missing request ${b}`); }
}
console.log(`benchmark corpus v1.28: PASS (${m.cases.length} cases)`);
