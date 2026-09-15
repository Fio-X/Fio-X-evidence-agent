#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1.0.0"


def sha256_file(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()


def clean_scalar(v: Any):
    if v is None: return None
    try:
        if v != v: return None
    except Exception: pass
    if hasattr(v,'item'):
        try: return clean_scalar(v.item())
        except Exception: pass
    return v


def as_str(v: Any, default="") -> str:
    v=clean_scalar(v)
    return default if v is None else str(v)


def as_int(v: Any):
    v=clean_scalar(v)
    if v is None or v=="": return None
    try: return int(v)
    except Exception: return None


def as_float(v: Any):
    v=clean_scalar(v)
    if v is None or v=="": return None
    try: return float(v)
    except Exception: return None


def as_list(v: Any):
    v=clean_scalar(v)
    if v is None: return []
    if isinstance(v,(list,tuple,set)): return [clean_scalar(x) for x in v if clean_scalar(x) is not None]
    if hasattr(v,'tolist'):
        try:
            x=v.tolist(); return as_list(x)
        except Exception: pass
    return [v]


def stable_id(prefix: str, *parts: Any) -> str:
    raw='\0'.join(as_str(p) for p in parts)
    return f"{prefix}_{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:24]}"


def normalize_tables(tables: dict[str,list[dict]], *, extractor_version="unknown", method="standard", config_sha256=None, provenance=None):
    entities=tables.get('entities',[]); relationships=tables.get('relationships',[])
    title_to_id={}
    nodes=[]
    for r in entities:
        label=as_str(r.get('title')).strip(); typ=as_str(r.get('type'),'unknown').strip() or 'unknown'
        node_id=as_str(r.get('id')).strip() or stable_id('entity',typ,label)
        key=label.casefold()
        if key and key not in title_to_id: title_to_id[key]=node_id
        nodes.append({
            'id':node_id,'label':label,'type':typ,'description':as_str(r.get('description')),
            'frequency':as_int(r.get('frequency')),'degree':as_int(r.get('degree')),
            'evidence_text_unit_ids':sorted({as_str(x) for x in as_list(r.get('text_unit_ids')) if as_str(x)})
        })
    nodes.sort(key=lambda x:(x['label'].casefold(),x['id']))

    edges=[]
    for r in relationships:
        sl=as_str(r.get('source')).strip(); tl=as_str(r.get('target')).strip()
        source=title_to_id.get(sl.casefold()); target=title_to_id.get(tl.casefold())
        if not source or not target:
            raise ValueError(f"relationship endpoint missing from entities: {sl!r} -> {tl!r}")
        edge_id=as_str(r.get('id')).strip() or stable_id('relationship',source,target,r.get('description'))
        edges.append({
            'id':edge_id,'source':source,'target':target,'source_label':sl,'target_label':tl,
            'description':as_str(r.get('description')),'weight':as_float(r.get('weight')),
            'combined_degree':as_int(r.get('combined_degree')),
            'evidence_text_unit_ids':sorted({as_str(x) for x in as_list(r.get('text_unit_ids')) if as_str(x)})
        })
    edges.sort(key=lambda x:(x['source_label'].casefold(),x['target_label'].casefold(),x['id']))

    communities=[]
    for r in tables.get('communities',[]):
        cid=as_int(r.get('community')); rid=as_str(r.get('id')).strip() or stable_id('community',cid,r.get('level'))
        communities.append({
            'id':rid,'community':0 if cid is None else cid,'parent':as_int(r.get('parent')),
            'children':[int(x) for x in as_list(r.get('children')) if as_int(x) is not None],
            'level':as_int(r.get('level')) or 0,'title':as_str(r.get('title')),'size':as_int(r.get('size')),
            'entity_ids':sorted(as_str(x) for x in as_list(r.get('entity_ids')) if as_str(x)),
            'relationship_ids':sorted(as_str(x) for x in as_list(r.get('relationship_ids')) if as_str(x)),
            'evidence_text_unit_ids':sorted(as_str(x) for x in as_list(r.get('text_unit_ids')) if as_str(x))
        })
    communities.sort(key=lambda x:(x['level'],x['community'],x['id']))

    claims=[]
    for r in tables.get('covariates',[]):
        if as_str(r.get('covariate_type'),'claim').lower()!='claim': continue
        subject_label=as_str(r.get('subject_id')).strip(); object_label=as_str(r.get('object_id')).strip() or None
        text_unit=as_str(r.get('text_unit_id')).strip()
        if not text_unit: continue
        claim_id=as_str(r.get('id')).strip() or stable_id('claim',subject_label,object_label,r.get('description'),text_unit)
        claims.append({
            'id':claim_id,'claim_type':as_str(r.get('type'),'claim'),'description':as_str(r.get('description')),
            'status':as_str(r.get('status'),'SUSPECTED'),'subject':title_to_id.get(subject_label.casefold()),
            'object':title_to_id.get(object_label.casefold()) if object_label else None,
            'subject_label':subject_label,'object_label':object_label,'start_date':clean_scalar(r.get('start_date')),
            'end_date':clean_scalar(r.get('end_date')),'source_text':as_str(r.get('source_text')),
            'evidence_text_unit_ids':[text_unit]
        })
    claims.sort(key=lambda x:(x['subject_label'].casefold(),x['claim_type'],x['id']))

    return {
        'schema_version':SCHEMA_VERSION,
        'extractor':{'name':'microsoft-graphrag','version':extractor_version,'method':method,'config_sha256':config_sha256},
        'nodes':nodes,'edges':edges,'communities':communities,'claims':claims,'provenance':provenance or []
    }


def load_parquet_tables(input_dir: Path):
    import pandas as pd
    names=['entities','relationships','communities','covariates']
    tables={}; provenance=[]
    for name in names:
        p=input_dir/f'{name}.parquet'
        if not p.exists():
            if name in ('entities','relationships'): raise FileNotFoundError(p)
            continue
        df=pd.read_parquet(p)
        tables[name]=df.to_dict(orient='records')
        provenance.append({'artifact':p.name,'sha256':sha256_file(p),'row_count':len(df),'format':'parquet'})
    return tables,provenance


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--input-dir',required=True); ap.add_argument('--output',required=True)
    ap.add_argument('--extractor-version',default='3.1.2'); ap.add_argument('--method',default='standard')
    ap.add_argument('--config')
    args=ap.parse_args(); input_dir=Path(args.input_dir); out=Path(args.output)
    cfg_hash=sha256_file(Path(args.config)) if args.config and Path(args.config).exists() else None
    tables,prov=load_parquet_tables(input_dir)
    result=normalize_tables(tables,extractor_version=args.extractor_version,method=args.method,config_sha256=cfg_hash,provenance=prov)
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(result,ensure_ascii=False,sort_keys=True,indent=2)+"\n",encoding='utf-8')
    print(json.dumps({'status':'PASS','output':str(out),'nodes':len(result['nodes']),'edges':len(result['edges']),'claims':len(result['claims'])}))

if __name__=='__main__': main()
