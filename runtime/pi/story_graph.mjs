import { createHash } from 'node:crypto';

export const STORY_GRAPH_SCHEMA_VERSION = '0.1.0';
export const STORY_NODE_KINDS = ['evidence','claim','mechanism','context','outcome','uncertainty'];
export const STORY_EDGE_RELATIONS = ['supports','causes','contributes_to','explains','contrasts_with','qualifies','locates','precedes','benchmarks'];
export const STORY_DIMENSIONS = ['trend','rank','spatial','mechanism','comparison','distribution','uncertainty','human_scale','method','context','outcome'];

function text(value){ return String(value ?? '').trim(); }
function uniq(values){ return [...new Set((values ?? []).map((v)=>text(v)).filter(Boolean))]; }
function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])]));
  return value;
}
function hash(value){ return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function normalizeStoryGraph(input){
  const graph={
    schema_version: STORY_GRAPH_SCHEMA_VERSION,
    story_id: text(input?.story_id) || 'story',
    reader_question: text(input?.reader_question),
    visual_thesis: text(input?.visual_thesis),
    nodes: Array.isArray(input?.nodes) ? input.nodes.map((node)=>({
      id:text(node?.id),
      kind:text(node?.kind),
      summary:text(node?.summary),
      explanatory_dimension:text(node?.explanatory_dimension),
      claim_ids:uniq(node?.claim_ids),
      evidence_refs:uniq(node?.evidence_refs),
      module_hint:text(node?.module_hint),
    })) : [],
    edges: Array.isArray(input?.edges) ? input.edges.map((edge)=>({
      from:text(edge?.from),
      to:text(edge?.to),
      relation:text(edge?.relation),
      note:text(edge?.note),
    })) : [],
    entry_node_ids:uniq(input?.entry_node_ids),
    answer_node_ids:uniq(input?.answer_node_ids),
  };
  return graph;
}

export function validateStoryGraph(input){
  const graph=normalizeStoryGraph(input);
  const errors=[];
  if(input?.schema_version && input.schema_version!==STORY_GRAPH_SCHEMA_VERSION) errors.push(`schema_version must be ${STORY_GRAPH_SCHEMA_VERSION}`);
  if(!graph.reader_question) errors.push('reader_question is required');
  if(!graph.visual_thesis) errors.push('visual_thesis is required');
  if(graph.nodes.length<3 || graph.nodes.length>24) errors.push('nodes must contain 3..24 items');
  if(graph.edges.length<2 || graph.edges.length>48) errors.push('edges must contain 2..48 items');
  const ids=new Set();
  for(const node of graph.nodes){
    if(!node.id) errors.push('every story node requires id');
    else if(ids.has(node.id)) errors.push(`duplicate story node id '${node.id}'`);
    else ids.add(node.id);
    if(!STORY_NODE_KINDS.includes(node.kind)) errors.push(`story node '${node.id || '?'}' has unsupported kind '${node.kind}'`);
    if(!node.summary) errors.push(`story node '${node.id || '?'}' requires summary`);
    if(!STORY_DIMENSIONS.includes(node.explanatory_dimension)) errors.push(`story node '${node.id || '?'}' has unsupported explanatory_dimension '${node.explanatory_dimension}'`);
  }
  for(const edge of graph.edges){
    if(!ids.has(edge.from)) errors.push(`story edge references missing from node '${edge.from}'`);
    if(!ids.has(edge.to)) errors.push(`story edge references missing to node '${edge.to}'`);
    if(edge.from && edge.from===edge.to) errors.push(`story edge '${edge.from}' cannot point to itself`);
    if(!STORY_EDGE_RELATIONS.includes(edge.relation)) errors.push(`story edge '${edge.from}->${edge.to}' has unsupported relation '${edge.relation}'`);
  }
  if(!graph.entry_node_ids.length) errors.push('entry_node_ids must contain at least one node');
  if(!graph.answer_node_ids.length) errors.push('answer_node_ids must contain at least one node');
  for(const id of [...graph.entry_node_ids,...graph.answer_node_ids]) if(!ids.has(id)) errors.push(`story graph references missing entry/answer node '${id}'`);
  return errors;
}

function reachability(graph){
  const forward=new Map(graph.nodes.map((node)=>[node.id,[]]));
  const reverse=new Map(graph.nodes.map((node)=>[node.id,[]]));
  for(const edge of graph.edges){
    if(forward.has(edge.from) && forward.has(edge.to)){
      forward.get(edge.from).push(edge.to);
      reverse.get(edge.to).push(edge.from);
    }
  }
  const walk=(starts,adj)=>{
    const seen=new Set(starts);
    const queue=[...starts];
    while(queue.length){
      const id=queue.shift();
      for(const next of adj.get(id) ?? []) if(!seen.has(next)){ seen.add(next); queue.push(next); }
    }
    return seen;
  };
  return {fromEntries:walk(graph.entry_node_ids,forward),toAnswers:walk(graph.answer_node_ids,reverse)};
}

export function assessStoryGraph(input){
  const graph=normalizeStoryGraph(input);
  const errors=validateStoryGraph(graph);
  if(errors.length) throw new Error(errors.join('; '));
  const {fromEntries,toAnswers}=reachability(graph);
  const answerReachable=graph.answer_node_ids.every((id)=>fromEntries.has(id));
  const narrativelyConnected=graph.nodes.filter((node)=>fromEntries.has(node.id) && toAnswers.has(node.id));
  const closureCoverage=graph.nodes.length ? narrativelyConnected.length/graph.nodes.length : 0;
  const dimensions=uniq(graph.nodes.map((node)=>node.explanatory_dimension));
  const relations=uniq(graph.edges.map((edge)=>edge.relation));
  const compositionalRelations=relations.filter((relation)=>['causes','contributes_to','explains','contrasts_with','qualifies','locates','precedes','benchmarks'].includes(relation));
  const issues=[];
  if(!answerReachable) issues.push({severity:'blocker',code:'reader_question_not_closed',detail:'At least one answer node is unreachable from the story entry nodes.'});
  if(closureCoverage<0.65) issues.push({severity:'blocker',code:'story_graph_low_closure_coverage',value:Number(closureCoverage.toFixed(3))});
  if(dimensions.length<2) issues.push({severity:'blocker',code:'story_graph_single_dimension',value:dimensions});
  if(compositionalRelations.length<1) issues.push({severity:'blocker',code:'story_graph_lacks_narrative_relation'});
  if(relations.length<2) issues.push({severity:'warning',code:'story_graph_relation_monotony',value:relations});
  const passed=!issues.some((issue)=>issue.severity==='blocker');
  const artifact={
    ...graph,
    kind:'story_graph',
    passed,
    metrics:{
      node_count:graph.nodes.length,
      edge_count:graph.edges.length,
      explanatory_dimension_count:dimensions.length,
      relation_count:relations.length,
      closure_coverage:Number(closureCoverage.toFixed(4)),
      answer_reachable:answerReachable,
    },
    explanatory_dimensions:dimensions,
    relation_types:relations,
    issues,
  };
  artifact.content_hash=hash(artifact);
  return artifact;
}

export function evaluateQuestionClosure(graphInput,moduleNodeIds=[],resolutionNodeIds=[]){
  const graph=normalizeStoryGraph(graphInput);
  const mapped=new Set(uniq(moduleNodeIds));
  const resolution=new Set(uniq(resolutionNodeIds));
  const validIds=new Set(graph.nodes.map((node)=>node.id));
  const unknown=[...mapped].filter((id)=>!validIds.has(id));
  const coveredEntries=graph.entry_node_ids.filter((id)=>mapped.has(id));
  const coveredAnswers=graph.answer_node_ids.filter((id)=>mapped.has(id));
  const resolvedAnswers=graph.answer_node_ids.filter((id)=>resolution.has(id));
  const coverage=graph.nodes.length ? graph.nodes.filter((node)=>mapped.has(node.id)).length/graph.nodes.length : 0;
  return {
    passed:unknown.length===0 && coveredEntries.length===graph.entry_node_ids.length && coveredAnswers.length===graph.answer_node_ids.length && resolvedAnswers.length===graph.answer_node_ids.length && coverage>=0.6,
    unknown_node_ids:unknown,
    covered_entry_node_ids:coveredEntries,
    covered_answer_node_ids:coveredAnswers,
    resolved_answer_node_ids:resolvedAnswers,
    node_coverage:Number(coverage.toFixed(4)),
  };
}
