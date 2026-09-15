export const MODEL_SPEC_VERSION='0.2.0';
const SUPPORTED=new Set(['0.1.0','0.2.0']);
function finite(v){return Number.isFinite(Number(v));}
export function validateModelSpec(spec){
  const errors=[]; if(!spec||typeof spec!=='object') return {status:'BLOCK',errors:['model spec required']};
  if(!SUPPORTED.has(spec.schema_version)) errors.push(`schema_version must be one of ${[...SUPPORTED].join(', ')}`);
  if(spec.type==='probabilistic_interval_series'){
    const coverage=Number(spec.uncertainty?.coverage); const semantics=String(spec.uncertainty?.coverage_semantics??''); const series=spec.series??[];
    if(!(coverage>0&&coverage<1)) errors.push('uncertainty.coverage must be between 0 and 1');
    if(!['empirical_historical_error','prediction_interval','credible_interval','confidence_interval'].includes(semantics)) errors.push('uncertainty.coverage_semantics is invalid');
    if(!Array.isArray(series)||series.length<2) errors.push('probabilistic interval series requires at least two rows');
    const units=new Set(); const intervals=[];
    for(const [i,row] of series.entries()){
      const low=Number(row.lower),mid=Number(row.central),high=Number(row.upper);
      if(!finite(low)||!finite(mid)||!finite(high)) errors.push(`series[${i}] interval values must be finite`);
      else if(!(low<=mid&&mid<=high)) errors.push(`series[${i}] must satisfy lower <= central <= upper`);
      const unit=String(row.unit??'').trim(); if(unit)units.add(unit); intervals.push({horizon:row.horizon,lower:low,central:mid,upper:high,unit});
    }
    if(series.some(r=>!String(r.unit??'').trim())) errors.push('probabilistic interval series requires a unit on every row');
    if(units.size>1) errors.push(`probabilistic interval units must match: ${[...units].join(', ')}`);
    return {status:errors.length?'BLOCK':'PASS',errors,coverage,coverage_semantics:semantics,intervals,unit:[...units][0]??null};
  }
  const ids=new Set((spec.entities??[]).map(x=>String(x.id))); if(!ids.size) errors.push('entities required');
  for(const [i,f] of (spec.flows??[]).entries()){if(!ids.has(String(f.source))||!ids.has(String(f.target))) errors.push(`flows[${i}] references unknown entity`);if(!finite(f.value)||Number(f.value)<0)errors.push(`flows[${i}].value must be non-negative`);}
  if(errors.length)return {status:'BLOCK',errors};
  if(spec.type==='conserved_flow_system'){
    const units=[...new Set((spec.flows??[]).map(f=>String(f.unit??'').trim()).filter(Boolean))];
    if((spec.flows??[]).some(f=>!String(f.unit??'').trim())) return {status:'BLOCK',errors:['conserved flow requires a unit on every flow'],residuals:[]};
    if(units.length!==1) return {status:'BLOCK',errors:[`conserved flow units must match: ${units.join(', ')}`],residuals:[],units};
    const tol=Number(spec.conservation?.tolerance??1e-9);const nodes=spec.conservation?.nodes??[...ids];const residuals=[];
    for(const n of nodes){const incoming=(spec.flows??[]).filter(f=>String(f.target)===String(n)).reduce((a,f)=>a+Number(f.value),0);const outgoing=(spec.flows??[]).filter(f=>String(f.source)===String(n)).reduce((a,f)=>a+Number(f.value),0);if(incoming>0&&outgoing>0){const residual=incoming-outgoing;residuals.push({node:String(n),incoming,outgoing,residual});}}
    const bad=residuals.filter(r=>Math.abs(r.residual)>tol);return {status:bad.length?'BLOCK':'PASS',errors:bad.map(r=>`flow conservation failed at ${r.node}: residual ${r.residual}`),residuals,tolerance:tol,unit:units[0]};
  }
  return {status:'PASS',errors:[],residuals:[]};
}
