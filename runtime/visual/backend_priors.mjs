import fs from 'node:fs';

export function qualifiedPriorMap(input){
  if(!input||typeof input!=='object') return {};
  if(input.story_families){
    const out={};
    for(const [family,row] of Object.entries(input.story_families)){
      if(row&&row.status==='QUALIFIED'&&row.probabilities&&Object.keys(row.probabilities).length) out[family]={...row.probabilities};
    }
    return out;
  }
  return input;
}
export function loadBackendPriors(path='config/backend-priors.json'){
  if(!fs.existsSync(path)) return {raw:null,qualified:{}};
  const raw=JSON.parse(fs.readFileSync(path,'utf8')); return {raw,qualified:qualifiedPriorMap(raw)};
}
