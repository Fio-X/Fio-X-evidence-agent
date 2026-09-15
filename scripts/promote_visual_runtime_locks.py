#!/usr/bin/env python3
"""Combine runtime CI lock fragments into a deployable digest-pinned registry.

A runtime is promotable only when its fragment records a PASS health result and an
immutable sha256 image digest. The resulting lock is the only file production
routing should trust when container execution is enabled.
"""
from __future__ import annotations
import argparse, json, re
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DIGEST_RE=re.compile(r'^sha256:[0-9a-f]{64}$')
HEX64=re.compile(r'^[0-9a-f]{64}$')


def load_expected():
    m=json.loads((ROOT/'runtimes/build-matrix.json').read_text())
    return set(m['runtimes'])


def validate_fragment(obj, expected):
    rid=obj.get('runtime')
    if rid not in expected: raise ValueError(f'unknown runtime fragment: {rid!r}')
    if obj.get('health_status')!='PASS': raise ValueError(f'{rid}: health_status must be PASS')
    if not DIGEST_RE.match(str(obj.get('image_digest',''))): raise ValueError(f'{rid}: invalid image_digest')
    for key in ('deps_sha256','health_sha256','definition_sha256'):
        if not HEX64.match(str(obj.get(key,''))): raise ValueError(f'{rid}: invalid {key}')
    if not obj.get('image'): raise ValueError(f'{rid}: image is required')
    return rid


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--fragments-dir',required=True)
    ap.add_argument('--source-commit',required=True)
    ap.add_argument('--output',default='runtimes/runtime-lock.json')
    ap.add_argument('--require-all',action='store_true')
    args=ap.parse_args()
    expected=load_expected(); frag_dir=Path(args.fragments_dir)
    files=sorted(frag_dir.glob('*.json'))
    if not files: raise SystemExit('no runtime lock fragments found')
    rows={}
    for p in files:
        obj=json.loads(p.read_text()); rid=validate_fragment(obj,expected)
        if rid in rows: raise SystemExit(f'duplicate runtime fragment: {rid}')
        rows[rid]=obj
    missing=sorted(expected-set(rows))
    if args.require_all and missing: raise SystemExit('missing runtime fragments: '+', '.join(missing))
    out={
        'schema_version':'1.0.0',
        'source_commit':args.source_commit,
        'generated_at':datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        'runtimes':{k:rows[k] for k in sorted(rows)}
    }
    dest=Path(args.output); dest.parent.mkdir(parents=True,exist_ok=True); dest.write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps({'status':'PASS','runtime_count':len(rows),'missing':missing,'output':str(dest)},indent=2))

if __name__=='__main__': main()
