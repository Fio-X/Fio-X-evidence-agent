#!/usr/bin/env python3
"""NEWSROOM_REPEAT_FAILURE_STOP=1: five identical failures of one tool end a run with one line; off, the run goes on.
A tiny local RPC peer replays scripted tool calls; nothing contacts a model or provider."""
import json, os, subprocess, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else root / 'target/debug/news').resolve())
MOCK = r'''
import json, os, sys
plan = json.loads(os.environ["MOCK_CALLS"])  # [[tool, args, ok], ...]
def emit(**v): print(json.dumps(v), flush=True)
for line in sys.stdin:
    cmd = json.loads(line)["type"]
    if cmd == "prompt":
        emit(type="response", command="prompt", success=True)
        for i, (tool, args, ok) in enumerate(plan):
            emit(type="tool_execution_start", toolName=tool, toolCallId=f"c{i}", args=args)
            end = dict(type="tool_execution_end", toolName=tool, toolCallId=f"c{i}", isError=not ok)
            if not ok: end["result"] = {"content": [{"type": "text", "text": "Alt description must be at least 20 characters\nmore"}]}
            emit(**end)
        emit(type="message_update", assistantMessageEvent={"type": "text_delta", "delta": "mock answer"})
        emit(type="agent_settled")
    elif cmd == "get_last_assistant_text":
        emit(type="response", command=cmd, success=True, data={"text": "mock answer"})
    elif cmd == "get_session_stats":
        emit(type="response", command=cmd, success=True, data={"tokens": {"input": 0, "output": 0}})
'''
tmp_root = Path(tempfile.mkdtemp())
mock_path = tmp_root / 'mock_pi.py'
mock_path.write_text('#!/usr/bin/env python3\n' + MOCK)
mock_path.chmod(0o755)
fail = lambda tool, args: [tool, args, False]
ok = lambda tool, args: [tool, args, True]
def run(calls, switch):
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
    env.update({'MOCK_CALLS': json.dumps(calls), 'NEWSROOM_RPC_TOTAL_MS': '8000', 'NEWSROOM_RPC_IDLE_MS': '5000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
    if switch is not None: env['NEWSROOM_REPEAT_FAILURE_STOP'] = switch
    with tempfile.TemporaryDirectory() as out:
        p = subprocess.run([binary, 'investigate', '--pi-bin', str(mock_path), '--out', out, 'fixed'], env=env, capture_output=True, timeout=30)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')
STOP = 'stopped: newsroom_viz_plan failed 5 times in a row with the same arguments (Alt description must be at least 20 characters)'
same = [fail('newsroom_viz_plan', {'b': 1, 'a': 2})] * 5
cases = [
    ('five identical, switch on, stops', same, '1', True),
    ('five identical, switch off, goes on', same, None, False),
    ('five identical, switch 0 / true / 01 / " 1", goes on', same, '0', False),
    ('four identical, switch on, goes on', same[:4], '1', False),
    ('five, one argument changed each time, goes on', [fail('newsroom_viz_plan', {'a': i}) for i in range(5)], '1', False),
    ('four, a success, four, goes on', same[:4] + [ok('newsroom_viz_plan', {'b': 1, 'a': 2})] + same[:4], '1', False),
]
for name, calls, switch, stops in cases:
    code, text = run(calls, switch)
    if stops:
        assert code != 0 and STOP in text and '[agent] phase=complete' not in text, (name, code, text[-800:])
        assert text.count('failed 5 times in a row') == 1, (name, text[-800:])
    else:
        assert 'failed 5 times in a row' not in text, (name, text[-800:])
        assert '[agent] phase=complete' in text, (name, code, text[-800:])  # the mock run finished (the exit code is the usual unverified one)
for value in ['true', '01', ' 1', '']:
    code, text = run(same, value)
    assert 'failed 5 times in a row' not in text and '[agent] phase=complete' in text, (value, code, text[-400:])
print('test_repeat_failure_stop: ok')
