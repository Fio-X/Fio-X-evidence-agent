#!/usr/bin/env python3
"""NEWSROOM_STEP_LINES: off is byte-identical to the base binary; on prints named step lines. Offline mock only.
Usage: test_step_lines.py HEAD_BINARY BASE_BINARY"""
import os, re, subprocess, sys, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
head, base = (str(Path(a).resolve()) for a in sys.argv[1:3])
mock = str(root / 'scripts/perf_mock_pi.py')
SECRET = 'test-only-step-lines-canary'

def run(binary, switch, mode='chain_chart', topic='中国出生率图表'):
    env = {k: v for k, v in os.environ.items() if k != 'NEWSROOM_STEP_LINES'}
    env.update(PERF_MOCK_MODE=mode, PERF_MOCK_CHAIN_CASE='ok', PERF_MOCK_AFTER_CHART='0', NEWSROOM_SPEED_CHAIN_VIZ='1',
               NEWSROOM_SPEED_ATOMIC_ARTIFACT='1', NEWSROOM_SPEED_INLINE_CLAIM='1', NEWSROOM_RPC_TOTAL_MS='8000',
               NEWSROOM_RPC_IDLE_MS='5000', NEWSROOM_RPC_HEARTBEAT_MS='600000', PERF_TEST_SECRET=SECRET)
    if switch is not None: env['NEWSROOM_STEP_LINES'] = switch
    with tempfile.TemporaryDirectory() as tmp:
        p = subprocess.run([binary, 'investigate', '--pi-bin', mock, '--out', tmp, topic], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr, tmp

def norm(text, tmp):
    text = text.replace(tmp, 'TMP')
    text = re.sub(r'/(?:private/)?(?:var|tmp)/[^\s]*', 'PATH', text)
    return re.sub(r'\d+', 'N', text)

for mode in ('chain_chart', 'provider_error'):
    brc, bout, berr, btmp = run(base, None, mode)
    for sw in (None, '0', 'true', ''):
        rc, out, err, tmp = run(head, sw, mode)
        assert norm(err, tmp) == norm(berr, btmp), (mode, sw, 'stderr differs from base')
        assert (rc, norm(out, tmp)) == (brc, norm(bout, btmp)), (mode, sw)
    rc, out, err, tmp = run(head, '1', mode)
    assert (rc, norm(out, tmp)) == (brc, norm(bout, btmp)), (mode, 'stdout/exit changed')
    assert 'phase=' not in err, (mode, err)
    assert SECRET not in out + err
    if mode == 'chain_chart':
        assert '[agent] chart_ready' in err and 'phase=' in berr
        lines = err.splitlines()
        assert re.search(r'^\[ *\d+s\] 设计 → 检查 → 出图 → 自查（一次完成）', err, re.M), err
        assert all(f'· {n}' in err for n in ('设计图表', '检查图表设计', '出图', '图表自查打分')), err
        i = next(i for i, l in enumerate(lines) if l.startswith('[agent] chart_ready'))
        assert re.match(r'^\[ *\d+s\] 图出来了', lines[i - 1]), lines[i - 1]
        assert re.search(r'^== 完成：共 \d+ 秒，\d+ 次调用（其中退回 \d+ 次）；系统复算：(通过|未通过) ==$', err, re.M), err
    else:
        assert '[agent] rpc_failure' in err, err
print('ok')
