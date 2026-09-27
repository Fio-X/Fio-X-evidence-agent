#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import plotly.graph_objects as go
import plotly.io as pio

def sha(b): return hashlib.sha256(b).hexdigest()
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--request',required=True);ap.add_argument('--output-dir');args=ap.parse_args()
    req=json.loads(Path(args.request).read_text()); out=Path(args.output_dir or req.get('output_dir') or 'outputs/plotly-browser'); out.mkdir(parents=True,exist_ok=True)
    options=req.get('options') or {}; figure=options.get('figure') or {}
    if not figure.get('data'): raise ValueError('plotly_browser requires options.figure.data')
    fig=go.Figure(figure)
    html=pio.to_html(fig,full_html=True,include_plotlyjs='inline',config={'displaylogo':False,'responsive':True,**(options.get('config') or {})})
    hp=out/'figure.html'; hp.write_text(html)
    manifest={'schema_version':'0.1.0','backend':'plotly_browser','artifact_status':'FINAL_HTML','story_id':req.get('story_id'),'semantic_fingerprint':req.get('semantic_fingerprint'),'evidence_hashes':req.get('evidence_hashes') or {},'claim_ids':req.get('claim_ids') or [],'plotly_python_version':__import__('plotly').__version__,'html':'figure.html','html_sha256':sha(html.encode()),'self_contained':True}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))
if __name__=='__main__':main()
