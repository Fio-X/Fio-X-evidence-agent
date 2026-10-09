#!/usr/bin/env python3
"""NEWSROOM_SPEED_PLAN_PROGRESS offline (mock Pi, no provider): on, plan-progress.json has one line per
tool_execution_end event, same call ids and tool names in order, and the CLI writes no plan.json; off, no file."""
import json, os, pathlib, subprocess, sys, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
binary = sys.argv[1] if len(sys.argv) > 1 else str(root / 'target/release/news')
for on in (False, True):
    with tempfile.TemporaryDirectory() as t:
        env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_SPEED_')}
        env.update(PERF_MOCK_MODE='compose_chart', PERF_MOCK_AFTER_CHART='0', PERF_MOCK_ABORT_FILE=t + '/a', NEWSROOM_RPC_TOTAL_MS='12000')
        if on:
            env['NEWSROOM_SPEED_PLAN_PROGRESS'] = '1'
        subprocess.run([binary, 'investigate', '--pi-bin', str(root / 'scripts/perf_mock_pi.py'), '--out', t + '/o', 'Draw a chart of the rate'], env=env, capture_output=True, timeout=30)
        art = next(pathlib.Path(t, 'o').iterdir())
        ev = [json.loads(l) for l in (art / 'events.jsonl').read_text().splitlines() if l]
        ids = [(e['toolCallId'], e['toolName']) for e in ev if e.get('type') == 'tool_execution_end']
        f = art / 'plan-progress.json'
        got = [(l['tool_call_id'], l['tool']) for l in map(json.loads, f.read_text().splitlines())] if f.exists() else []
        assert not (art / 'plan.json').exists()
        assert (got == ids and ids) if on else not f.exists(), (on, got, ids)
print(json.dumps({'status': 'PASS', 'mock': True}))
