import { requireBasemap, basemapAdequacy } from './basemap_registry.mjs';
export const MAP_SPEC_VERSION='0.2.0';
const SUPPORTED=new Set(['0.1.0','0.2.0']);
const PROJECTIONS=new Set(['equirectangular']);const REFERENCE_TYPES=new Set(['reference_points','reference_lines','line']);const LAYER_TYPES=new Set(['observations','line','polygon','reference_points','reference_lines']);
function extentOk(e){return e&&Number.isFinite(e.west)&&Number.isFinite(e.east)&&Number.isFinite(e.south)&&Number.isFinite(e.north)&&e.west<e.east&&e.south<e.north&&e.west>=-180&&e.east<=180&&e.south>=-90&&e.north<=90;}
function assetAdequacy(asset,task){const rank={coarse:0,low:1,intermediate:2,high:3,full:4};const need=['local','site'].includes(task)?2:0;return {adequate:(rank[asset.detail_class]??-1)>=need,reason:(rank[asset.detail_class]??-1)>=need?'ok':'detail_too_low',task};}
export function validateMapSpec(spec){const errors=[];if(!spec||typeof spec!=='object'||Array.isArray(spec))return {status:'BLOCK',errors:['spec must be an object']};if(!SUPPORTED.has(spec.schema_version))errors.push(`schema_version must be one of ${[...SUPPORTED].join(', ')}`);if(!PROJECTIONS.has(spec.projection))errors.push('projection must be equirectangular');if(spec.crs!=='EPSG:4326')errors.push('crs must be EPSG:4326');if(!extentOk(spec.extent))errors.push('extent is invalid');let basemap=null;
  if(spec.schema_version==='0.2.0'&&spec.basemap_asset){const a=spec.basemap_asset;if(!a.content_hash||!a.source_url||!a.license||!extentOk(a.extent)||!Array.isArray(a.features))errors.push('basemap_asset requires content_hash, source_url, license, extent and features');else{const q=assetAdequacy(a,spec.task||'regional');if(!q.adequate)errors.push(`basemap_inadequate:${q.reason}:${q.task}`);basemap={id:a.id||'inline',content_hash:a.content_hash,source_url:a.source_url,license:a.license,detail_class:a.detail_class};}}
  else{try{const b=requireBasemap(spec.basemap_id);const q=basemapAdequacy(b,spec.extent,spec.task||null);if(!q.adequate)errors.push(`basemap_inadequate:${q.reason}:${q.task}`);basemap={id:b.id,content_hash:b.content_hash,source_url:b.source_url,license:b.license};}catch(e){errors.push(String(e.message||e));}}
  if(!spec.scale||spec.scale.enabled!==true)errors.push('scale.enabled must be true');if(spec.scale?.unit!=='km')errors.push('scale.unit must be km');if(!Array.isArray(spec.layers)||!spec.layers.length)errors.push('layers requires at least one layer');const ids=new Set();for(const [i,l] of (spec.layers||[]).entries()){if(!l||typeof l!=='object'){errors.push(`layers[${i}] invalid`);continue;}if(!l.id||ids.has(l.id))errors.push(`layers[${i}].id missing or duplicate`);else ids.add(l.id);if(!LAYER_TYPES.has(l.type))errors.push(`layers[${i}].type unsupported`);if(l.type==='observations'){if(l.encoding?.color_scale==='rainbow')errors.push(`layers[${i}]:rainbow_color_scale_disallowed`);}}
  // Reference layers (points / lines without a measured value). Coordinates
  // are never typed into the spec: they are read from a recorded data file (or
  // a source-bound computation) pinned by sha256 and resolved by
  // map_reference_layers.mjs. Inline coordinates are rejected outright.
  const INLINE_KEYS=['points','coordinates','vertices','features','geometry','lon','lat','lons','lats'];
  for(const [i,l] of (spec.layers||[]).entries()){if(!l||typeof l!=='object'||l.type==='observations')continue;
    if(l.type==='polygon'){errors.push(`layers[${i}].type polygon is not rendered; use reference_lines with a bound source`);continue;}
    if(!REFERENCE_TYPES.has(l.type))continue;
    for(const k of INLINE_KEYS)if(l[k]!==undefined)errors.push(`layers[${i}].${k}: inline coordinates are rejected; reference a recorded data file via source`);
    const src=l.source;if(!src||typeof src!=='object'){errors.push(`layers[${i}].source required (path, sha256, format)`);continue;}
    if(typeof src.path!=='string'||!/^(data\/[^/]+|computations\/[0-9a-f]{64}\.json)$/.test(src.path))errors.push(`layers[${i}].source.path must be a data/<file> or computations/<hash>.json reference`);
    if(typeof src.sha256!=='string'||!/^[0-9a-f]{64}$/.test(src.sha256))errors.push(`layers[${i}].source.sha256 must be 64 lowercase hex characters`);
    const fmt=src.format;if(!['geojson','csv','rows'].includes(fmt))errors.push(`layers[${i}].source.format must be geojson, csv or rows`);
    if(typeof src.path==='string'&&src.path.startsWith('computations/')&&fmt!=='rows')errors.push(`layers[${i}].source.format must be rows for a computation`);
    if(typeof src.path==='string'&&src.path.startsWith('data/')&&fmt==='rows')errors.push(`layers[${i}].source.format rows is only for computations`);
    if(typeof src.name_field!=='string'||!src.name_field)errors.push(`layers[${i}].source.name_field required: every feature needs a visible name`);
    if(fmt==='csv'||fmt==='rows'){if(!src.lon_field||!src.lat_field)errors.push(`layers[${i}].source.lon_field and lat_field required`);if(l.type!=='reference_points'&&!src.group_field)errors.push(`layers[${i}].source.group_field required to assemble lines from vertex rows`);}
    if(l.status_field!==undefined&&(typeof l.status_field!=='string'||!l.status_field))errors.push(`layers[${i}].status_field must be a non-empty field name`);
  }
  // Observation layers: same rule as reference layers. Every point comes from a
  // pinned recorded file, never from the spec, so a coordinate cannot be typed in.
  for(const [i,l] of (spec.layers||[]).entries()){if(!l||typeof l!=='object'||l.type!=='observations')continue;
    for(const k of INLINE_KEYS)if(l[k]!==undefined)errors.push(`layers[${i}].${k}: inline coordinates are rejected; reference a recorded data file via source`);
    const src=l.source;if(!src||typeof src!=='object'){errors.push(`layers[${i}].source required (path, sha256, format, lon_field, lat_field)`);continue;}
    if(typeof src.path!=='string'||!/^(data\/[^/]+|computations\/[0-9a-f]{64}\.json)$/.test(src.path))errors.push(`layers[${i}].source.path must be a data/<file> or computations/<hash>.json reference`);
    if(typeof src.sha256!=='string'||!/^[0-9a-f]{64}$/.test(src.sha256))errors.push(`layers[${i}].source.sha256 must be 64 lowercase hex characters`);
    const fmt=src.format;if(!['geojson','csv','rows'].includes(fmt))errors.push(`layers[${i}].source.format must be geojson, csv or rows`);
    if(typeof src.path==='string'&&src.path.startsWith('computations/')&&fmt!=='rows')errors.push(`layers[${i}].source.format must be rows for a computation`);
    if(typeof src.path==='string'&&src.path.startsWith('data/')&&fmt==='rows')errors.push(`layers[${i}].source.format rows is only for computations`);
    if(fmt==='csv'||fmt==='rows'){if(!src.lon_field||!src.lat_field)errors.push(`layers[${i}].source.lon_field and lat_field required`);}
    for(const f of ['value_field','size_field','uncertainty_field','label_field'])if(src[f]!==undefined&&(typeof src[f]!=='string'||!src[f]))errors.push(`layers[${i}].source.${f} must be a non-empty field name`);
  }
  if(spec.style_intent&&spec.style_intent!=='nature_scientific_map')errors.push('style_intent must be nature_scientific_map when supplied');return {status:errors.length?'BLOCK':'PASS',errors,basemap};}
export function assertMapSpec(spec){const gate=validateMapSpec(spec);if(gate.status!=='PASS')throw new Error(`MAP_SPEC_BLOCKED: ${gate.errors.join(' | ')}`);return gate;}
