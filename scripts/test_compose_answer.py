#!/usr/bin/env python3
"""NEWSROOM_SPEED_COMPOSE_ANSWER offline: mock Pi (scripts/perf_mock_pi.py), fake key, no provider.
Switch off the run is unchanged; on, a complete chart with a system-verified claim gets a closing text
written from the artifacts and the model's next turn is aborted; every other case keeps the model's text."""
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else root / 'target/release/news').resolve())
MODEL_TEXT = 'mock model closing text'

def run(extra, case='ok', topic='Draw a chart of the rate', after=3.0):
    with tempfile.TemporaryDirectory() as tmp:
        abort = Path(tmp) / 'abort.flag'
        env = {**{k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_SPEED_')},
               'PERF_MOCK_MODE': 'compose_chart', 'PERF_MOCK_COMPOSE_CASE': case, 'PERF_MOCK_AFTER_CHART': str(after),
               'PERF_MOCK_ABORT_FILE': str(abort), 'NEWSROOM_RPC_TOTAL_MS': '12000', 'NEWSROOM_RPC_IDLE_MS': '8000',
               'NEWSROOM_RPC_FINISH_MS': '4000', **extra}
        out_dir = Path(tmp) / 'out'
        t = time.monotonic()
        p = subprocess.run([binary, 'investigate', '--pi-bin', str(root / 'scripts/perf_mock_pi.py'), '--out', str(out_dir), topic],
                           env=env, capture_output=True, timeout=30)
        wall = time.monotonic() - t
        art = next(out_dir.iterdir())
        events = [json.loads(l) for l in (art / 'events.jsonl').read_text(encoding='utf-8').splitlines() if l]
        composed = [e for e in events if e.get('type') == 'newsroom_composed_answer']
        return {'returncode': p.returncode, 'wall': wall, 'aborted': abort.exists(), 'composed': composed,
                'answer': (art / 'answer.md').read_text(encoding='utf-8'), 'stdout': p.stdout.decode(),
                'status': json.loads((art / 'story.json').read_text())['status'],
                'tools': sorted((e.get('type'), e.get('toolName')) for e in events if e.get('type', '').startswith('tool_execution'))}

ON = {'NEWSROOM_SPEED_COMPOSE_ANSWER': '1'}
off = run({})
assert not off['aborted'] and off['composed'] == [] and MODEL_TEXT in off['answer'], off
on = run(ON)
assert on['aborted'] and on['wall'] < off['wall'] - 1.5, (on['wall'], off['wall'])
assert [c['source'] for c in on['composed']] == ['runtime'], on['composed']
for need in ('Rate fell from 40 to 11.2.', 'claim-1', 'status verified', 'Mock source', 'Mock caveat', 'visualizations/b.svg'):
    assert need in on['answer'], (need, on['answer'])
assert MODEL_TEXT not in on['answer'] and MODEL_TEXT not in on['stdout'], on
assert on['answer'].index('Rate fell') < on['answer'].index('not verified by the system') < on['answer'].index('Mock caveat')
# Same exit status, story status and tool events as the run without the switch.
for key in ('returncode', 'status', 'tools'):
    assert on[key] == off[key], (key, on[key], off[key])
fallbacks = {
    'claim not system-verified': run(ON, case='unverified', after=1.0),
    'claim still holds a placeholder': run(ON, case='placeholder', after=1.0),
    'complex visual request': run(ON, topic='Draw a complex visual essay chart', after=1.0),
    'html requested': run(ON, topic='Draw a chart as html', after=1.0),
    'several charts requested': run(ON, topic='Draw several charts of the rate', after=1.0),
    'switch not exactly one': run({'NEWSROOM_SPEED_COMPOSE_ANSWER': 'true'}, after=1.0),
}
for label, r in fallbacks.items():
    assert not r['aborted'] and MODEL_TEXT in r['answer'], (label, r)
    assert [c['source'] for c in r['composed']] == (['model'] if label in ('claim not system-verified', 'claim still holds a placeholder') else []), (label, r['composed'])
print(json.dumps({'off_wall_s': round(off['wall'], 2), 'on_wall_s': round(on['wall'], 2), 'fallbacks': list(fallbacks), 'mock': True}, indent=1))
