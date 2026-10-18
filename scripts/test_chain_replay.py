#!/usr/bin/env python3
"""Route A chain replay: the real page tools (node segment) feed the real `news continue` completion gate (Rust segment). No model, no network.
Usage: python3 scripts/test_chain_replay.py <path to news> [groups-on|groups-off] [fp-off|fp-on]   (defaults groups-on, fp-off)

A, node (scripts/test_chain_replay_a.mjs): plan, lint, render, critic and preview run for real on a hand-written fixture with the four group
switches on (or off, in the groups-off variant), preflight on. Three runs are left in a shared temp directory: clean, bad (novelty failed, so
preflight refused the plan and infographics/plans is empty) and off (preflight off, refused by the ordinary check).
B, Rust: `news investigate` then `news continue` against a scripted local RPC peer (MOCK, copied from test_followup_completion_gate.py; change one,
change the other). The Rust side reads the event log's tool calls and the artifact files; it executes no page tool. The only real link between the two
segments is the files: A's infographics/ and visualizations/ are copied into B's run, so B's chain fingerprint and delivery gaps are computed over files
the real tools wrote. The seven tool-call events in B are scripted, as in the existing test, and the publication html, manifest and PASS browser-qa are
hand-written (plant). This does NOT show that the completion gate verified the tools' output.
Exit codes: 0 pass, 0 with "SKIP" printed when duckdb is missing (A cannot run), anything else fail.
Observation (groups-on): A also turns CALL_CHECK on and needs a call-report row for each of the five page tools and 0 undeclared pairs from
scripts/check_cross_call_report.mjs; B runs `news investigate` and `news continue` with CALL_CHECK and HANDOFF_OBSERVE on and needs hand-off rows
(runtime/handoff-observed.jsonl) from both commands with no `unlisted` or `not_owned` decision. Groups-off: no rows at all.
Mutations (do them in a scratch tree, keep nothing): preflight never refusing turns A bad red; a chain fingerprint comparison that is always equal
turns B incomplete/1 red; the hand-off recorder made a no-op (src/group_guard.rs, nothing appended to the observed log) turns B red (no rows);
the call-report writer made a no-op (runtime/pi/newsroom.ts) turns A clean red (no page-tool rows).
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else root / 'target/debug/news').resolve())
GROUPS = sys.argv[2] if len(sys.argv) > 2 else 'groups-on'
assert GROUPS in ('groups-on', 'groups-off'), GROUPS
GV = '1' if GROUPS == 'groups-on' else '0'
FP = len(sys.argv) > 3 and sys.argv[3] == 'fp-on'  # NEWSROOM_CHAIN_FINGERPRINT_AT_PASS=1 for the Rust segment
assert len(sys.argv) <= 3 or sys.argv[3] in ('fp-on', 'fp-off'), sys.argv
GROUP_KEYS = ['NEWSROOM_GROUP_TOOLS', 'NEWSROOM_GROUP_ENFORCE', 'NEWSROOM_GROUP_HANDOFF', 'NEWSROOM_GROUP_CALL_REPORT', 'NEWSROOM_GROUP_CALL_CHECK', 'NEWSROOM_GROUP_HANDOFF_OBSERVE']
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
CHAIN = [[t, {}, True] for t in ['newsroom_infographic_plan', 'newsroom_infographic_lint', 'newsroom_infographic_render', 'newsroom_infographic_critic', 'newsroom_publication_plan', 'newsroom_publication_render', 'newsroom_publication_qa']]
CHAIN2 = [[t, ({'plan_ref': 'infographics/plans/p.json'} if t == 'newsroom_infographic_render' else {}), True] for t, _, _ in CHAIN]
PLANTED = '{"passed": true, "marker": "planted-pass"}\n'
VS = ['--tool-profile', 'visual-story']
RESERVE = 2  # plan slots kept for the first run's two possible completion retries
CHAIN_DIRS = ['infographics', 'publications', 'visualizations']
shared = tmp_root / 'shared'
shared.mkdir()
checks = 0
def ok(cond, msg=''):
    global checks
    assert cond, msg
    checks += 1

# ---- A: node segment -----------------------------------------------------------------------------------------------------------------------------
def run_a(mode):
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_') or k == 'NEWSROOM_DUCKDB_BIN'}
    p = subprocess.run(['node', str(root / 'scripts/test_chain_replay_a.mjs'), str(shared), mode, GV], env=env, capture_output=True, timeout=300, cwd=root)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')
for mode in ('clean', 'bad', 'off'):
    code, text = run_a(mode)
    if code == 77:
        print('SKIP: chain replay needs the duckdb binary (segment A cannot run); nothing was checked')
        shutil.rmtree(tmp_root, ignore_errors=True)
        sys.exit(0)
    ok(code == 0, f'A {mode} failed:\n{text[-1500:]}')
    ok(f'chain replay A ({mode})' in text and 'PASS' in text, text[-300:])

# ---- B: Rust segment -------------------------------------------------------------------------------------------------------------------------------
def run_news(args, env_extra, state):
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
    env.update({'NEWSROOM_AGENT': 'pi', 'MOCK_STATE': str(state), 'NEWSROOM_RPC_TOTAL_MS': '8000', 'NEWSROOM_RPC_IDLE_MS': '5000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
    env.update({k: GV for k in GROUP_KEYS})
    if GV == '0': env.update({'NEWSROOM_GROUP_CALL_REFUSE': '0', 'NEWSROOM_GROUP_CALL_REFUSE_ALL': '0'})  # the refusals are on unless "0" and need ENFORCE and CALL_CHECK
    if FP: env['NEWSROOM_CHAIN_FINGERPRINT_AT_PASS'] = '1'
    env.update(env_extra)
    p = subprocess.run([binary] + args, env=env, capture_output=True, timeout=60)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')

HTML = '<html>page</html>'
def chain_files(artifact):
    return sorted(str(p.relative_to(artifact)) for d in CHAIN_DIRS for p in (artifact / d).rglob('*') if p.is_file())
def own_fingerprint(artifact):
    # the same definition as the program's, written independently: sorted 'relative path TAB file sha256' lines, joined by newlines, hashed
    lines = sorted(f'{p.relative_to(artifact)}\t{hashlib.sha256(p.read_bytes()).hexdigest()}' for d in CHAIN_DIRS for p in (artifact / d).rglob('*') if p.is_file())
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest()
def b_run(source, message, plans, switch, browser_qa=True, with_chain=True, between=None, record_fp=True):
    """First question (visual-story, all seven tools called), then A's files and the hand-written publication records, then one follow-up."""
    with tempfile.TemporaryDirectory(dir=tmp_root) as out, tempfile.TemporaryDirectory(dir=tmp_root) as state:
        state = Path(state)
        # A visual-story first question can be sent back by the completion retry (14b51d1c), up to twice: two plan slots are kept for that,
        # the prompt counter is moved past them before the follow-up starts, and only the follow-up's prompts are judged.
        env = {'MOCK_PLANS': json.dumps([CHAIN2] + [[] for _ in range(RESERVE)] + plans)}
        code, text = run_news(['investigate', '--pi-bin', str(mock_path), '--out', out, *VS, 'fixed question'], env, state)
        m = re.search(r'artifact: (\S+)', text)
        assert m, text[-600:]
        first_prompts = len((state / 'prompts.jsonl').read_text().splitlines())
        assert 1 <= first_prompts <= 1 + RESERVE, first_prompts
        (state / 'count').write_text(str(1 + RESERVE))
        artifact = Path(m.group(1))
        if with_chain:
            for d in ('infographics', 'visualizations'):
                shutil.copytree(shared / source / 'run' / d, artifact / d, dirs_exist_ok=True)
        for rel, t in [('publications/p1/index.html', HTML), ('publications/p1/manifest.json', json.dumps({'html_ref': 'publications/p1/index.html'}))] + \
                      ([('publications/qa/p1/browser-qa.json', json.dumps({'status': 'PASS', 'html_sha256': hashlib.sha256(HTML.encode()).hexdigest()}))] if browser_qa else []):
            (artifact / rel).parent.mkdir(parents=True, exist_ok=True)
            (artifact / rel).write_text(t)
        record = json.loads(PLANTED)
        if FP and record_fp: record['chain_fingerprint_sha256'] = own_fingerprint(artifact)  # a pass that recorded the chain as it was
        (artifact / 'verification.json').write_text(json.dumps(record) + '\n')
        if between: between(artifact)
        files = chain_files(artifact)
        extra = dict(env)
        if switch is not None: extra['NEWSROOM_FOLLOWUP_COMPLETION_GATE'] = switch
        code, text = run_news(['continue', str(artifact), '--pi-bin', str(mock_path), message], extra, state)
        prompts = [json.dumps(json.loads(l)) for l in (state / 'prompts.jsonl').read_text().splitlines()][first_prompts:]
        ver = json.loads((artifact / 'verification.json').read_text())
        rd = artifact / 'verification-rounds'
        reuse = sorted(p.name for p in rd.glob('chain-reuse-*.json')) if rd.exists() else []
        reuse_rec = json.loads((rd / reuse[0]).read_text()) if reuse else None
        observed = artifact / 'runtime' / 'handoff-observed.jsonl'
        rows = [json.loads(l) for l in observed.read_text().splitlines() if l.strip()] if observed.exists() else []
        if GV == '1':  # the command side's hand-off recorder ran for both commands, and every write it saw was listed and owned
            bad = [x for x in rows if x.get('decision') in ('unlisted', 'not_owned')]
            ok(not bad, ('hand-off rows outside the table', bad[:3]))
            ok({'investigate', 'continue'} <= {x.get('command') for x in rows}, ('no hand-off rows for a command', sorted({x.get('command') for x in rows})))
        else:
            ok(rows == [], 'hand-off recorder wrote rows with the switches off')
        return dict(code=code, text=text, prompts=prompts, ver=ver, reuse=reuse, reuse_rec=reuse_rec, files=files)

