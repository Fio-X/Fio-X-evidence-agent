#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, subprocess, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
VERSIONS=json.loads((ROOT/'versions.json').read_text())
EXCLUDE_PREFIXES=('outputs/','.newsroom/','.git/','target/','__pycache__/')
EXCLUDE_FILES={'release-manifest.json'}
def sha(p):
    h=hashlib.sha256();
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()
def git_commit():
    try:return subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True,stderr=subprocess.DEVNULL).strip()
    except Exception:return None
def source_paths():
    try:
        raw=subprocess.check_output(
            ['git','ls-files','--cached','--others','--exclude-standard','-z'],
            cwd=ROOT,
        )
        return [ROOT/part.decode() for part in raw.split(b'\0') if part]
    except Exception:
        return list(ROOT.rglob('*'))
def main():
    files=[]
    for p in sorted(source_paths()):
        if not p.is_file():continue
        rel=p.relative_to(ROOT).as_posix()
        if any(rel.startswith(x) for x in EXCLUDE_PREFIXES) or rel in EXCLUDE_FILES:continue
        files.append({'path':rel,'sha256':sha(p),'bytes':p.stat().st_size})
    runtime_manifests=[]
    for p in sorted((ROOT/'runtimes').glob('*/manifest.json')):
        runtime_manifests.append({'path':p.relative_to(ROOT).as_posix(),'sha256':sha(p)})
    lock_paths={
      'cargo_lock':'Cargo.lock',
      'npm_web_lock':'runtime/web/package-lock.json',
      'npm_sigma_lock':'runtime/sigma/package-lock.json',
      'npm_map_lock':'runtime/map/package-lock.json',
      'npm_d3_lock':'runtime/d3/package-lock.json',
    }
    locks={k:{'path':rel,'present':(ROOT/rel).is_file(),'sha256':sha(ROOT/rel) if (ROOT/rel).is_file() else None} for k,rel in lock_paths.items()}
    source_tree_payload=json.dumps(files,sort_keys=True,separators=(',',':')).encode()
    source_tree_sha256=hashlib.sha256(source_tree_payload).hexdigest()
    out={
      'schema_version':'0.2.0','release':VERSIONS['release'],'created_at_epoch':int(time.time()),'source_commit':git_commit(),
      'source_tree':{'file_count':len(files),'bytes':sum(x['bytes'] for x in files),'sha256':source_tree_sha256,'files':files},
      'dependency_locks':locks,'runtime_manifests':runtime_manifests,
      'qualification':{
        'pr_release_check':'outputs/v113-release-check-pr.json' if (ROOT/'outputs/v113-release-check-pr.json').is_file() else None,
        'rc_release_check':'outputs/v113-release-check-rc.json' if (ROOT/'outputs/v113-release-check-rc.json').is_file() else None,
        'rc_segmented':'outputs/v113-rc-segmented.json' if (ROOT/'outputs/v113-rc-segmented.json').is_file() else None,
        'production_preflight':'outputs/v113-production-preflight.json' if (ROOT/'outputs/v113-production-preflight.json').is_file() else None,
        'cold_story_gate':'outputs/v113-cold-story-gate.json' if (ROOT/'outputs/v113-cold-story-gate.json').is_file() else None,
        'browser_cpu':'outputs/v113-browser/cpu/browser-qa.json' if (ROOT/'outputs/v113-browser/cpu/browser-qa.json').is_file() else None,
        'browser_gpu':'outputs/v113-browser/gpu/browser-qa.json' if (ROOT/'outputs/v113-browser/gpu/browser-qa.json').is_file() else None,
        'final_dossier':'outputs/v113-final-qualification.json' if (ROOT/'outputs/v113-final-qualification.json').is_file() else None,
      },
    }
    stable=dict(out);stable.pop('created_at_epoch',None)
    canonical=json.dumps(stable,sort_keys=True,separators=(',',':')).encode();out['manifest_sha256']=hashlib.sha256(canonical).hexdigest()
    p=ROOT/'release-manifest.json';p.write_text(json.dumps(out,indent=2)+'\n');print(p);print(out['manifest_sha256'])
if __name__=='__main__':main()
