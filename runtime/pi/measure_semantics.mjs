// Generated from runtime/visual/measure_semantics.mjs. Do not edit by hand.
export const MEASURE_SEMANTICS_VERSION='1.0.0';

export const COMPARABILITY=Object.freeze({
  DIRECT:'DIRECT',
  CONTEXTUAL:'CONTEXTUAL',
  INCOMPATIBLE:'INCOMPATIBLE'
});

const MEASURE_KINDS=new Set([
  'level','flow','stock','rate','share','capacity','change','cumulative',
  'count','index','duration','distance','price'
]);
const TEMPORAL_TYPES=new Set([
  'point_in_time','period','annual_average','rolling','structural','cumulative','timeless'
]);
const OBSERVATION_STATUS=new Set([
  'observed','estimate','forecast','target','capacity','scenario','modeled','reference'
]);
const PRICE_BASIS=new Set(['nominal','real','not_applicable']);
const SEASONAL_ADJUSTMENT=new Set(['none','seasonally_adjusted','not_seasonally_adjusted','not_applicable']);

function object(v,name){
  if(!v||typeof v!=='object'||Array.isArray(v)) throw new Error(`${name} must be an object`);
}
function nonEmptyString(v,name){
  if(typeof v!=='string'||!v.trim()) throw new Error(`${name} must be a non-empty string`);
  return v.trim();
}
function optionalString(v,name){
  if(v==null) return null;
  return nonEmptyString(v,name);
}
function enumValue(v,name,allowed,def=null){
  if(v==null&&def!=null) return def;
  if(!allowed.has(v)) throw new Error(`${name} has unsupported value: ${v}`);
  return v;
}

export function normalizeMeasureSemantic(input,index=0){
  object(input,`measure_semantics[${index}]`);
  const temporal=input.temporal_basis??{type:'timeless'};
  object(temporal,`measure_semantics[${index}].temporal_basis`);
  const temporalType=enumValue(temporal.type,`measure_semantics[${index}].temporal_basis.type`,TEMPORAL_TYPES,'timeless');
  const value=input.value==null?null:Number(input.value);
  if(value!=null&&!Number.isFinite(value)) throw new Error(`measure_semantics[${index}].value must be finite when provided`);
  return Object.freeze({
    id:nonEmptyString(input.id,`measure_semantics[${index}].id`),
    field:optionalString(input.field,`measure_semantics[${index}].field`),
    phenomenon:nonEmptyString(input.phenomenon,`measure_semantics[${index}].phenomenon`),
    unit:nonEmptyString(input.unit,`measure_semantics[${index}].unit`),
    measure_kind:enumValue(input.measure_kind,`measure_semantics[${index}].measure_kind`,MEASURE_KINDS),
    temporal_basis:Object.freeze({
      ...temporal,
      type:temporalType,
      date:optionalString(temporal.date,`measure_semantics[${index}].temporal_basis.date`),
      start:optionalString(temporal.start,`measure_semantics[${index}].temporal_basis.start`),
      end:optionalString(temporal.end,`measure_semantics[${index}].temporal_basis.end`)
    }),
    observation_status:enumValue(input.observation_status,`measure_semantics[${index}].observation_status`,OBSERVATION_STATUS,'observed'),
    aggregation:optionalString(input.aggregation,`measure_semantics[${index}].aggregation`)??'none',
    denominator:optionalString(input.denominator,`measure_semantics[${index}].denominator`),
    adjustment:optionalString(input.adjustment,`measure_semantics[${index}].adjustment`)??'none',
    price_basis:enumValue(input.price_basis,`measure_semantics[${index}].price_basis`,PRICE_BASIS,'not_applicable'),
    seasonal_adjustment:enumValue(input.seasonal_adjustment,`measure_semantics[${index}].seasonal_adjustment`,SEASONAL_ADJUSTMENT,'not_applicable'),
    base_period:optionalString(input.base_period,`measure_semantics[${index}].base_period`),
    scope:optionalString(input.scope,`measure_semantics[${index}].scope`),
    evidence_ref:optionalString(input.evidence_ref,`measure_semantics[${index}].evidence_ref`),
    value
  });
}

export function normalizeMeasureSemantics(input){
  if(input==null) return Object.freeze([]);
  if(!Array.isArray(input)) throw new Error('measure_semantics must be an array');
  const rows=input.map(normalizeMeasureSemantic);
  const ids=new Set();
  for(const row of rows){
    if(ids.has(row.id)) throw new Error(`duplicate measure_semantics id: ${row.id}`);
    ids.add(row.id);
  }
  return Object.freeze(rows);
}

