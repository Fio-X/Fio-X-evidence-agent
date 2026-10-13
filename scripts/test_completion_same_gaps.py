#!/usr/bin/env python3
"""NEWSROOM_SPEED_COMPLETION_SAME_GAPS=1: the second completion attempt is not sent when the gaps are the same as before the
first attempt and the model made no tool call in it. The first attempt is always sent. Off (anything but exactly "1"), nothing
changes. First run (`news investigate`) and follow-up (`news continue` with NEWSROOM_FOLLOWUP_COMPLETION_GATE=1) are both run
against a tiny local RPC peer that replays scripted rounds; the number of prompts it received is the number of model requests.
Nothing contacts a model or provider.  usage: test_completion_same_gaps.py [path/to/news]"""
import json, os, re, subprocess, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else root / 'target/debug/news').resolve())
MOCK = r'''
import json, os, sys
from pathlib import Path
state = Path(os.environ["MOCK_STATE"])
plans = json.loads(os.environ["MOCK_PLANS"])  # one entry per prompt: [[tool, args, ok], ...]
def emit(**v): print(json.dumps(v), flush=True)
for line in sys.stdin:
    cmd = json.loads(line)
    kind = cmd["type"]
    if kind == "prompt":
        n = int((state / "count").read_text()) if (state / "count").exists() else 0
        (state / "count").write_text(str(n + 1))
        with open(state / "prompts.jsonl", "a") as f: f.write(json.dumps(cmd) + "\n")
        plan = plans[n] if n < len(plans) else []
        emit(type="response", command="prompt", success=True)
        for i, (tool, args, ok) in enumerate(plan):
            emit(type="tool_execution_start", toolName=tool, toolCallId=f"c{n}-{i}", args=args)
            emit(type="tool_execution_end", toolName=tool, toolCallId=f"c{n}-{i}", isError=not ok)
        emit(type="message_update", assistantMessageEvent={"type": "text_delta", "delta": f"mock answer {n}"})
        emit(type="agent_settled")
    elif kind == "get_last_assistant_text":
        n = int((state / "count").read_text()) - 1
        emit(type="response", command=kind, success=True, data={"text": f"mock answer {n}"})
    elif kind == "get_session_stats":
        emit(type="response", command=kind, success=True, data={"tokens": {"input": 0, "output": 0}})
'''
tmp_root = Path(tempfile.mkdtemp())
mock_path = tmp_root / 'mock_pi.py'
mock_path.write_text('#!/usr/bin/env python3\n' + MOCK)
mock_path.chmod(0o755)
COMPLEX = '做一张南华早报（SCMP）风格的中文信息长图：一带一路倡议到2017年的进展——哪些国家参与、中国对沿线国家的投资和贸易规模、代表性项目在哪里。要有地图，数字必须来自可核实的数据。'
NOTHING = []                                        # the model answers in text only
CALL = [['newsroom_viz_critic', {'chart': 1}, True]]  # one tool call that does not close the gap
FAILED = [['newsroom_viz_critic', {'chart': 1}, False]]  # a failed call is still a call
SKIP = 'completion_retry_skipped'

