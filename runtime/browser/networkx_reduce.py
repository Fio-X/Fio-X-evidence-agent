#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import networkx as nx

def stable_hash(obj):
    return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def build(spec):
    G=nx.DiGraph() if spec.get('directed') else nx.Graph()
    for n in spec.get('nodes',[]):G.add_node(str(n['id']),**{k:v for k,v in n.items() if k!='id'})
    for e in spec.get('edges',[]):G.add_edge(str(e['source']),str(e['target']),weight=float(e.get('weight',1.0)))
    return G

def reduce_graph(spec):
    seed=int(spec.get('seed',42));limit=int(spec.get('max_meta_edges',120));G=build(spec)
    if len(G)>50000 or G.number_of_edges()>500000: raise ValueError('graph exceeds reduction safety bound')
    base=G.to_undirected() if G.is_directed() else G
    communities=nx.community.louvain_communities(base,seed=seed,weight='weight')
    membership={str(n):i for i,c in enumerate(communities) for n in c}
    pr=nx.pagerank(G,weight='weight') if len(G) else {}; deg=dict(G.degree(weight='weight'))
    meta=[]
    for i,c in enumerate(communities):
        ids=sorted(map(str,c));rep=max(ids,key=lambda x:(pr.get(x,0),deg.get(x,0),x)) if ids else str(i)
        meta.append({'id':f'community-{i}','label':G.nodes[rep].get('label',rep) if rep in G else rep,'member_count':len(ids),'pagerank_mass':sum(float(pr.get(x,0)) for x in ids),'weighted_degree_mass':sum(float(deg.get(x,0)) for x in ids),'representative':rep,'members':ids})
    agg={}
    total_cross=0.0
    for u,v,d in G.edges(data=True):
        a,b=membership[str(u)],membership[str(v)]
        if a==b: continue
        key=(a,b) if G.is_directed() else tuple(sorted((a,b)));w=float(d.get('weight',1.0));total_cross+=w
        row=agg.setdefault(key,{'source':f'community-{key[0]}','target':f'community-{key[1]}','weight':0.0,'edge_count':0});row['weight']+=w;row['edge_count']+=1
    raw=sorted(agg.values(),key=lambda r:(-r['weight'],-r['edge_count'],r['source'],r['target']))
    shown=raw[:limit];retained=sum(r['weight'] for r in shown);fraction=(retained/total_cross) if total_cross else 1.0
    H=nx.Graph();H.add_nodes_from([m['id'] for m in meta]);H.add_weighted_edges_from((r['source'],r['target'],r['weight']) for r in shown)
    pos=nx.spring_layout(H,seed=seed,weight='weight',iterations=120,scale=1.0) if len(H) else {}
    by={m['id']:m for m in meta}
    for n,p in pos.items():by[n]['x']=round(float(p[0]),8);by[n]['y']=round(float(p[1]),8);by[n]['degree']=float(H.degree(n,weight='weight'))
    modularity=nx.community.modularity(base,communities,weight='weight') if communities and G.number_of_edges() else 0.0
    out={'schema_version':'0.1.0','engine':'networkx','networkx_version':nx.__version__,'input_hash':stable_hash(spec),'full_graph_status':'SPECIALIST_RENDERER_REQUIRED' if len(G)>2500 else 'READY','summary':{'original_nodes':len(G),'original_edges':G.number_of_edges(),'community_count':len(meta),'raw_meta_edges':len(raw),'displayed_meta_edges':len(shown),'omitted_meta_edges':max(0,len(raw)-len(shown)),'retained_cross_community_weight_fraction':round(fraction,10),'modularity':round(float(modularity),10)},'nodes':sorted(meta,key=lambda x:x['id']),'edges':shown,'membership':membership}
    out['result_hash']=stable_hash(out);return out

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--request',required=True);ap.add_argument('--output',required=True);args=ap.parse_args();spec=json.loads(Path(args.request).read_text());out=reduce_graph(spec);p=Path(args.output);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'status':'PASS','result_hash':out['result_hash'],'summary':out['summary']}))
if __name__=='__main__':main()