function result(status,reasons,repair=[]){
  return Object.freeze({status,reasons:Object.freeze(reasons),repair:Object.freeze(repair)});
}
function pairKey(a,b){ return [a,b].sort().join('|'); }
const CONTEXTUAL_KIND_PAIRS=new Set([
  pairKey('capacity','flow'),
  pairKey('capacity','level'),
  pairKey('capacity','rate'),
  pairKey('capacity','count')
]);
const HARD_KIND_MISMATCHES=new Set([
  pairKey('stock','flow'), pairKey('stock','rate'), pairKey('stock','change'),
  pairKey('share','count'), pairKey('share','flow'), pairKey('share','level'), pairKey('share','rate'),
  pairKey('rate','level'), pairKey('rate','count'),
  pairKey('change','level'), pairKey('change','flow'), pairKey('change','rate'), pairKey('change','count'), pairKey('change','capacity'),
  pairKey('cumulative','flow'), pairKey('cumulative','rate'), pairKey('cumulative','level'), pairKey('cumulative','count')
]);
const CONTEXTUAL_STATUS_PAIRS=new Set([
  pairKey('observed','estimate'), pairKey('observed','forecast'), pairKey('observed','target'),
  pairKey('observed','capacity'), pairKey('observed','scenario'), pairKey('observed','modeled'),
  pairKey('estimate','forecast'), pairKey('forecast','scenario'), pairKey('forecast','modeled'),
  pairKey('observed','reference'), pairKey('estimate','reference'), pairKey('forecast','reference')
]);

export function compareMeasureSemantics(aInput,bInput){
  const a=normalizeMeasureSemantic(aInput,0), b=normalizeMeasureSemantic(bInput,1);
  const incompatible=[];
  const contextual=[];

  if(a.phenomenon!==b.phenomenon) incompatible.push('phenomenon_mismatch');
  if(a.unit!==b.unit) incompatible.push('unit_mismatch');
  if(a.denominator!==b.denominator && (a.denominator!=null||b.denominator!=null)) incompatible.push('denominator_mismatch');
  if(a.adjustment!==b.adjustment) incompatible.push('adjustment_mismatch');
  if(a.price_basis!==b.price_basis) incompatible.push('price_basis_mismatch');
  if(a.seasonal_adjustment!==b.seasonal_adjustment) incompatible.push('seasonal_adjustment_mismatch');
  if(a.base_period!==b.base_period && (a.base_period!=null||b.base_period!=null)) incompatible.push('base_period_mismatch');
  if(a.aggregation!==b.aggregation) incompatible.push('aggregation_mismatch');

  if(a.measure_kind!==b.measure_kind){
    const key=pairKey(a.measure_kind,b.measure_kind);
    if(CONTEXTUAL_KIND_PAIRS.has(key)) contextual.push('measure_kind_benchmark');
    else if(HARD_KIND_MISMATCHES.has(key)) incompatible.push('measure_kind_mismatch');
    else incompatible.push('measure_kind_mismatch');
  }

  const ta=a.temporal_basis.type, tb=b.temporal_basis.type;
  if(ta!==tb){
    const structural=ta==='structural'||tb==='structural';
    const benchmarkKind=CONTEXTUAL_KIND_PAIRS.has(pairKey(a.measure_kind,b.measure_kind));
    const referenceStatus=a.observation_status==='reference'||b.observation_status==='reference';
    if(structural&&(benchmarkKind||referenceStatus)) contextual.push(referenceStatus?'climatological_or_historical_reference':'structural_benchmark');
    else incompatible.push('temporal_basis_mismatch');
  }

  if(a.observation_status!==b.observation_status){
    const key=pairKey(a.observation_status,b.observation_status);
    if(CONTEXTUAL_STATUS_PAIRS.has(key)) contextual.push('observation_status_mismatch');
    else incompatible.push('observation_status_mismatch');
  }

  if(incompatible.length){
    const repair=[];
    if(incompatible.includes('temporal_basis_mismatch')) repair.push('split_panels','align_temporal_basis');
    if(incompatible.includes('measure_kind_mismatch')) repair.push('replace_comparison','contextualize_in_text');
    if(incompatible.some(x=>['unit_mismatch','denominator_mismatch','aggregation_mismatch'].includes(x))) repair.push('normalize_measure_definition');
    return result(COMPARABILITY.INCOMPATIBLE,[...new Set(incompatible)],[...new Set(repair)]);
  }
  if(contextual.length){
    return result(COMPARABILITY.CONTEXTUAL,[...new Set(contextual)],['encode_as_reference_or_context','visually_distinguish_semantic_roles']);
  }
  return result(COMPARABILITY.DIRECT,[],[]);
}
