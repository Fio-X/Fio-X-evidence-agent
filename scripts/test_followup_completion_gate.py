#!/usr/bin/env python3
"""NEWSROOM_FOLLOWUP_COMPLETION_GATE=1: `news continue` sends the model back when a complex visual follow-up is unfinished
(at most twice, the first question's wording) and records each round's verification apart. Off, behaviour is unchanged.
A tiny local RPC peer replays scripted rounds; nothing contacts a model or provider."""
import json, os, re, subprocess, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else root / 'target/debug/news').resolve())
MOCK = r'''
import json, os, sys
from pathlib import Path
state = Path(os.environ["MOCK_STATE"])
plans = json.loads(os.environ["MOCK_PLANS"])  # one entry per prompt: [[tool, args, ok], ...] or "die"
def emit(**v): print(json.dumps(v), flush=True)
for line in sys.stdin:
    cmd = json.loads(line)
    kind = cmd["type"]
    if kind == "prompt":
        n = int((state / "count").read_text()) if (state / "count").exists() else 0
        (state / "count").write_text(str(n + 1))
        with open(state / "prompts.jsonl", "a") as f: f.write(json.dumps(cmd) + "\n")
        plan = plans[n] if n < len(plans) else []
        if plan == "die": sys.exit(3)
        if plan == "hang":
            import time
            time.sleep(600)
        emit(type="response", command="prompt", success=True)
        for i, (tool, args, ok) in enumerate(plan):
            emit(type="tool_execution_start", toolName=tool, toolCallId=f"c{n}-{i}", args=args)
            emit(type="tool_execution_end", toolName=tool, toolCallId=f"c{n}-{i}", isError=not ok)
        emit(type="message_update", assistantMessageEvent={"type": "text_delta", "delta": "mock answer"})
        emit(type="agent_settled")
    elif kind == "get_last_assistant_text":
        emit(type="response", command=kind, success=True, data={"text": "mock answer"})
    elif kind == "get_session_stats":
        emit(type="response", command=kind, success=True, data={"tokens": {"input": 0, "output": 0}})
'''
tmp_root = Path(tempfile.mkdtemp())
mock_path = tmp_root / 'mock_pi.py'
mock_path.write_text('#!/usr/bin/env python3\n' + MOCK)
mock_path.chmod(0o755)
COMPLEX = '做一张南华早报（SCMP）风格的中文信息长图：一带一路倡议到2017年的进展——哪些国家参与、中国对沿线国家的投资和贸易规模、代表性项目在哪里。要有地图，数字必须来自可核实的数据。'
SIMPLE = 'add one more caveat to the answer'
chart = [['newsroom_viz_critic', {'chart': 1}, True]]
CHAIN = [[t, {}, True] for t in ['newsroom_infographic_plan', 'newsroom_infographic_lint', 'newsroom_infographic_render', 'newsroom_infographic_critic', 'newsroom_publication_plan', 'newsroom_publication_render', 'newsroom_publication_qa']]
PLANTED = '{"passed": true, "marker": "planted-pass"}\n'

