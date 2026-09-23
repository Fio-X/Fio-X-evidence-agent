#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path
from check_source_integrity import tree_rows, tree_hash

def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument('--root',default='.')
    ap.add_argument('--manifest',default='source-integrity.json')
    args=ap.parse_args()
    root=Path(args.root).resolve()
    manifest_path=Path(args.manifest)
    if not manifest_path.is_absolute():
        manifest_path=(root/manifest_path).resolve()
    manifest_path.relative_to(root)
    manifest=json.loads(manifest_path.read_text())
    manifest_rel=manifest_path.relative_to(root).as_posix()
    exclusions=list(manifest.get('excluded_paths',[]))
    evidence_rel=(manifest.get('source_archive') or {}).get('verification_evidence')
    ignored={manifest_rel}
    if evidence_rel:
        ignored.add(str(evidence_rel).replace('\\\\','/'))
    rows=tree_rows(root,exclusions,ignored)
    manifest['file_count']=len(rows)
    manifest['source_tree_sha256']=tree_hash(rows)
    manifest_path.write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'status':'UPDATED','file_count':len(rows),'source_tree_sha256':manifest['source_tree_sha256']},indent=2,sort_keys=True))
    return 0

if __name__=='__main__':
    raise SystemExit(main())
