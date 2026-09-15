#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,os,re,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def cmd_version(name,cmd):
    path=shutil.which(cmd[0]); out={'name':name,'path':path,'version':None,'ok':False}
    if not path: out['error']='not found'; return out
    try:
        cp=subprocess.run(cmd,capture_output=True,text=True,timeout=8)
        text=(cp.stdout.strip() or cp.stderr.strip()).splitlines()[0] if (cp.stdout.strip() or cp.stderr.strip()) else ''
        out['version']=text; out['returncode']=cp.returncode; out['ok']=cp.returncode==0
    except Exception as exc: out['error']=str(exc)
    return out

def ver_tuple(text):
    m=re.search(r'v?(\d+)\.(\d+)(?:\.(\d+))?',text or '')
    return tuple(int(x or 0) for x in m.groups()) if m else None

def read_json(path):
    try:return json.loads(path.read_text())
    except Exception:return None

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',default='outputs/v113-production-preflight.json');args=ap.parse_args()
    cfg=json.loads((ROOT/'config/production-host.json').read_text()); rv=cfg['required_versions']
    checks={}
    node=cmd_version('node',['node','--version']); node['ok']=bool(node['ok'] and ver_tuple(node['version']) and ver_tuple(node['version'])>=ver_tuple(rv['node_min'])); checks['node']=node
    rust=cmd_version('rustc',['rustc','--version']); rust['ok']=bool(rust['ok'] and rv['rust_exact'] in (rust['version'] or '')); checks['rustc']=rust
    cargo=cmd_version('cargo',['cargo','--version']); checks['cargo']=cargo
    duck=cmd_version('duckdb',['duckdb','--version']); duck['ok']=bool(duck['ok'] and rv['duckdb_exact'] in (duck['version'] or '')); checks['duckdb']=duck
    pi=cmd_version('pi',[os.environ.get('NEWSROOM_PI_BIN','pi'),'--version']); pi['ok']=bool(pi['ok'] and rv['pi_exact'] in (pi['version'] or '')); checks['pi']=pi
    py=cmd_version('python',['python3','--version']); py['ok']=bool(py['ok'] and (py['version'] or '').startswith('Python '+rv['python_major_minor'])); checks['python']=py
    chromium=cmd_version('chromium',[os.environ.get('CHROMIUM_BIN','chromium'),'--version']); checks['chromium']=chromium
    locks=[]
    for rel in cfg['required_lockfiles']:
        p=ROOT/rel; locks.append({'path':rel,'present':p.is_file(),'bytes':p.stat().st_size if p.is_file() else 0})
    credentials=[n for n in ['OPENAI_API_KEY','ANTHROPIC_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','ZAI_API_KEY','ZHIPUAI_API_KEY'] if os.environ.get(n)]
    pi_auth=(Path.home()/'.pi/agent/auth.json').is_file()
    cpu_report=read_json(ROOT/'outputs/v113-browser/cpu/browser-qa.json')
    gpu_report=read_json(ROOT/'outputs/v113-browser/gpu/browser-qa.json')
    browser={
      'cpu':{'present':bool(cpu_report),'passed':bool(cpu_report and cpu_report.get('status')=='PASS' and cpu_report.get('security',{}).get('sandbox') is True and not cpu_report.get('external_requests'))},
      'gpu':{'present':bool(gpu_report),'passed':bool(gpu_report and gpu_report.get('status')=='PASS' and gpu_report.get('security',{}).get('sandbox') is True and not gpu_report.get('external_requests')),'errors':(gpu_report or {}).get('errors',[])},
    }
    machine_checks={
      'node':checks['node']['ok'],'rustc':checks['rustc']['ok'],'cargo':checks['cargo']['ok'],'duckdb':checks['duckdb']['ok'],'pi':checks['pi']['ok'],'python':checks['python']['ok'],'chromium':checks['chromium']['ok'],
      'all_lockfiles':all(x['present'] for x in locks),'cpu_browser':browser['cpu']['passed'],'gpu_browser':browser['gpu']['passed'],
      'provider_credential':bool(credentials) or pi_auth,
    }
    blockers=[k for k,v in machine_checks.items() if not v]
    out={'schema_version':'0.1.0','release':cfg['release'],'status':'PASS' if not blockers else 'BLOCKED','machine_checks':machine_checks,'blockers':blockers,'versions':checks,'lockfiles':locks,'browser':browser,'credentials':{'available':bool(credentials) or pi_auth,'env_names':credentials,'pi_auth_present':pi_auth}}
    p=ROOT/args.output;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2));raise SystemExit(0 if out['status']=='PASS' else 2)
if __name__=='__main__':main()
