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
            if tool == "__write":  # a file change the model did not make through a tool call
                target = Path(os.environ["NEWSROOM_ARTIFACT_DIR"]) / args["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(args["text"])
                continue
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
RESERVE = 2  # plan slots kept for the first run's two possible completion retries

def run_news(args, env_extra, state):
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
    env.update({'NEWSROOM_AGENT': 'pi', 'MOCK_STATE': str(state), 'NEWSROOM_RPC_TOTAL_MS': '8000', 'NEWSROOM_RPC_IDLE_MS': '5000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
    env.update(env_extra)
    p = subprocess.run([binary] + args, env=env, capture_output=True, timeout=60)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')

def scenario(message, plans, switch, first=(), first_args=(), kill=False, plant=None, planted=PLANTED, same_gaps=None):
    """First question, a planted passing verification, then one follow-up. A first question with an explicit tool profile now gets the
    completion-correction retry when that profile requires the chain (ab2f9bf6 and 14b51d1c), so it can take up to three prompts. Its slots in
    the scripted plan list are reserved (RESERVE empty plans after `first`), the prompt counter is moved past them before the follow-up starts,
    and the returned prompts are only the follow-up's: every follow-up assertion counts exactly what it counted before."""
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as state:
        state = Path(state)
        reserve = RESERVE if first_args else 0
        env = {'MOCK_PLANS': json.dumps([list(first)] + [[] for _ in range(reserve)] + plans)}
        code, text = run_news(['investigate', '--pi-bin', str(mock_path), '--out', out, *first_args, 'fixed question'], env, state)
        m = re.search(r'artifact: (\S+)', text)
        assert m, text[-600:]
        first_prompts = len((state / 'prompts.jsonl').read_text().splitlines())
        assert 1 <= first_prompts <= 1 + reserve, first_prompts
        (state / 'count').write_text(str(1 + reserve))  # the follow-up reads its own plans, whatever the first run used
        artifact = Path(m.group(1))
        (artifact / 'verification.json').write_text(planted)
        if plant: plant(artifact)
        extra = dict(env)
        if switch is not None: extra['NEWSROOM_FOLLOWUP_COMPLETION_GATE'] = switch
        if same_gaps is not None: extra['NEWSROOM_SPEED_COMPLETION_SAME_GAPS'] = same_gaps
        if kill:
            # Kill the follow-up while the model is still working on it.
            env2 = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
            env2.update({'NEWSROOM_AGENT': 'pi', 'MOCK_STATE': str(state), 'NEWSROOM_RPC_TOTAL_MS': '60000', 'NEWSROOM_RPC_IDLE_MS': '60000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
            env2.update(extra)
            proc = subprocess.Popen([binary, 'continue', str(artifact), '--pi-bin', str(mock_path), message], env=env2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            import time
            started = False
            for _ in range(200):
                if (state / 'count').read_text().strip() == str(2 + reserve):
                    started = True
                    break
                time.sleep(0.05)
            assert started, 'the follow-up never reached the model, so killing it proves nothing'
            time.sleep(0.3)
            proc.kill(); proc.wait()
            subprocess.run(['pkill', '-f', str(mock_path)])
            return dict(ver=json.loads((artifact / 'verification.json').read_text()),
                        rounds=sorted(p.name for p in (artifact / 'verification-rounds').glob('*.json')) if (artifact / 'verification-rounds').exists() else [])
        code, text = run_news(['continue', str(artifact), '--pi-bin', str(mock_path), message], extra, state)
        prompts = [json.loads(l) for l in (state / 'prompts.jsonl').read_text().splitlines()]
        texts = [json.dumps(p) for p in prompts[first_prompts:]]
        ver = json.loads((artifact / 'verification.json').read_text())
        rounds = sorted(p.name for p in (artifact / 'verification-rounds').glob('*.json')) if (artifact / 'verification-rounds').exists() else []
        kept = (artifact / 'verification-rounds' / 'round-1.json').read_text() if 'round-1.json' in rounds else None
        reuse = sorted(p.name for p in (artifact / 'verification-rounds').glob('chain-reuse-*.json')) if (artifact / 'verification-rounds').exists() else []
        reuse_rec = json.loads((artifact / 'verification-rounds' / reuse[0]).read_text()) if reuse else None
        events = [json.loads(l) for l in (artifact / 'events.jsonl').read_text().splitlines() if l.strip()] if (artifact / 'events.jsonl').exists() else []
        skips = [e for e in events if e.get('type') == 'completion_retry_skipped']
        return dict(first_prompts=first_prompts, code=code, text=text, skips=skips, prompts=texts, ver=ver, rounds=[r for r in rounds if r.startswith('round-')], kept=kept, reuse=reuse, reuse_rec=reuse_rec)

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
# the first visual-story run is itself sent back twice (its scripted rounds are empty, so its chain is unfinished): the retry happens
assert r['first_prompts'] == 3, r['first_prompts']
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

# G. text-only follow-ups carry over the previous round's verified chart chain (switch on). The first question is a visual-story
# run that called all 7 tools; the program's own records are planted: a PASS browser QA bound to the page, a plan, a chart file.
import hashlib
HTML = '<html>page</html>'
CHAIN2 = [[t, ({'plan_ref': 'infographics/plans/p.json'} if t == 'newsroom_infographic_render' else {}), True] for t, _, _ in CHAIN]
def plant(artifact):
    for rel, text in [('infographics/plans/p.json', json.dumps({'modules': [{'visual_grammar': 'trend'}]})), ('infographics/a.svg', '<svg id="a"/>'),
                      ('publications/p1/index.html', HTML), ('publications/p1/manifest.json', json.dumps({'html_ref': 'publications/p1/index.html'})),
                      ('publications/qa/p1/browser-qa.json', json.dumps({'status': 'PASS', 'html_sha256': hashlib.sha256(HTML.encode()).hexdigest()}))]:
        (artifact / rel).parent.mkdir(parents=True, exist_ok=True)
        (artifact / rel).write_text(text)
def reuse_run(message, plans, planted=PLANTED, switch='1', same_gaps=None):
    return scenario(message, plans, switch, first=CHAIN2, first_args=VS, plant=plant, planted=planted, same_gaps=same_gaps)
# (a) a follow-up that only explains: no tool call, no retry, no gap; the record names the round and the file digest.
r = reuse_run('explain the first chart once more', [[]])
assert len(r['prompts']) == 1 and 'System completion gate' not in r['prompts'][0], [p[:120] for p in r['prompts']]
assert 'visual delivery incomplete' not in r['text'], r['text'][-500:]
assert r['reuse'] == ['chain-reuse-of-round-1.json'] and r['reuse_rec']['reused_round_file'] == 'verification-rounds/round-1.json', r['reuse']
assert re.fullmatch(r'[0-9a-f]{64}', r['reuse_rec']['chain_fingerprint_sha256']) and r['reuse_rec']['fingerprint_files'] == 5, r['reuse_rec']
# off: the same follow-up is not judged against earlier rounds (one prompt, nothing recorded); the gap is computed only with the switch
r = reuse_run('explain the first chart once more', [[]], switch=None)
assert r['reuse'] == [] and len(r['prompts']) == 1, (r['reuse'], r['prompts'])
# (b) one byte of a chain file changes during the round (not through a tool call): the whole chain is required again.
r = reuse_run('explain the first chart once more', [[['__write', {'path': 'infographics/a.svg', 'text': '<svg id="b"/>'}, True]], [], []])
assert len(r['prompts']) == 3 and 'required complex-visual gate did not pass: newsroom_infographic_plan' in r['prompts'][1], [p[:120] for p in r['prompts']]
assert r['reuse'] == [], r['reuse']
# a file added or removed counts as well
r = reuse_run('explain the first chart once more', [[['__write', {'path': 'publications/p1/extra.png', 'text': 'x'}, True]], [], []])
assert len(r['prompts']) == 3 and r['reuse'] == [], [p[:120] for p in r['prompts']]
# (c) the previous round is not a finished pass: a plain failed record, or a not_verified marker even with passed true.
for label, record in [('passed false', '{"passed": false}\n'), ('not_verified marker', '{"passed": true, "round_status": "not_verified"}\n'),
                      ('in_progress marker', '{"passed": true, "round_status": "in_progress"}\n'), ('unreadable', 'not json\n')]:
    r = reuse_run('explain the first chart once more', [[], [], []], planted=record)
    assert len(r['prompts']) == 3 and r['reuse'] == [], (label, [p[:120] for p in r['prompts']])
# (d) the follow-up calls a chart-chain tool: the chain is required in full again, whatever the files look like.
for tool in ['newsroom_infographic_render', 'newsroom_viz_critic', 'newsroom_publication_qa']:
    r = reuse_run('explain the first chart once more', [[[tool, {}, True]], [], []])
    assert len(r['prompts']) == 3 and r['reuse'] == [], (tool, [p[:120] for p in r['prompts']])
# (e) the follow-up asks for a form the rendered plan does not have: a gap, and the retry loop runs.
r = reuse_run('now add a world map of the same numbers', [[], [], []])
assert len(r['prompts']) == 3 and 'spatial' in r['prompts'][1] and 'required complex-visual gate did not pass' not in r['prompts'][1], [p[:200] for p in r['prompts']]
# H. NEWSROOM_SPEED_COMPLETION_SAME_GAPS (exact "1"), K349 ON variants. Every OFF assertion above is unchanged. On the text-only cases the second
# completion attempt is not sent (same gaps, no tool call in the first attempt): exactly 2 prompts, one completion_retry_skipped event, and the same
# failure text, exit code and verification status as off.
def same_failure(on, off):
    assert on['code'] == off['code'] and on['code'] != 0, (on['code'], off['code'])
    assert 'visual delivery incomplete' in on['text'] and 'visual delivery incomplete' in off['text']
    strip = lambda v: {k: x for k, x in v.items() if k != 'verified_at'}  # the only field that is a clock reading
    assert strip(on['ver']) == strip(off['ver']), (on['ver'], off['ver'])
    assert on['ver']['passed'] is False and on['ver']['round_status'] == 'not_verified' and on['ver']['stage'] == 'completion_gate', on['ver']
for label, off, on in [
    ('complex text-only follow-up', scenario(COMPLEX, [[], [], []], '1'), scenario(COMPLEX, [[], [], []], '1', same_gaps='1')),
    ('world-map follow-up after a verified chain', reuse_run('now add a world map of the same numbers', [[], [], []]),
     reuse_run('now add a world map of the same numbers', [[], [], []], same_gaps='1')),
]:
    assert len(off['prompts']) == 3 and off['skips'] == [], (label, len(off['prompts']), off['skips'])
    assert len(on['prompts']) == 2, (label, [p[:80] for p in on['prompts']])
    assert 'System completion gate attempt 1/2 found unfinished required work' in on['prompts'][1], label
    assert not any('attempt 2/2' in p for p in on['prompts']), label
    assert len(on['skips']) == 1 and on['skips'][0]['attempt'] == 2 and on['skips'][0]['reason'] == 'same_gaps_no_tool_call' and on['skips'][0]['gaps'], (label, on['skips'])
    same_failure(on, off)
# a tool call in the first attempt: the second attempt is sent, nothing skipped, exactly as off
r = scenario(COMPLEX, [chart, chart, chart], '1', same_gaps='1')
assert len(r['prompts']) == 3 and r['skips'] == [], (len(r['prompts']), r['skips'])
assert 'System completion gate attempt 2/2 found unfinished required work' in r['prompts'][2]
# the follow-up gate itself off: the new switch changes nothing
r = scenario(COMPLEX, [[], [], []], None, same_gaps='1')
assert len(r['prompts']) == 1 and r['skips'] == [] and r['rounds'] == [], (r['prompts'], r['skips'], r['rounds'])
# values that are not exactly "1" are off: three prompts, no skip
for value in ['0', 'true', 'yes', '', ' 1', '01']:
    r = scenario(COMPLEX, [[], [], []], '1', same_gaps=value)
    assert len(r['prompts']) == 3 and r['skips'] == [], (value, len(r['prompts']), r['skips'])
print('test_followup_completion_gate: ok')
