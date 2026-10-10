#!/usr/bin/env python3
"""NEWSROOM_FOLLOWUP_PRIMARY_LATEST=1: after `news continue`, the `primary_artifact:` line names the newest chart that round made
and that passed its checks (render QA, critic and verification records on disk); a round with no such chart keeps the old line.
Off, the output is unchanged. A tiny local RPC peer replays scripted rounds and writes the records; nothing contacts a model."""
import json, os, re, subprocess, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else root / 'target/debug/news').resolve())
MOCK = r'''
import json, os, sys, time
from pathlib import Path
state = Path(os.environ["MOCK_STATE"])
plans = json.loads(os.environ["MOCK_PLANS"])  # one entry per prompt: [[tool, args], ...]; tool "__write" writes args["path"] under the artifact dir; "__utime" sets its mtime to now + args["offset"] seconds
def emit(**v): print(json.dumps(v), flush=True)
for line in sys.stdin:
    cmd = json.loads(line)
    kind = cmd["type"]
    if kind == "prompt":
        n = int((state / "count").read_text()) if (state / "count").exists() else 0
        (state / "count").write_text(str(n + 1))
        plan = plans[n] if n < len(plans) else []
        emit(type="response", command="prompt", success=True)
        for i, (tool, args) in enumerate(plan):
            if tool == "__write":
                target = Path(os.environ["NEWSROOM_ARTIFACT_DIR"]) / args["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(args["text"])
                continue
            if tool == "__utime":
                target = Path(os.environ["NEWSROOM_ARTIFACT_DIR"]) / args["path"]
                t = time.time() + args["offset"]
                os.utime(target, (t, t))
                continue
            emit(type="tool_execution_start", toolName=tool, toolCallId=f"c{n}-{i}", args=args)
            emit(type="tool_execution_end", toolName=tool, toolCallId=f"c{n}-{i}", isError=False)
        emit(type="message_update", assistantMessageEvent={"type": "text_delta", "delta": os.environ.get("MOCK_ANSWER", "mock answer")})
        emit(type="agent_settled")
    elif kind == "get_last_assistant_text":
        emit(type="response", command=kind, success=True, data={"text": os.environ.get("MOCK_ANSWER", "mock answer")})
    elif kind == "get_session_stats":
        emit(type="response", command=kind, success=True, data={"tokens": {"input": 0, "output": 0}})
'''
tmp_root = Path(tempfile.mkdtemp())
mock_path = tmp_root / 'mock_pi.py'
mock_path.write_text('#!/usr/bin/env python3\n' + MOCK)
mock_path.chmod(0o755)

def w(path, value):
    return ['__write', {'path': path, 'text': value if isinstance(value, str) else json.dumps(value)}]

def at(path, offset):
    """Set a file's mtime to now + offset seconds (the mock runs this after the writes it follows)."""
    return ['__utime', {'path': path, 'offset': offset}]

def page(key='p1'):
    """A publication page: manifest with html_ref plus the html file."""
    return [w(f'publications/{key}/index.html', '<html></html>'), w(f'publications/{key}/manifest.json', {'html_ref': f'publications/{key}/index.html'})]

def chart(key, qa=True, status='VERIFIED', critic=True, svg=True):
    """The records the runtime writes for one rendered chart: svg, manifest, critic."""
    out = []
    if svg: out.append(w(f'visualizations/{key}.svg', f'<svg xmlns="http://www.w3.org/2000/svg" id="{key}"></svg>'))
    out.append(w(f'visualizations/{key}.json', {'chart_type': 'sankey', 'svg': f'visualizations/{key}.svg', 'variants': {'desktop': f'visualizations/{key}.svg'},
                                                 'render_qa': {'passed': qa, 'failure_count': 0 if qa else 3}, 'artifact_status': status}))
    if critic is not None:
        out.append(w(f'visualizations/critics/{key}.json', {'manifest_ref': f'visualizations/{key}.json', 'passed': critic}))
    return out

def run_news(args, env_extra, state):
    env = {k: v for k, v in os.environ.items() if not k.startswith('NEWSROOM_')}
    env.update({'MOCK_STATE': str(state), 'NEWSROOM_RPC_TOTAL_MS': '8000', 'NEWSROOM_RPC_IDLE_MS': '5000', 'NEWSROOM_RPC_FINISH_MS': '3000'})
    env.update(env_extra)
    p = subprocess.run([binary] + args, env=env, capture_output=True, timeout=60)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')

