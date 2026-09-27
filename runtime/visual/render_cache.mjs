import crypto from 'node:crypto';
function canonical(v){ if(Array.isArray(v)) return v.map(canonical); if(v&&typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])); return v; }
export function renderCacheKey({dataHashes=[],recipe,backend,backendVersion,templateVersion=null}){
  const payload={dataHashes:[...dataHashes].sort(),recipe:canonical(recipe),backend,backendVersion,templateVersion};
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