def run_news(args, env_extra, state):
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
    env.update({'MOCK_STATE': str(state), 'NEWSROOM_RPC_TOTAL_MS': '8000', 'NEWSROOM_RPC_IDLE_MS': '5000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
    env.update(env_extra)
    p = subprocess.run([binary] + args, env=env, capture_output=True, timeout=60)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')

def scenario(message, plans, switch, first=(), first_args=(), kill=False):
    """First question (simple, one prompt), a planted passing verification, then one follow-up."""
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as state:
        state = Path(state)
        env = {'MOCK_PLANS': json.dumps([list(first)] + plans)}
        code, text = run_news(['investigate', '--pi-bin', str(mock_path), '--out', out, *first_args, 'fixed question'], env, state)
        m = re.search(r'artifact: (\S+)', text)
        assert m, text[-600:]
        artifact = Path(m.group(1))
        (artifact / 'verification.json').write_text(PLANTED)
        extra = dict(env)
        if switch is not None: extra['NEWSROOM_FOLLOWUP_COMPLETION_GATE'] = switch
        if kill:
            # Kill the follow-up while the model is still working on it.
            env2 = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
            env2.update({'MOCK_STATE': str(state), 'NEWSROOM_RPC_TOTAL_MS': '60000', 'NEWSROOM_RPC_IDLE_MS': '60000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
            env2.update(extra)
            proc = subprocess.Popen([binary, 'continue', str(artifact), '--pi-bin', str(mock_path), message], env=env2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            import time
            for _ in range(200):
                if (state / 'count').exists() and (state / 'count').read_text().strip() == '2': break
                time.sleep(0.05)
            time.sleep(0.3)
            proc.kill(); proc.wait()
            subprocess.run(['pkill', '-f', str(mock_path)])
            return dict(ver=json.loads((artifact / 'verification.json').read_text()),
                        rounds=sorted(p.name for p in (artifact / 'verification-rounds').glob('*.json')) if (artifact / 'verification-rounds').exists() else [])
        code, text = run_news(['continue', str(artifact), '--pi-bin', str(mock_path), message], extra, state)
        prompts = [json.loads(l) for l in (state / 'prompts.jsonl').read_text().splitlines()]
        texts = [json.dumps(p) for p in prompts[1:]]
        ver = json.loads((artifact / 'verification.json').read_text())
        rounds = sorted(p.name for p in (artifact / 'verification-rounds').glob('*.json')) if (artifact / 'verification-rounds').exists() else []
        kept = (artifact / 'verification-rounds' / 'round-1.json').read_text() if 'round-1.json' in rounds else None
        return dict(code=code, text=text, prompts=texts, ver=ver, rounds=rounds, kept=kept)

# A. on, complex follow-up that stops after one chart: sent back twice, then the run fails and says so.
r = scenario(COMPLEX, [chart, chart, chart], '1')
assert len(r['prompts']) == 4 - 1, [p[:80] for p in r['prompts']]  # follow-up + two corrections
assert 'System completion gate attempt 1/2 found unfinished required work' in r['prompts'][1], r['prompts'][1][:300]
assert 'System completion gate attempt 2/2 found unfinished required work' in r['prompts'][2]
assert 'required complex-visual gate did not pass: newsroom_infographic_plan' in r['prompts'][1]
assert r['code'] != 0 and 'visual delivery incomplete' in r['text'], (r['code'], r['text'][-500:])
assert r['ver']['passed'] is False and r['ver']['round_status'] == 'not_verified' and r['ver']['stage'] == 'completion_gate', r['ver']
assert r['ver']['previous_round_file'] == 'verification-rounds/round-1.json' and r['kept'] == PLANTED, (r['ver'], r['rounds'])

# A2. The first question already ran the whole chain; the follow-up's gaps still name it, because only this round's calls count.
r = scenario(COMPLEX, [chart, chart, chart], '1', first=CHAIN)
assert 'required complex-visual gate did not pass: newsroom_infographic_plan' in r['prompts'][1], r['prompts'][1][:400]

# B. off, same follow-up: one prompt, nothing recorded apart, the old verification file is replaced as before.
r = scenario(COMPLEX, [chart, chart, chart], None)
assert len(r['prompts']) == 1 and 'System completion gate' not in r['prompts'][0], r['prompts']
assert r['rounds'] == [] and 'marker' not in r['ver'] and 'round_status' not in r['ver'], (r['rounds'], r['ver'])
for value in ['0', 'true', 'yes', '', ' 1', '01']:
    r = scenario(COMPLEX, [chart, chart, chart], value)
    assert len(r['prompts']) == 1 and r['rounds'] == [], (value, r['prompts'], r['rounds'])

# C. on, a follow-up that is not a complex visual request: no correction; the previous verification is still kept.
r = scenario(SIMPLE, [chart], '1')
assert len(r['prompts']) == 1 and 'System completion gate' not in r['prompts'][0], r['prompts']
assert r['rounds'] == ['round-1.json'] and r['kept'] == PLANTED, r['rounds']

# D. the follow-up run itself fails before verification. Off: the previous pass is left in place and reads as current.
# On: the current file says this round is not verified, and the pass is kept apart.
off = scenario(SIMPLE, ['die'], None)
assert off['code'] != 0 and off['ver'].get('marker') == 'planted-pass', off['ver']
on = scenario(SIMPLE, ['die'], '1')
assert on['code'] != 0 and on['ver']['passed'] is False and on['ver']['stage'] == 'run_failed' and 'marker' not in on['ver'], on['ver']
assert on['kept'] == PLANTED and on['ver']['previous_round_file'] == 'verification-rounds/round-1.json', on['rounds']
# E. a visual-story first question, then a short follow-up. The gap calculation counts the recorded profile, so the retry
# loop must too: the model is sent back, with the first question's correction text. Off: one prompt as before.
VS = ['--tool-profile', 'visual-story']
r = scenario(SIMPLE, [chart, chart, chart], '1', first_args=VS)
assert len(r['prompts']) == 3, [p[:80] for p in r['prompts']]
assert 'System completion gate attempt 1/2 found unfinished required work' in r['prompts'][1], r['prompts'][1][:300]
assert 'System completion gate attempt 2/2 found unfinished required work' in r['prompts'][2]
assert r['code'] != 0 and 'visual delivery incomplete' in r['text'], (r['code'], r['text'][-500:])
r = scenario(SIMPLE, [chart, chart, chart], None, first_args=VS)
assert len(r['prompts']) == 1, r['prompts']
r = scenario(SIMPLE, [chart], '1')  # no visual-story profile recorded: still no correction (C again)
assert len(r['prompts']) == 1

# F. the follow-up is killed while the model works: verification.json must not still show the previous round's pass.
# Off: it does (the old behaviour). On: it says this round is in progress, unverified, and the pass is kept apart.
r = scenario(SIMPLE, ['hang'], None, kill=True)
assert r['ver'].get('marker') == 'planted-pass', r['ver']
r = scenario(SIMPLE, ['hang'], '1', kill=True)
assert r['ver']['passed'] is False and r['ver']['round_status'] == 'in_progress' and 'marker' not in r['ver'], r['ver']
assert r['ver']['previous_round_file'] == 'verification-rounds/round-1.json' and r['rounds'] == ['round-1.json'], (r['ver'], r['rounds'])
print('test_followup_completion_gate: ok')
