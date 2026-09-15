#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
from visual_qa_probe import analyze

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); args=ap.parse_args()
    rows=json.loads(Path(args.input).read_text())
    out={}
    for item in rows:
        key=item['key']; p=Path(item['path']); report=analyze(p)
        report_path=p.parent/'visual-qa.json'; report_path.write_text(json.dumps(report,indent=2)+'\n')
        out[key]=report
    Path(args.output).write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps({'status':'PASS','artifacts':len(out)}))
if __name__=='__main__': main()
