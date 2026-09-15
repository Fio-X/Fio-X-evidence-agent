export const PLOTLY_EDITORIAL_SCHEMA_VERSION='0.1.0';
const TYPES=new Set(['statistical','sankey','scattergl','parallel_coordinates','sunburst','treemap','icicle','surface3d','network','scientific_map','geo_linked']);
export function compilePlotlyEditorialScene(input={}){
  const visualType=String(input.visual_type||'statistical');
  if(!TYPES.has(visualType)) throw new Error(`unsupported Plotly visual_type: ${visualType}`);
  const figure=input.figure??{};
  if(!Array.isArray(figure.data)||!figure.data.length) throw new Error('Plotly scene requires figure.data');
  return {schema_version:PLOTLY_EDITORIAL_SCHEMA_VERSION,renderer:'plotly_browser',visual_type:visualType,figure:{data:figure.data,layout:figure.layout??{},config:{displaylogo:false,responsive:true,...(figure.config??{})}},controls:[...(input.controls??[])],story_node_ids:[...(input.story_node_ids??[])],claim_ids:[...(input.claim_ids??[])]};
}
export const PLOTLY_EDITORIAL_CAPABILITIES=Object.freeze([...TYPES]);
