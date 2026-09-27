export const D3_EDITORIAL_SCHEMA_VERSION='0.1.0';
const TYPES=new Set(['radial_network','radial_hierarchy','circle_packing','sankey','chord','edge_bundle','beeswarm','parallel_coordinates']);
export function compileD3EditorialScene(input={}){
  const visualType=String(input.visual_type||'');
  if(!TYPES.has(visualType)) throw new Error(`unsupported D3 visual_type: ${visualType}`);
  const scene={schema_version:D3_EDITORIAL_SCHEMA_VERSION,renderer:'d3_editorial',visual_type:visualType,data:input.data??{},encodings:input.encodings??{},interaction:input.interaction??{},story_node_ids:[...(input.story_node_ids??[])],claim_ids:[...(input.claim_ids??[])]};
  if(!scene.story_node_ids.length) throw new Error('D3 editorial scene requires story_node_ids');
  return scene;
}
export const D3_EDITORIAL_CAPABILITIES=Object.freeze([...TYPES]);