def run_news(args, env_extra, state):
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
    env.update({'NEWSROOM_AGENT': 'pi', 'MOCK_STATE': str(state), 'NEWSROOM_RPC_TOTAL_MS': '8000', 'NEWSROOM_RPC_IDLE_MS': '5000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
    env.update(env_extra)
    p = subprocess.run([binary] + args, env=env, capture_output=True, timeout=60)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')

def facts(artifact, state, code, text, first_prompts):
    prompts = (state / 'prompts.jsonl').read_text().splitlines()
    events = [json.loads(l) for l in (artifact / 'events.jsonl').read_text().splitlines() if l.strip()]
    story = json.loads((artifact / 'story.json').read_text())
    tools = json.loads((artifact / 'tools.json').read_text())
    return dict(code=code, text=text, sent=len(prompts) - first_prompts, types=[e.get('type') for e in events],
                skips=[e for e in events if e.get('type') == SKIP],
                gate_retries=[e for e in events if e.get('type') == 'auto_retry_start' and e.get('reason') == 'visual_completion_gate'],
                status=story['status'], story_retries=story['autonomy']['automatic_retries'], tools_retries=tools['automatic_retries'],
                answer=(artifact / 'answer.md').read_text())

def first_run(plans, switch):
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as state:
        state = Path(state)
        env = {'MOCK_PLANS': json.dumps(plans)}
        if switch is not None: env['NEWSROOM_SPEED_COMPLETION_SAME_GAPS'] = switch
        code, text = run_news(['investigate', '--pi-bin', str(mock_path), '--out', out, COMPLEX], env, state)
        m = re.search(r'artifact: (\S+)', text)
        assert m, text[-600:]
        return facts(Path(m.group(1)), state, code, text, 0)

def follow_up(plans, switch):
    """A simple first question, then a complex follow-up with the follow-up completion gate on."""
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as state:
        state = Path(state)
        env = {'MOCK_PLANS': json.dumps([[]] + plans)}
        code, text = run_news(['investigate', '--pi-bin', str(mock_path), '--out', out, 'fixed question'], env, state)
        m = re.search(r'artifact: (\S+)', text)
        assert m, text[-600:]
        artifact = Path(m.group(1))
        (artifact / 'verification.json').write_text('{"passed": true}\n')
        extra = dict(env, NEWSROOM_FOLLOWUP_COMPLETION_GATE='1')
        if switch is not None: extra['NEWSROOM_SPEED_COMPLETION_SAME_GAPS'] = switch
        code, text = run_news(['continue', str(artifact), '--pi-bin', str(mock_path), COMPLEX], extra, state)
        return facts(artifact, state, code, text, 1)

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        print('   ', detail)
        sys.exit(1)

for label, run in (('first run', first_run), ('follow-up', follow_up)):
    # 1. off: the model is sent back twice, whatever it did; no skip event; the gate failure reads as today.
    base = run([NOTHING, NOTHING, NOTHING], None)
    check(f'{label}: off sends both completion attempts', base['sent'] == 3, base['sent'])
    off_sent = base['sent']
    check(f'{label}: off has no skip event and counts two gate retries', not base['skips'] and len(base['gate_retries']) == 2, (base['skips'], len(base['gate_retries'])))
    check(f'{label}: off fails the delivery as today', base['code'] != 0 and 'visual delivery incomplete' in base['text'], base['text'][-300:])
    for value in ['0', 'true', 'yes', '01', ' 1', '']:
        r = run([NOTHING, NOTHING, NOTHING], value)
        check(f'{label}: value {value!r} is off', r['sent'] == off_sent and r['types'] == base['types'] and r['answer'] == base['answer'] and r['status'] == base['status'] and not r['skips'], (r['sent'], off_sent))
    # 2. on, same gaps, no tool call: attempt 2 is not sent, one skip event, same failure.
    r = run([NOTHING, NOTHING, NOTHING], '1')
    check(f'{label}: on, same gaps and no tool call skips attempt 2', r['sent'] == off_sent - 1, (r['sent'], off_sent))
    check(f'{label}: the skip event names attempt 2, the gaps and the reason', len(r['skips']) == 1 and r['skips'][0]['attempt'] == 2 and r['skips'][0]['gaps'] and r['skips'][0]['reason'] == 'same_gaps_no_tool_call', r['skips'])
    check(f'{label}: only the retry actually sent is counted', len(r['gate_retries']) == 1 and r['story_retries'] == 1 and r['tools_retries'] == 1, (len(r['gate_retries']), r['story_retries'], r['tools_retries']))
    check(f'{label}: the finish is the same as off', r['code'] == base['code'] and r['status'] == base['status'] == 'failed' and 'visual delivery incomplete' in r['text'], (r['code'], r['status']))
    check(f'{label}: the answer is the last reply received', r['answer'].strip() == ('mock answer 1' if label == 'first run' else 'mock answer 2'), r['answer'])
    # 3. on, a tool call in attempt 1 (even a failed one): attempt 2 is sent, no skip event.
    for name, plan in (('a call', CALL), ('a failed call', FAILED)):
        r = run([NOTHING, plan, NOTHING], '1')
        check(f'{label}: on, {name} in attempt 1 sends attempt 2', r['sent'] == off_sent and not r['skips'], (r['sent'], off_sent, r['skips']))

print('completion same gaps: PASS')
