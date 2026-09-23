#!/usr/bin/env python3
from __future__ import annotations
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
errors=[]
host=json.loads((ROOT/'config/production-host.json').read_text())
if host.get('release')!='1.13.0-rc1':errors.append('production host release mismatch')
if host.get('cold_story_gate',{}).get('minimum_cases')!=12:errors.append('cold-story minimum must remain 12')
profiles=json.loads((ROOT/'config/release-profiles.json').read_text())
final=profiles['profiles']['final']
required_commands=[
    'python3 scripts/verify_dependency_locks.py',
    'python3 scripts/production_preflight.py --output outputs/v113-production-preflight.json',
    'python3 scripts/check_cold_story_ledger.py --output outputs/v113-cold-story-gate.json',
    'python3 scripts/agentic_trials.py --trials 3 --out .newsroom/agentic-trials',
    'bash scripts/integration_qualification.sh',
]
for cmd in required_commands:
    if cmd not in final.get('commands',[]):errors.append('final profile missing '+cmd)
if 'bash scripts/agentic_qualification.sh' in final.get('commands',[]):errors.append('final profile must not use one-shot agentic qualification')
for rel in host['required_lockfiles']:
    if rel not in final.get('required_files',[]):errors.append('final profile does not require '+rel)

agentic=(ROOT/'scripts/agentic_qualification.sh').read_text()
for forbidden in ['newsroom_story_graph','newsroom_publication_plan','newsroom_publication_render','newsroom_publication_qa','fetch_url on http://127.0.0.1']:
    if forbidden in agentic:errors.append('agentic qualification prescribes implementation detail '+forbidden)
for marker in ['NEWSROOM_FAULT_INJECT_TOOL_ONCE','NEWSROOM_AGENTIC_SCENARIO_ID','evaluate_agentic_artifact.py','--scenario', '--tool-profile investigate']:
    if marker not in agentic:errors.append('agentic qualification missing '+marker)

integration=(ROOT/'scripts/integration_qualification.sh').read_text()
for tool in ['newsroom_story_graph','newsroom_publication_plan','newsroom_publication_render','newsroom_publication_qa']:
    if tool not in integration:errors.append('integration qualification prompt missing '+tool)
writer=(ROOT/'scripts/write_qualification.py').read_text()
for marker in ["'qualification_type':'integration'","'source_commit':git_commit()",'browser_publication_passed','publication_manifest_ok','browser_ok','adaptive_replanning_observed']:
    if marker not in writer:errors.append('integration qualification writer missing '+marker)

finalq=(ROOT/'scripts/final_qualification.py').read_text()
for marker in ["--agentic-reliability","'agentic_reliability':reliability_pass","candidate_source_commit","matched_scenarios"]:
    if marker not in finalq:errors.append('final qualification missing '+marker)

live=(ROOT/'.github/workflows/live-qualification.yml').read_text()
for marker in ['agentic_trials.py --trials 3','.newsroom/agentic-trials']:
    if marker not in live:errors.append('live qualification missing '+marker)
release_gate=(ROOT/'.github/workflows/release-gate.yml').read_text()
if '.newsroom/agentic-trials' not in release_gate:errors.append('release gate does not retain repeated agentic evidence')
for marker in ['scipy==1.18.1','geopandas==1.1.2','shapely==2.1.2','pyproj==3.7.2','pyogrio==0.12.1']:
    if marker not in release_gate:errors.append('release gate qualification dependencies missing '+marker)
for marker in ['Expose qualified Chromium on PATH','p.chromium.executable_path','newsroom-bin/chromium','GITHUB_PATH']:
    if marker not in release_gate:errors.append('release gate browser runtime exposure missing '+marker)
full_release=(ROOT/'.github/workflows/full-release-qualification.yml').read_text()
for job in ['integration','browser-capability']:
    if f'  {job}:\n    needs: macos-locked-and-local\n' in full_release:errors.append('full release '+job+' must run independently of macos locked gate')
business=(ROOT/'scripts/business_value_benchmark.py').read_text()
for marker in ['scenario_id','matched_scenarios','scenario_run_counts','candidate_source_commit','source_commit','sha256_file']:
    if marker not in business:errors.append('business benchmark missing '+marker)

registry=json.loads((ROOT/'config/tool-registry.json').read_text())
registry_names=[row['name'] for row in registry['tools']]
ext=(ROOT/'runtime/pi/newsroom.ts').read_text(); generated=(ROOT/'src/tool_registry.rs').read_text()
regs=re.findall(r'registerScopedTool\s*\(\s*pi\s*,\s*\{\s*name:\s*"([^"]+)"',ext,re.S)
m=re.search(r'pub const NEWSROOM_TOOLS: &str = "([^"]+)"',generated)
allow=m.group(1).split(',') if m else []
if regs!=registry_names or allow!=registry_names:errors.append('canonical/generated/runtime tool surface drift')
out={'schema_version':'0.3.0','status':'PASS' if not errors else 'FAIL','errors':errors,'registered_tools':len(regs),'final_commands':len(final.get('commands',[]))}
print(json.dumps(out,indent=2));raise SystemExit(0 if not errors else 2)
