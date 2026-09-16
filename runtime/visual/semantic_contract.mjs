import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeMeasureSemantics } from './measure_semantics.mjs';
import { normalizeClaimSpec } from './editorial_semantics.mjs';

function canonical(v){
  if(Array.isArray(v)) return v.map(canonical);
  if(v&&typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
  return v;
}
function shaBytes(buf){ return crypto.createHash('sha256').update(buf).digest('hex'); }
export function fileSha256(root,p){
  const abs=path.resolve(root,p);
  if(!abs.startsWith(path.resolve(root)+path.sep) && abs!==path.resolve(root)) throw new Error(`evidence path escapes root: ${p}`);
  return shaBytes(fs.readFileSync(abs));
}
export function buildSemanticContract(root,contract){
  if(!contract||typeof contract!=='object'||Array.isArray(contract)) throw new Error('semantic_contract must be an object');
  const evidence=[...(contract.evidence_paths||[])].map(String).sort().map(p=>({path:p,sha256:fileSha256(root,p)}));
  if(!evidence.length) throw new Error('semantic_contract.evidence_paths must not be empty');
  const measures=normalizeMeasureSemantics(contract.measure_semantics);
  const claimSpec=measures.length?normalizeClaimSpec(contract.claim_spec,measures):null;
  if(contract.claim_spec&&!measures.length) throw new Error('semantic_contract.measure_semantics are required when claim_spec is declared');
  const normalized=canonical({
    claim_ids:[...(contract.claim_ids||[])].map(String).sort(),
    evidence,
    semantics:contract.semantics||{},
    measure_semantics:measures,
    claim_spec:claimSpec,
    source_ledger:contract.source_ledger||{}
  });
  const payload=JSON.stringify(normalized);
  return Object.freeze({schema_version:'1.1.0',...normalized,fingerprint:shaBytes(Buffer.from(payload))});
}