EXPLAIN = 'explain the first chart once more'
GAP = 'required complex-visual gate did not pass: newsroom_infographic_plan'
# B clean: the follow-up only explains; the real chain carried over unchanged.
r = b_run('clean', EXPLAIN, [[]], '1')
ok(len(r['prompts']) == 1 and 'System completion gate' not in r['prompts'][0], [p[:120] for p in r['prompts']])
# the hand-made run has no claims or story, so `continue` still ends NOT VERIFIED (integrity) with a non-zero exit, as in the existing gate test; only the gate message is judged
ok('visual delivery incomplete' not in r['text'] and 'completion_gate' not in json.dumps(r['ver']), (r['code'], r['text'][-400:]))
ok(r['reuse'] == ['chain-reuse-of-round-1.json'] and r['reuse_rec']['reused_round_file'] == 'verification-rounds/round-1.json', r['reuse'])
ok(re.fullmatch(r'[0-9a-f]{64}', r['reuse_rec']['chain_fingerprint_sha256']) is not None, r['reuse_rec'])
ok(r['reuse_rec']['fingerprint_files'] == len(r['files']) and len(r['files']) > 0, (r['reuse_rec']['fingerprint_files'], len(r['files'])))
clean_files = r['files']
# the same follow-up with the gate switched off: not judged against earlier rounds
r = b_run('clean', EXPLAIN, [[]], '0')
ok(r['reuse'] == [] and len(r['prompts']) == 1, (r['reuse'], r['prompts']))

