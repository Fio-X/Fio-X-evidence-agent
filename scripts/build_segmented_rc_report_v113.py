#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def load(rel):
    p=ROOT/rel
    try:return json.loads(p.read_text())
    except Exception:return None
checks={}
pr=load('outputs/v113-release-check-pr.json'); checks['pr_gate']=bool(pr and pr.get('status')=='PASS')
log=(ROOT/'outputs/v113-smoke.log').read_text() if (ROOT/'outputs/v113-smoke.log').is_file() else ''
for name,marker in {
 'runtime_foundation':'runtime foundation v1.16 PASS',
 'semantic_adversarial':'editorial semantics adversarial v1.7 PASS',
 'visual_synthesis':'v1.8 visual synthesis qualification: PASS',
 'backend_router':'backend router v1.23 PASS',
 'ai_visual_compiler':'AI visual compiler v1.15 PASS',
}.items(): checks[name]=marker in log
for name,rel,expected in [
 ('v19_energy','outputs/v19-browser/energy-qa/browser-qa.json','PASS'),
 ('v19_network','outputs/v19-browser/network-qa/browser-qa.json','PASS'),
 ('v19_advanced','outputs/v19-browser/advanced-qa/browser-qa.json','PASS'),
 ('v19_d3_fail_closed','outputs/v19-browser/d3-unqualified-qa/browser-qa.json','FAIL'),
 ('v19_webgl_fail_closed','outputs/v19-browser/webgl-unqualified-qa/browser-qa.json','FAIL'),
 ('v110_nature','outputs/v110-nature-map/qa/browser-qa.json','PASS'),
 ('v110_uncertainty','outputs/v110-systems/uncertainty-qa/browser-qa.json','PASS'),
 ('v110_linked_geo','outputs/v110-systems/linked-geo-qa/browser-qa.json','PASS'),
 ('v110_large_network_technical','outputs/v110-systems/large-network-qa/browser-qa.json','PASS'),
 ('v113_cpu','outputs/v113-browser/cpu/browser-qa.json','PASS'),
 ('v113_gpu_expected_block','outputs/v113-browser/gpu/browser-qa.json','FAIL'),
]:
    r=load(rel);checks[name]=bool(r and r.get('status')==expected)
# Validate expected failure reasons rather than accepting arbitrary FAIL.
d3=load('outputs/v19-browser/d3-unqualified-qa/browser-qa.json') or {}; checks['v19_d3_reason']=any(str(x).startswith('blocked_modules:') for x in d3.get('errors',[]))
wg=load('outputs/v19-browser/webgl-unqualified-qa/browser-qa.json') or {}; checks['v19_webgl_reason']=any(str(x).startswith('webgl_unavailable:') for x in wg.get('errors',[]))
gpu=load('outputs/v113-browser/gpu/browser-qa.json') or {}; checks['v113_gpu_reason']=any(str(x).startswith('webgl2_unavailable:') for x in gpu.get('errors',[]))
q=load('outputs/v110-systems/qualification-summary.json') or {}; checks['large_network_editorial_fail_closed']=q.get('large_network',{}).get('editorial_verdict')=='FAIL_HAIRBALL_SPECIALIST_REQUIRED'
status='PASS_SEGMENTED' if all(checks.values()) else 'FAIL'
out={'schema_version':'0.1.0','release':'1.13.0-rc1','status':status,'note':'Host-constrained segmented evidence. Standard release hosts must still run the monolithic rc profile.','checks':checks,'monolithic_smoke':'TIMEOUT_HOST_LIMIT'}
p=ROOT/'outputs/v113-rc-segmented.json';p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2));raise SystemExit(0 if status=='PASS_SEGMENTED' else 2)
