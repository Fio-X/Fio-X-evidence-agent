#!/usr/bin/env python3
"""Summarize every retained attempt; keep small-n min/median/max, never P95."""
import datetime, json, re, statistics, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'perf-results/live'
sys.path.insert(0,str(ROOT/'scripts'))
from verify_artifact import verify
rows=[]
for p in sorted(OUT.glob('*/result.json')):
 d=json.loads(p.read_text());d['path']=str(p.parent.relative_to(ROOT))
 stderr=(p.parent/'stderr.log').read_text()
 d['phase_metrics']={key:(int(value) if value.isdigit() else None) for key,value in re.findall(r'(startup_ms|runtime_initialization_ms|rpc_ms|first_model_text_ms|persistence_ms|end_to_end_ms|tokens_input|tokens_output|tokens_cache_read|tokens_cache_write)=([0-9]+|N/A)',stderr)}
 d['network']=[]
 np=p.parent/'network.jsonl'
 if np.exists():d['network']=[json.loads(l) for l in np.read_text().splitlines()]
 d['evidence']=[]
 for artifact in (p.parent/'artifacts').glob('*'):
  if not artifact.is_dir():continue
  v=verify(artifact)
  events=[]
  ep=artifact/'events.jsonl'
  if ep.exists():
   for line in ep.read_text().splitlines():
    try:events.append(json.loads(line))
    except ValueError:pass
  tool_starts={};tool_ms=[];retry_start=None;retry_ms=[]
  for event in events:
   stamp=event.get('_newsroom_recorded_at')
   if not stamp:continue
   now=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()*1000
   if event.get('type')=='tool_execution_start':tool_starts[event.get('toolCallId')]=now
   if event.get('type')=='tool_execution_end' and event.get('toolCallId') in tool_starts:tool_ms.append(now-tool_starts.pop(event.get('toolCallId')))
   if event.get('type')=='auto_retry_start':retry_start=now
   if event.get('type')=='auto_retry_end' and retry_start is not None:retry_ms.append(now-retry_start);retry_start=None
  d['tool_wait_sum_ms']=sum(tool_ms);d['tool_wait_samples_ms']=tool_ms
  d['retry_wait_sum_ms']=sum(retry_ms) if retry_start is None else None
  stats=artifact/'session-stats.json'
  if stats.exists():d['session_stats']=json.loads(stats.read_text())
  d['evidence'].append({'artifact':str(artifact.relative_to(ROOT)),'verified':v.passed,'checks':v.checks,'error_count':len(v.errors),'tool_starts':sum(e.get('type')=='tool_execution_start' for e in events),'retry_starts':sum(e.get('type')=='auto_retry_start' for e in events),'source_files':len(list((artifact/'sources').glob('*'))),'computation_files':len(list((artifact/'computations').glob('*.json'))),'verification_errors':v.errors})
 rows.append(d)
groups={}
labels = sorted({str(r.get('label')) for r in rows if r.get('label')})
for label in labels:
 for case in ['qa','csv','web']:
  selected=[r for r in rows if r['label']==label and r['case']==case and not r['path'].split('/')[-1].startswith('sandbox-')]
  if not selected:continue
  def summary(key):
   vals=[r[key] for r in selected if r.get(key) is not None]
   return {'median':statistics.median(vals),'min':min(vals),'max':max(vals)} if vals else None
  groups[f'{label}-{case}']={'n':len(selected),'process_successes':sum(r['returncode']==0 for r in selected),'correct_qa':sum(r.get('qa_correct') is True for r in selected),'verified_artifacts':sum(e['verified'] for r in selected for e in r['evidence']),'wall_ms':summary('wall_ms'),'first_visible_progress_ms':summary('first_visible_progress_ms'),'first_model_text_ms':summary('first_model_text_ms')}
(ROOT/'perf-results/live-summary.json').write_text(json.dumps({'groups':groups,'samples':rows,'notes':['cost unavailable','collector timestamps use up to 200ms select polling; first-output timings should not be compared at sub-200ms precision','model/API time and downstream stream/finalization wait cannot be separated from headers timing alone','baseline QA tokens unavailable: original ask discards stats; optimized prints numeric token stats']},indent=2)+'\n')
print(json.dumps(groups,indent=2))