def primary_line(text):
    m = re.search(r'^primary_artifact: (\S+) \((\w+)\)', text, re.M)
    return (Path(m.group(1)).name, m.group(2)) if m else None

def scenario(first, second, switch, answer='mock answer'):
    """Two turns: the first question writes `first`, the follow-up writes `second`; returns the follow-up's primary_artifact line."""
    with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as state:
        env = {'MOCK_PLANS': json.dumps([first, second]), 'MOCK_ANSWER': answer}
        code, text = run_news(['investigate', '--pi-bin', str(mock_path), '--out', out, 'fixed question'], env, Path(state))
        m = re.search(r'artifact: (\S+)', text)
        assert m, text[-600:]
        extra = dict(env)
        if switch is not None: extra['NEWSROOM_FOLLOWUP_PRIMARY_LATEST'] = switch
        code, text = run_news(['continue', str(Path(m.group(1))), '--pi-bin', str(mock_path), 'now a second sankey'], extra, Path(state))
        return primary_line(text), text

OLD, NEW = ('chart-a.svg', 'svg'), ('chart-b.svg', 'svg')
A, B = chart('chart-a'), chart('chart-b')

# 0. the first turn alone names chart-a (setup sanity: the old line is the first chart).
# A. off: the follow-up's new chart exists and passed, the line still names the first turn's chart (today's behaviour).
line, text = scenario(A, B, None)
assert line == OLD, (line, text[-400:])
for value in ['0', 'true', 'yes', '', ' 1', '01']:
    line, _ = scenario(A, B, value)
    assert line == OLD, (value, line)

# B. on: the line names the follow-up's own chart.
line, text = scenario(A, B, '1')
assert line == NEW, (line, text[-400:])

# C. on, the round made no chart: today's line.
line, _ = scenario(A, [], '1')
assert line == OLD, line

# D. on, the round's only new chart failed a check in the program's records: the old line is kept, whatever the model says.
liar = 'The new chart is visualizations/chart-b.svg and it passed every check.'
for label, bad in [('render QA failed', chart('chart-b', qa=False)), ('critic failed', chart('chart-b', critic=False)), ('no critic record', chart('chart-b', critic=None)),
                   ('not verified', chart('chart-b', status='DRAFT')), ('svg missing', chart('chart-b', svg=False))]:
    line, _ = scenario(A, bad, '1', answer=liar)
    assert line == OLD, (label, line)

# E. on, two new charts, the newer one failed: the newest one that passed is named.
line, _ = scenario(A, chart('chart-b') + chart('chart-c', qa=False), '1')
assert line == NEW, line
# F. on, two passing new charts: the newest.
line, _ = scenario(A, chart('chart-b') + chart('chart-c'), '1')
assert line == ('chart-c.svg', 'svg'), line
# F2. the same with clearly different mtimes: the newer manifest has the lexicographically SMALLER path, so path order alone would pick chart-m.
line, _ = scenario(A, chart('chart-m') + chart('chart-d') + [at('visualizations/chart-m.json', 10), at('visualizations/chart-d.json', 30)], '1')
assert line == ('chart-d.svg', 'svg'), line
# F3. on, the new chart's manifest is older than the round's start (a file this round did not write): not taken as this round's.
line, _ = scenario(A, chart('chart-b') + [at('visualizations/chart-b.json', -3600)], '1')
assert line == OLD, line
# H. on, the round produced a qualified publication page as well as a passing chart: the page comes first, as the delivery order has it when nothing is declared.
line, text = scenario(A, chart('chart-b') + page(), '1')
assert line == ('index.html', 'html'), (line, text[-400:])
# (off, the declared first-turn chart still wins, exactly as today)
line, _ = scenario(A, chart('chart-b') + page(), None)
assert line == OLD, line
# G. on, nothing new this round: a passing chart from the first turn is never taken as this round's, even when it is the newer file
# (chart-z was written after chart-a; today's line is the first candidate in path order, chart-a).
line, _ = scenario(chart('chart-a') + chart('chart-z'), [], '1')
assert line == OLD, line
print('test_followup_primary_latest: ok')
