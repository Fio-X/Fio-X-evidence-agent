const ALLOWED_DECK_LAYERS=new Set(['TripsLayer','ArcLayer','PathLayer','GeoJsonLayer','MVTLayer','ScatterplotLayer','TextLayer','GridLayer','HexagonLayer']);

function requireFinitePair(v,name){
  if(!Array.isArray(v)||v.length!==2||!v.every(Number.isFinite)) throw new Error(`${name} must be [number, number]`);
}

export function compileWebGeoScene(recipe){
  if(!recipe||typeof recipe!=='object') throw new Error('recipe required');
  const view=recipe.view??{};
  const center=view.center??[0,0]; requireFinitePair(center,'view.center');
  const layers=(recipe.layers??[]).map((layer,i)=>{
    if(!ALLOWED_DECK_LAYERS.has(layer.type)) throw new Error(`unsupported deck.gl layer type: ${layer.type}`);
    if(!layer.id) throw new Error(`layers[${i}].id required`);
    return {id:String(layer.id),type:layer.type,data_ref:layer.data_ref,encoding:layer.encoding??{},pickable:Boolean(layer.pickable),visible:layer.visible!==false};
  });
  return Object.freeze({
    schema_version:'1.0.0',
    renderer:'maplibre_deckgl',
    maplibre:{style_ref:recipe.style_ref??null,center,zoom:Number(view.zoom??2),bearing:Number(view.bearing??0),pitch:Number(view.pitch??0)},
    deck_layers:layers,
    interaction:{hover_optional:true,tap_select:true,keyboard_focus:true,reduced_motion_fallback:true,...(recipe.interaction??{})},
    evidence:{data_hashes:recipe.data_hashes??{},source_note:recipe.source_note??null}
  });
}
