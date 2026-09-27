#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, math
from pathlib import Path
import networkx as nx

SCHEMA_VERSION = "0.1.0"

def stable_hash(obj):
    payload=json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()

def build_graph(spec):
    directed=bool(spec.get("directed",False)); multi=bool(spec.get("multigraph",False))
    G=(nx.MultiDiGraph() if directed and multi else nx.MultiGraph() if multi else nx.DiGraph() if directed else nx.Graph())
    for row in spec.get("nodes",[]):
        node=str(row["id"]); attrs={k:v for k,v in row.items() if k!="id"}; G.add_node(node,**attrs)
    for row in spec.get("edges",[]):
        u,v=str(row["source"]),str(row["target"]); attrs={k:v for k,v in row.items() if k not in {"source","target"}}
        G.add_edge(u,v,**attrs)
    return G

def layout_graph(G, policy, seed):
    name=str(policy.get("name","spring")); scale=float(policy.get("scale",1.0))
    if len(G)==0: return {}
    if name=="spring": pos=nx.spring_layout(G,seed=seed,weight=policy.get("weight","weight"),iterations=int(policy.get("iterations",100)),scale=scale)
    elif name=="forceatlas2": pos=nx.forceatlas2_layout(G,seed=seed,max_iter=int(policy.get("iterations",200)),weight=policy.get("weight","weight"),scaling_ratio=float(policy.get("scaling_ratio",2.0)),gravity=float(policy.get("gravity",1.0)),linlog=bool(policy.get("linlog",False)))
    elif name=="kamada_kawai": pos=nx.kamada_kawai_layout(G,weight=policy.get("weight","weight"),scale=scale)
    elif name=="circular": pos=nx.circular_layout(G,scale=scale)
    elif name=="shell": pos=nx.shell_layout(G,scale=scale)
    elif name=="radial_tree":
        root=str(policy.get("root") or sorted(map(str,G.nodes()))[0])
        if root not in G: raise ValueError(f"radial_tree root not found: {root}")
        base=G.to_undirected() if G.is_directed() else G
        lengths=nx.single_source_shortest_path_length(base,root)
        levels={}
        for n,d in lengths.items(): levels.setdefault(int(d),[]).append(str(n))
        pos={root:(0.0,0.0)}
        first=sorted(levels.get(1,[])); branch_for={}
        for b in first:
            branch_for[b]=b
            for n in nx.node_connected_component(base.copy().subgraph([x for x in base if x!=root]),b) if len(base)>1 else []:
                branch_for.setdefault(str(n),b)
        total=max(1,len(first))
        for depth in sorted(k for k in levels if k>0):
            groups={}
            for n in sorted(levels[depth]): groups.setdefault(branch_for.get(n,n),[]).append(n)
            for gi,(branch,items) in enumerate(sorted(groups.items())):
                if branch in first: center=2*math.pi*first.index(branch)/total
                else: center=2*math.pi*gi/max(1,len(groups))
                spread=min(math.pi/(max(2,total)),0.65)
                for j,n in enumerate(items):
                    offset=0 if len(items)==1 else ((j/(len(items)-1))-.5)*spread
                    angle=center+offset; r=depth*scale/max(1,max(levels))
                    pos[n]=(r*math.cos(angle),r*math.sin(angle))
        for n in G:
            pos.setdefault(str(n),(0.0,0.0))
    else: raise ValueError(f"unsupported layout: {name}")
    return {str(n): [round(float(pos[n][0]),8),round(float(pos[n][1]),8)] for n in pos}

def communities(G, seed):
    if len(G)==0: return {}
    base=G.to_undirected() if G.is_directed() else G
    groups=nx.community.louvain_communities(base,seed=seed,weight="weight")
    out={}
    for i,group in enumerate(sorted(groups,key=lambda g:(-len(g),sorted(map(str,g))[0] if g else ""))):
        for n in group: out[str(n)]=i
    return out

def normalized_metric(values):
    if not values: return {}
    lo=min(values.values()); hi=max(values.values()); span=hi-lo
    if span<=0: return {str(k):0.0 for k in values}
    return {str(k):round((float(v)-lo)/span,8) for k,v in values.items()}

def analyze(spec):
    seed=int(spec.get("seed",42)); G=build_graph(spec)
    if len(G)>50000: raise ValueError("graph exceeds 50,000 node analytical bound")
    if G.number_of_edges()>500000: raise ValueError("graph exceeds 500,000 edge analytical bound")
    base=G.to_undirected() if G.is_directed() else G
    degree=dict(G.degree(weight=spec.get("weight_field","weight")))
    betweenness={}
    if len(G)<=3000:
        k=None if len(G)<=600 else min(256,len(G))
        betweenness=nx.betweenness_centrality(G,k=k,normalized=True,weight=None,seed=seed) if k else nx.betweenness_centrality(G,normalized=True,weight=None)
    pagerank=nx.pagerank(G,weight=spec.get("weight_field","weight")) if len(G) else {}
    comm=communities(G,seed) if spec.get("community",True) else {}
    pos=layout_graph(G,spec.get("layout",{}),seed)
    comps=list(nx.connected_components(base)) if not base.is_directed() else []
    nodes=[]
    for n,data in G.nodes(data=True):
        sid=str(n); nodes.append({"id":sid,"label":str(data.get("label",sid)),"degree":float(degree.get(n,0)),"pagerank":round(float(pagerank.get(n,0)),10),"betweenness":round(float(betweenness.get(n,0)),10) if betweenness else None,"community":comm.get(sid),"x":pos.get(sid,[0,0])[0],"y":pos.get(sid,[0,0])[1],"attrs":data})
    nodes.sort(key=lambda r:r["id"])
    edges=[]
    for u,v,data in G.edges(data=True):
        edges.append({"source":str(u),"target":str(v),"weight":float(data.get(spec.get("weight_field","weight"),1.0)),"attrs":data})
    edges.sort(key=lambda r:(r["source"],r["target"],r["weight"]))
    summary={"node_count":len(G),"edge_count":G.number_of_edges(),"density":round(float(nx.density(G)),10) if len(G)>1 else 0.0,"connected_components":len(comps) if comps else None,"community_count":len(set(comm.values())) if comm else 0,"directed":G.is_directed(),"layout":spec.get("layout",{}).get("name","spring")}
    top=sorted(nodes,key=lambda r:(-r["pagerank"],r["id"]))[:min(10,len(nodes))]
    result={"schema_version":SCHEMA_VERSION,"engine":"networkx","networkx_version":nx.__version__,"input_hash":stable_hash(spec),"seed":seed,"summary":summary,"top_nodes":[{"id":r["id"],"label":r["label"],"pagerank":r["pagerank"],"degree":r["degree"],"community":r["community"]} for r in top],"nodes":nodes,"edges":edges}
    result["result_hash"]=stable_hash(result)
    return result

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--request",required=True); ap.add_argument("--output",required=True); args=ap.parse_args()
    raw=json.loads(Path(args.request).read_text())
    if isinstance(raw,dict) and 'backend' in raw:
        spec=(raw.get('options') or {}).get('graph_spec')
        if spec is None and (raw.get('inputs') or {}).get('graph'):
            spec=json.loads(Path((raw.get('inputs') or {})['graph']).read_text())
        if spec is None: raise ValueError('networkx_graph backend request requires options.graph_spec or inputs.graph')
    else: spec=raw
    result=analyze(spec); out=Path(args.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
    print(json.dumps({"status":"PASS","output":str(out),"result_hash":result["result_hash"],"summary":result["summary"]}))
if __name__=="__main__": main()
