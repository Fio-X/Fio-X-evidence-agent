import { compileVisualRecipeV2 } from '../visual/visual_compiler_v2.mjs';
import { chooseGisBackend } from './backend_registry.mjs';

export function compileVisualRecipe(recipe={}){
  const v2={
    analytical_job:recipe.analytical_job??'explanatory',
    artifact_mode:(recipe.mode==='interactive'||recipe.interaction)?'interactive':'static_editorial',
    story_family:recipe.story_family??(recipe.density?'density_map':recipe.terrain?'terrain_map':recipe.geographic?'general_map':'editorial_chart'),
    data_profile:{mark_count:Number(recipe.marks??0),temporal:Boolean(recipe.temporal)},
    geography:{enabled:Boolean(recipe.geographic),scale:recipe.scale??'regional',terrain:Boolean(recipe.terrain),context_layers:recipe.context_layers??[]},
    network:{enabled:Boolean(recipe.network),spatial:Boolean(recipe.spatial_network)},
    annotation:{label_count:Number(recipe.labels??0)},
    delivery:{print:recipe.mode!=='interactive',interactive:Boolean(recipe.interaction||recipe.mode==='interactive'),mobile:true,vector_required:recipe.mode!=='interactive'},
    backend_hints:{required_capabilities:recipe.required_capabilities??[],qualification_mode:Boolean(recipe.qualification_mode),challenger_mode:Boolean(recipe.challenger_mode)},
    measure_semantics:recipe.measure_semantics??[],claim_spec:recipe.claim_spec??null,
    generated_imagery:Boolean(recipe.generated_imagery),claim_ids:recipe.claim_ids??[]
  };
  const plan=compileVisualRecipeV2(v2);
  const legacyRender=chooseGisBackend({mode:recipe.mode??'static',marks:Number(recipe.marks??0),labels:Number(recipe.labels??0),interaction:Boolean(recipe.interaction),terrain:Boolean(recipe.terrain),density:Boolean(recipe.density)});
  const geometry=recipe.geographic ? (recipe.language==='r'?'sf_GEOD_GEOS_PROJ':'geopandas_shapely_PROJ') : 'tabular_native';
  const labels=Number(recipe.labels??0);
  const labelEngine=labels>=40?'qgis_pal':(recipe.language==='r'?'mapsf_or_ggrepel':'matplotlib_direct_labels');
  return Object.freeze({...plan,geometry_backend:geometry,render_backend:legacyRender,label_backend:labelEngine,export:recipe.mode==='interactive'?['html','static_fallback_svg']:['svg','pdf','png']});
}