def incomplete(label, r, gap=GAP, no_reuse=True):
    ok(len(r['prompts']) == 3, (label, [p[:120] for p in r['prompts']]))
    ok(gap in r['prompts'][1], (label, r['prompts'][1][:400]))
    ok(r['code'] != 0 and 'visual delivery incomplete' in r['text'], (label, r['code'], r['text'][-400:]))
    ok(r['ver']['passed'] is False and r['ver']['round_status'] == 'not_verified' and r['ver']['stage'] == 'completion_gate', (label, r['ver']))
    if no_reuse: ok(r['reuse'] == [], (label, r['reuse']))
# 1: one byte of a real chain file changes during the round (not through a tool call): the whole chain is required again.
target = next(f for f in clean_files if f.startswith('visualizations/') and f.endswith('.svg'))
incomplete('changed chain file', b_run('clean', EXPLAIN, [[['__write', {'path': target, 'text': '<svg id="tampered"/>'}, True]], [], []], '1'))
# 2: the PASS browser QA bound to the page is missing.
incomplete('no browser qa', b_run('clean', EXPLAIN, [[], [], []], '1', browser_qa=False), gap='no measured publication', no_reuse=False)  # chain files unchanged, so the earlier round is still reused; only the QA gap is open
# Not asserted, on purpose: a run whose plan preflight refused (A bad) copied under a planted PASS round is reused (one prompt, no gap), because chain
# reuse trusts the earlier round's pass plus unchanged files and does not look for the plan itself. A real round that passed cannot have a refused plan,
# so this only appears with a planted pass; it is recorded in the report as a boundary note, not pinned here.
# 4: the plan file is removed after the round passed and before the next `news continue` (a manual edit or another command; nothing in the follow-up
# touches it). Without the at-pass switch, reuse fingerprints the chain when the follow-up STARTS, so the missing plan is the baseline and the earlier
# pass is carried over with no gap: today's behaviour, pinned here as known (see the issue on chain fingerprint at pass). With the switch on, the pass
# recorded the chain as it was, the mismatch refuses reuse and the completion gate runs.
def drop_plans(artifact):
    for f in (artifact / 'infographics' / 'plans').glob('*'):
        f.unlink()
r = b_run('clean', EXPLAIN, [[], [], []], '1', between=drop_plans)
if FP:
    incomplete('plan removed between rounds', r)
else:
    ok(len(r['prompts']) == 1 and r['reuse'] == ['chain-reuse-of-round-1.json'], ('known gap changed', [p[:120] for p in r['prompts']], r['reuse']))
# 5 (switch on only): a passing round written before the fingerprint was recorded has nothing to compare with: a gap, not a silent pass.
if FP:
    incomplete('pass without a recorded fingerprint', b_run('clean', EXPLAIN, [[], [], []], '1', record_fp=False))
print(f'chain replay ({GROUPS}, {"fp-on" if FP else "fp-off"}): {checks} checks -- PASS')
shutil.rmtree(tmp_root, ignore_errors=True)
