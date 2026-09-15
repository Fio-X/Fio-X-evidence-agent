#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, subprocess, sys
from pathlib import Path
from graphrag_to_evidence import sha256_file


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args()
    req=json.loads(Path(args.request).read_text(encoding='utf-8'))
    workspace=Path(req['workspace']).resolve(); method=req.get('method','standard')
    if method not in {'standard','fast','standard-update','fast-update'}: raise SystemExit('unsupported GraphRAG method')
    initialize=bool(req.get('initialize',False)); run_index=bool(req.get('run_index',True))
    workspace.mkdir(parents=True,exist_ok=True)
    settings=workspace/'settings.yaml'
    commands=[]
    if initialize:
        cmd=['graphrag','init','--root',str(workspace),'--force']; commands.append(cmd); subprocess.run(cmd,check=True)
    if run_index:
        if not settings.exists(): raise SystemExit(f'missing {settings}; initialize/configure workspace before indexing')
        cmd=['graphrag','index','--root',str(workspace),'--method',method]
        if req.get('no_cache'): cmd.append('--no-cache')
        commands.append(cmd); subprocess.run(cmd,check=True)
    output_dir=workspace/'output'
    evidence_path=Path(req.get('evidence_output',workspace/'evidence-graph.json')).resolve()
    converter=Path(__file__).with_name('graphrag_to_evidence.py')
    cmd=[sys.executable,str(converter),'--input-dir',str(output_dir),'--output',str(evidence_path),'--extractor-version','3.1.2','--method',method]
    if settings.exists(): cmd += ['--config',str(settings)]
    commands.append(cmd); subprocess.run(cmd,check=True)
    manifest={
      'schema_version':'1.0.0','status':'PASS','extractor':'microsoft-graphrag','version':'3.1.2','method':method,
      'evidence_graph':str(evidence_path),'evidence_graph_sha256':sha256_file(evidence_path),
      'settings_sha256':sha256_file(settings) if settings.exists() else None,
      'commands':commands
    }
    manifest_path=Path(req.get('manifest_output',workspace/'graph-extraction-manifest.json')).resolve()
    manifest_path.write_text(json.dumps(manifest,indent=2)+"\n",encoding='utf-8')
    print(json.dumps(manifest))

if __name__=='__main__': main()
