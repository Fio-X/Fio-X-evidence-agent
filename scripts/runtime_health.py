#!/usr/bin/env python3
from __future__ import annotations
import argparse, importlib, importlib.metadata, json, re, shutil, subprocess
from pathlib import Path
from packaging.specifiers import SpecifierSet
from packaging.version import Version, InvalidVersion

ROOT=Path(__file__).resolve().parents[1]

def extract_version(text):
    if text is None: return None
    m=re.search(r'(?<!\d)(\d+(?:\.\d+){1,3})(?!\d)',str(text))
    return m.group(1) if m else None

def version_ok(version,spec):
    if not spec: return True
    if not version: return False
    try: return Version(str(version)) in SpecifierSet(str(spec))
    except (InvalidVersion, ValueError): return False

def py_probe(name):
    try:
        mod=importlib.import_module(name)
        raw=getattr(mod,'__version__',None) or getattr(mod,'VERSION',None)
        if raw is None:
            try: raw=importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError: raw=None
        return True, str(raw) if raw is not None else None
    except Exception as e: return False, f'{type(e).__name__}: {e}'

def cmd_probe(name,args=None):
    p=shutil.which(name)
    if not p: return False,None,None
    if args is None: return True,p,None
    r=subprocess.run([p,*args],capture_output=True,text=True,timeout=8)
    text='\n'.join(x for x in [r.stdout.strip(),r.stderr.strip()] if x)
    return r.returncode==0,p,extract_version(text)

def r_probe(name):
    if not shutil.which('Rscript'): return False,'Rscript missing'
    expr=f'if (!requireNamespace("{name}", quietly=TRUE)) quit(status=2); cat(as.character(packageVersion("{name}")))'
    p=subprocess.run(['Rscript','-e',expr],capture_output=True,text=True,timeout=15)
    return p.returncode==0,(p.stdout.strip() or p.stderr.strip())[-300:]

def node_probe(name):
    pkg=ROOT/'runtime'/'web'/'node_modules'/name/'package.json'
    if name.startswith('@'):
        scope,sub=name.split('/',1); pkg=ROOT/'runtime'/'web'/'node_modules'/scope/sub/'package.json'
    if not pkg.exists(): return False,'node_modules package missing'
    try: return True,json.loads(pkg.read_text()).get('version')
    except Exception as e: return False,str(e)

def run():
    result={'schema_version':'1.1.0','runtimes':{}}
    for mp in sorted((ROOT/'runtimes').glob('*/manifest.json')):
        m=json.loads(mp.read_text()); details=[]; ok=True
        for probe in m['probes']:
            typ,name=probe['type'],probe['name']; required=probe.get('required',True); spec=probe.get('version_spec')
            if typ=='python_module': passed,info=py_probe(name); version=extract_version(info)
            elif typ=='command': passed,info,version=cmd_probe(name,probe.get('version_args'))
            elif typ=='r_package': passed,info=r_probe(name); version=extract_version(info)
            elif typ=='node_package': passed,info=node_probe(name); version=extract_version(info)
            else: passed,info,version=False,'unknown probe',None
            version_passed=version_ok(version,spec) if passed else False
            effective=passed and (version_passed if spec else True)
            details.append({'type':typ,'name':name,'passed':effective,'detected':info,'version':version,'version_spec':spec,'required':required})
            if required and not effective: ok=False
        result['runtimes'][m['id']]={'status':'AVAILABLE' if ok else 'UNAVAILABLE','capabilities':m['capabilities'],'target_versions':m.get('target_versions',{}),'probes':details}
    return result

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--output'); args=ap.parse_args(); result=run(); text=json.dumps(result,indent=2)+"\n"
    if args.output:
        p=Path(args.output); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text)
    print(text,end='')
if __name__=='__main__': main()
