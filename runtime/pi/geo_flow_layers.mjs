import { renderVizBundle, validateVizSpec } from './viz.mjs';

// A composite map is deliberately a small orchestration layer around the
// existing cartographic and Sankey renderers. It keeps the two grammars
// separate while sharing route ids, evidence, and interaction state.
export const GEO_FLOW_LAYERS_SCHEMA_VERSION = '0.1.0';
export const MAX_GEO_FLOW_LAYERS = 6;

const MEASURE_KINDS = new Set(['flow', 'stock', 'rate', 'index', 'capacity', 'share', 'distance', 'count']);

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function text(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

function finite(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function stableId(value, fallback) {
  return text(value, fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function layerSpec(baseSpec, layer) {
  const {
    id: _id,
    label,
    title,
    subtitle,
    unit,
    source_note,
    note,
    geometry_semantics,
    route_provenance_note,
    ...overrides
  } = layer;
  // These fields belong to the composite contract, not to a single map
  // frame. Clearing them prevents the single-layer renderer from presenting
  // a shared scale or a misleading mixed-unit legend.
  const spec = {
    ...baseSpec,
    ...overrides,
    title: text(title, `${baseSpec.title} · ${text(label, layer.id)}`),
    subtitle: text(subtitle, `${baseSpec.subtitle ?? ''}${baseSpec.subtitle ? ' · ' : ''}${text(unit)} · width scale resets within this layer`),
    unit: text(unit),
    source_note: text(source_note, baseSpec.source_note),
    note: [text(note, baseSpec.note), 'This layer has its own width scale; values are not comparable across layers.'].filter(Boolean).join(' '),
    geometry_semantics: text(geometry_semantics, baseSpec.geometry_semantics),
    route_provenance_note: text(route_provenance_note, baseSpec.route_provenance_note),
    flow_layer_field: undefined,
    flow_unit_field: undefined,
    flow_period_field: undefined,
    flow_layer_order: undefined,
  };
  return spec;
}

/**
 * Validate a set of map layers before rendering. The contract requires an
 * explicit unit and temporal basis per layer so a b/d, tonne-km proxy, and
 * USD stock cannot silently share a width scale.
 */
export function validateGeoFlowLayers(config) {
  const blockers = [];
  const warnings = [];
  const baseSpec = config?.baseSpec;
  const layers = Array.isArray(config?.layers) ? config.layers : [];
  if (!baseSpec || typeof baseSpec !== 'object') blockers.push('baseSpec is required');
  else if (baseSpec.chart_type !== 'cartographic_flow_map') blockers.push("baseSpec.chart_type must be 'cartographic_flow_map'");
  else {
    const baseErrors = validateVizSpec({ ...baseSpec, unit: text(baseSpec.unit, 'per-layer') });
    if (baseErrors.length) blockers.push(...baseErrors.map((error) => `baseSpec: ${error}`));
  }
  if (!layers.length) blockers.push('at least one geo-flow layer is required');
  if (layers.length > MAX_GEO_FLOW_LAYERS) blockers.push(`at most ${MAX_GEO_FLOW_LAYERS} geo-flow layers are supported`);
  const ids = new Set();
  const order = Array.isArray(config?.layer_order) ? config.layer_order.map((value) => text(value)) : null;
  for (const [index, layer] of layers.entries()) {
    if (!layer || typeof layer !== 'object') {
      blockers.push(`layers[${index}] must be an object`);
      continue;
    }
    const id = stableId(layer.id, `layer-${index + 1}`);
    if (ids.has(id)) blockers.push(`duplicate geo-flow layer id '${id}'`);
    ids.add(id);
    const label = text(layer.label, id);
    const unit = text(layer.unit);
    const measureKind = text(layer.measure_kind);
    const period = text(layer.temporal_basis);
    if (!unit) blockers.push(`layer '${label}' needs an explicit unit`);
    if (!measureKind || !MEASURE_KINDS.has(measureKind)) blockers.push(`layer '${label}' needs a supported measure_kind (${[...MEASURE_KINDS].join(', ')})`);
    if (!period) blockers.push(`layer '${label}' needs temporal_basis`);
    if (!text(layer.source_url)) blockers.push(`layer '${label}' needs source_url`);
    if (!text(layer.source_note)) blockers.push(`layer '${label}' needs source_note`);
    if (!Array.isArray(layer.rows) || !layer.rows.length) blockers.push(`layer '${label}' needs non-empty rows`);
    if (Array.isArray(layer.rows)) {
      const valueField = text(layer.value_field, baseSpec?.value_field);
      const badValues = layer.rows.filter((row) => finite(row?.[valueField]) === null || finite(row?.[valueField]) < 0).length;
      if (badValues) blockers.push(`layer '${label}' has ${badValues} missing, non-numeric, or negative value(s)`);
      const mapSpec = baseSpec ? layerSpec(baseSpec, { ...layer, id, label, unit }) : null;
      if (mapSpec) {
        const errors = validateVizSpec(mapSpec);
        if (errors.length) blockers.push(...errors.map((error) => `layer '${label}': ${error}`));
      }
    }
    if (layer.geometry_semantics === 'abstract_od' && !/relationship|abstract|proxy|anchor/i.test(`${layer.note ?? ''} ${layer.geometry_note ?? ''}`)) warnings.push(`layer '${label}' uses abstract_od; add a plain-language relationship disclosure`);
  }
  if (order) {
    if (order.length !== layers.length || new Set(order).size !== order.length) blockers.push('layer_order must be an exact permutation of layer ids');
    else for (const id of ids) if (!order.includes(id)) blockers.push(`layer_order is missing '${id}'`);
  }
  const units = [...new Set(layers.map((layer) => text(layer.unit)).filter(Boolean))];
  if (units.length < layers.length) warnings.push('two or more layers share a unit; scales are still reset because their measure semantics differ');
  return {
    schema_version: GEO_FLOW_LAYERS_SCHEMA_VERSION,
    passed: blockers.length === 0,
    blockers,
    warnings,
    layer_ids: order ?? layers.map((layer, index) => stableId(layer.id, `layer-${index + 1}`)),
    scale_policy: 'within_layer_only',
  };
}

/** Render the map half of each validated layer with stable route ids. */
export function renderGeoFlowLayers(config) {
  const validation = validateGeoFlowLayers(config);
  if (!validation.passed) throw new Error(validation.blockers.join('; '));
  const byId = new Map(config.layers.map((layer, index) => [stableId(layer.id, `layer-${index + 1}`), layer]));
  return {
    ...validation,
    layers: validation.layer_ids.map((id) => {
      const layer = byId.get(id);
      const spec = layerSpec(config.baseSpec, { ...layer, id });
      const bundle = renderVizBundle(spec, layer.rows);
      return { ...layer, id, spec, bundle };
    }),
  };
}

function scopeSvg(svg, scope) {
  // Static SVGs have deterministic ids. Scope them before placing multiple
  // frames in one document so aria references and marker URLs remain valid.
  return String(svg)
    .replace(/id="([^"]+)"/g, (_match, id) => `id="${scope}-${id}"`)
    .replace(/url\(#([^\)]+)\)/g, (_match, id) => `url(#${scope}-${id})`)
    .replace(/aria-labelledby="([^"]+)"/g, (_match, ids) => `aria-labelledby="${ids.split(/\s+/).map((id) => `${scope}-${id}`).join(' ')}"`)
    .replace(/aria-describedby="([^"]+)"/g, (_match, ids) => `aria-describedby="${ids.split(/\s+/).map((id) => `${scope}-${id}`).join(' ')}"`);
}

function layerTable(layer) {
  const rows = Array.isArray(layer.rows) ? layer.rows : [];
  const source = text(layer.source_field, 'source');
  const target = text(layer.target_field, 'target');
  const value = text(layer.value_field, 'value');
  const limit = Math.min(rows.length, 12);
  const body = rows.slice(0, limit).map((row) => `<tr><td>${esc(row?.[source])}</td><td>${esc(row?.[target])}</td><td>${esc(row?.[value])}</td></tr>`).join('');
  return `<details class="flow-data"><summary>Show source rows (${rows.length})</summary><div class="table-scroll"><table><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Value (${esc(layer.unit)})</th></tr></thead><tbody>${body}</tbody></table></div>${rows.length > limit ? `<p class="fine-print">First ${limit} rows shown; the artifact retains all ${rows.length} rows.</p>` : ''}</details>`;
}

/**
 * Build a self-contained, interactive map + Sankey composite. `layers` must
 * be the result of renderGeoFlowLayers with an optional `sankeySvg` and
 * `sankeyMobileSvg` attached by the caller.
 */
export function renderGeoFlowCompositeHtml({ title, dek, readerQuestion, sourceNote, layers, activeLayer } = {}) {
  if (!Array.isArray(layers) || !layers.length) throw new Error('renderGeoFlowCompositeHtml requires rendered layers');
  const active = text(activeLayer, layers[0].id);
  const cards = layers.map((layer, index) => {
    const selected = layer.id === active;
    const label = text(layer.label, layer.id);
    const mapDesktop = scopeSvg(layer.bundle?.desktop ?? '', `map-${layer.id}`);
    const sankeyDesktop = scopeSvg(layer.sankeySvg ?? '', `sankey-${layer.id}`);
    const mapMobile = scopeSvg(layer.bundle?.mobile ?? '', `map-${layer.id}-mobile`);
    const sankeyMobile = scopeSvg(layer.sankeyMobileSvg ?? sankeyDesktop, `sankey-${layer.id}-mobile`);
    return `<section class="flow-layer" id="layer-${esc(layer.id)}" data-layer-id="${esc(layer.id)}" aria-labelledby="layer-heading-${esc(layer.id)}"${selected ? '' : ' hidden'}>
      <div class="layer-heading"><div><p class="eyebrow">${esc(label)}</p><h2 id="layer-heading-${esc(layer.id)}">${esc(layer.title ?? label)}</h2><p class="layer-dek">${esc(layer.subtitle ?? '')}</p></div><div class="layer-meta"><strong>${esc(layer.unit)}</strong><span>width scale resets here</span><span>${esc(layer.temporal_basis)}</span></div></div>
      <div class="visual-pair"><figure class="visual-card"><figcaption><span>Geographic relationships</span><small>WGS84 · Natural Earth Admin 0 · ${esc(layer.geometry_semantics ?? 'abstract_od')}</small></figcaption><div class="responsive-frame desktop-frame">${mapDesktop}</div><div class="responsive-frame mobile-frame">${mapMobile}</div></figure><figure class="visual-card"><figcaption><span>Flow topology</span><small>Two-end aggregate Sankey · ${esc(layer.unit)}</small></figcaption><div class="responsive-frame desktop-frame">${sankeyDesktop}</div><div class="responsive-frame mobile-frame">${sankeyMobile}</div></figure></div>
      <p class="layer-note">${esc(layer.note ?? '')}</p><p class="layer-source"><strong>Source:</strong> ${esc(layer.source_note)} · <a href="${esc(layer.source_url)}" rel="noreferrer">published source</a> · accessed ${esc(layer.source_accessed ?? 'date not supplied')}</p>${layerTable(layer)}
    </section>`;
  }).join('\n');
  const buttons = layers.map((layer, index) => `<button type="button" class="layer-tab" data-layer-target="${esc(layer.id)}" aria-controls="layer-${esc(layer.id)}" aria-selected="${layer.id === active ? 'true' : 'false'}"><span class="tab-index">0${index + 1}</span>${esc(layer.label ?? layer.id)}<span class="tab-unit">${esc(layer.unit ?? '')}</span></button>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title><style>
:root{--paper:#f0efeb;--ink:#1c1c1a;--muted:#62645f;--line:#c8c9c2;--panel:#fff;--accent:#b24a35;--blue:#355c7d;--max:1360px}*{box-sizing:border-box}html,body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{overflow-x:hidden}.page{max-width:var(--max);margin:0 auto;padding:38px 34px 70px}.eyebrow{margin:0 0 8px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.title{max-width:1110px;margin:0;font-family:Georgia,serif;font-size:clamp(38px,5.4vw,74px);line-height:.98;letter-spacing:-.035em}.dek{max-width:960px;margin:18px 0 0;color:var(--muted);font-size:clamp(18px,2vw,25px);line-height:1.38}.thesis{max-width:960px;margin:28px 0 30px;padding:16px 18px;border-left:4px solid var(--accent);background:#fff;font-size:15px;line-height:1.5}.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 14px;padding-bottom:11px;border-bottom:1px solid var(--line)}.layer-tab{display:flex;align-items:center;gap:9px;border:1px solid #aeb1aa;border-radius:3px;background:transparent;color:var(--ink);padding:10px 13px;font:700 14px/1 inherit;cursor:pointer}.layer-tab[aria-selected=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}.layer-tab:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.tab-index{color:var(--accent);font-variant-numeric:tabular-nums}.layer-tab[aria-selected=true] .tab-index{color:#efb9a8}.tab-unit{font-size:11px;font-weight:500;color:var(--muted)}.layer-tab[aria-selected=true] .tab-unit{color:#d8d8d2}.layer-heading{display:flex;justify-content:space-between;gap:30px;align-items:end;margin:25px 0 15px}.layer-heading h2{margin:0;font:700 clamp(24px,3vw,38px)/1.05 Georgia,serif;letter-spacing:-.02em}.layer-dek{margin:7px 0 0;color:var(--muted);font-size:14px}.layer-meta{display:grid;grid-template-columns:auto auto;gap:4px 12px;min-width:220px;border-top:2px solid var(--ink);padding-top:8px;text-align:right}.layer-meta strong{grid-column:1/-1;font:700 22px Georgia,serif}.layer-meta span{color:var(--muted);font-size:11px}.visual-pair{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:16px;align-items:start}.visual-card{margin:0;background:var(--panel);border-top:3px solid var(--ink);box-shadow:0 1px 0 rgba(28,28,26,.12)}.visual-card figcaption{display:flex;justify-content:space-between;gap:14px;align-items:baseline;padding:11px 14px 8px;font-weight:800;font-size:14px}.visual-card figcaption small{color:var(--muted);font-size:10px;font-weight:500;text-align:right}.responsive-frame{padding:0 6px 10px}.responsive-frame svg{display:block;width:100%;height:auto}.mobile-frame{display:none}.layer-note{max-width:1000px;margin:13px 0 6px;color:var(--muted);font-size:13px;line-height:1.45}.layer-source{margin:0;color:var(--muted);font-size:12px;line-height:1.5}.layer-source a{color:inherit}.flow-data{margin-top:15px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.flow-data summary{padding:9px 0;cursor:pointer;font-weight:700}.table-scroll{overflow-x:auto}.flow-data table{border-collapse:collapse;width:100%;background:#fff;color:var(--ink)}.flow-data th,.flow-data td{padding:6px 8px;border-bottom:1px solid #e2e2dd;text-align:left;white-space:nowrap}.fine-print{font-size:11px}.flow-layer[hidden]{display:none}.flow-hit,.cartographic-hit{cursor:crosshair}.is-muted{opacity:.12!important}.is-active{opacity:1!important;filter:drop-shadow(0 0 1px var(--accent))}.focus-status{min-height:22px;margin:3px 0 10px;color:var(--muted);font-size:13px}.legend-rule{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin:13px 0}.legend-rule span{display:inline-flex;gap:6px;align-items:center}.legend-rule i{display:inline-block;width:22px;border-top:3px solid var(--ink)}.legend-rule i.dashed{border-top-style:dashed;border-color:var(--muted)}footer{border-top:1px solid var(--line);margin-top:32px;padding-top:12px;color:var(--muted);font-size:12px;line-height:1.5}@media(max-width:900px){.page{padding:27px 16px 48px}.visual-pair{grid-template-columns:1fr}.layer-heading{align-items:start;flex-direction:column;gap:13px}.layer-meta{width:100%;text-align:left;grid-template-columns:auto auto auto}.layer-meta strong{grid-column:auto}.visual-card figcaption{display:block}.visual-card figcaption small{display:block;margin-top:4px;text-align:left}.desktop-frame{display:none}.mobile-frame{display:block}.tabs{overflow-x:auto;flex-wrap:nowrap;padding-bottom:10px}.layer-tab{flex:0 0 auto}.title{font-size:clamp(38px,11vw,58px)}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><main class="page"><p class="eyebrow">Fio-X · cartographic flow prototype</p><h1 class="title">${esc(title)}</h1><p class="dek">${esc(dek)}</p><div class="thesis"><strong>Reader question:</strong> ${esc(readerQuestion)}<br><strong>Scale rule:</strong> line width compares observations only within the selected layer. Energy, logistics exposure and capital estimates keep separate units and sources.</div><nav class="tabs" aria-label="Flow layer selector">${buttons}</nav><p class="focus-status" id="focus-status" aria-live="polite">Hover a route to highlight the matching map and Sankey path; click to pin it.</p><div class="legend-rule"><span><i></i>origin → destination</span><span><i class="dashed"></i>abstract/geodesic relationship, not a physical route</span><span>↔ keyboard focus available on routes</span></div>${cards}<footer>${esc(sourceNote)}</footer></main><script>
(function(){const tabs=[...document.querySelectorAll('.layer-tab')],cards=[...document.querySelectorAll('.flow-layer')],status=document.getElementById('focus-status');let pinned=null;function card(id){return document.querySelector('.flow-layer[data-layer-id="'+CSS.escape(id)+'"]')}function clear(c){if(!c)return;c.querySelectorAll('[data-flow-key]').forEach(el=>el.classList.remove('is-muted','is-active'))}function focus(c,key,pin){if(!c)return;const all=[...c.querySelectorAll('[data-flow-key]')];if(!key){clear(c);status.textContent='Hover a route to highlight the matching map and Sankey path; click to pin it.';return}all.forEach(el=>{const same=el.getAttribute('data-flow-key')===key;el.classList.toggle('is-active',same);el.classList.toggle('is-muted',!same)});const tab=document.querySelector('.layer-tab[aria-selected="true"]');status.textContent=(pin?'Pinned: ':'Focused: ')+key+' · '+(tab?.textContent.trim()||'selected layer');}function activate(id){tabs.forEach(t=>{const on=t.dataset.layerTarget===id;t.setAttribute('aria-selected',String(on));});cards.forEach(c=>{c.hidden=c.dataset.layerId!==id;clear(c)});pinned=null;status.textContent='Hover a route to highlight the matching map and Sankey path; click to pin it.';const active=card(id);if(active)active.querySelector('[data-role$="-hit"]')?.focus({preventScroll:true});}tabs.forEach(t=>t.addEventListener('click',()=>activate(t.dataset.layerTarget)));cards.forEach(c=>{const routes=[...c.querySelectorAll('[data-role="cartographic-hit"],[data-role="flow-hit"]')];const seen=new Set();routes.forEach(el=>{const key=el.getAttribute('data-flow-key');if(seen.has(key))return;seen.add(key);el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label','Flow route '+key);el.addEventListener('pointerenter',()=>{if(!pinned)focus(c,key,false)});el.addEventListener('pointerleave',()=>{if(!pinned)focus(c,null,false)});el.addEventListener('focus',()=>focus(c,key,false));el.addEventListener('blur',()=>{if(!pinned)focus(c,null,false)});el.addEventListener('click',()=>{pinned=pinned===key?null:key;focus(c,pinned,pinned!==null)});el.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();pinned=pinned===key?null:key;focus(c,pinned,pinned!==null)}if(ev.key==='Escape'){pinned=null;focus(c,null,false)}})});});window.__GEO_FLOW_READY=true;})();
</script></body></html>`;
}
