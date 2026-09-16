#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'normalize_visual_qualification.py'


def run(tmp: Path, *, full_rc='PASS', cpu='PASS', browser='PASS', gpu='ACCELERATED_WEBGL', prerequisite=False):
    src = tmp / 'raw.json'
    out = tmp / 'normalized.json'
    src.write_text(json.dumps({
        'schema_version': '1.0.0',
        'browser_suite_status': browser,
        'full_release_rc_status': full_rc,
        'cpu_visual_lane': {'status': cpu},
        'gpu_webgl': {'status': gpu},
    }), encoding='utf-8')
    cmd = [sys.executable, str(SCRIPT), '--input', str(src), '--output', str(out)]
    if prerequisite:
        cmd.append('--full-release-tree-qualified')
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    return proc, json.loads(out.read_text(encoding='utf-8'))


with tempfile.TemporaryDirectory() as td:
    base = Path(td)

    p = base / 'pass'; p.mkdir()
    proc, data = run(p)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert data['status'] == 'PASS'
    assert data['cpu_browser_status'] == 'PASS'
    assert data['gpu_webgl_status'] == 'PASS'

    p = base / 'capability-only'; p.mkdir()
    proc, data = run(p, full_rc='BLOCKED_PENDING_FULL_RELEASE_TREE')
    assert proc.returncode == 2
    assert data['status'] == 'BLOCKED'
    assert 'full_release_tree_qualified' in data['blockers']

    p = base / 'prerequisite-pass'; p.mkdir()
    proc, data = run(p, full_rc='BLOCKED_PENDING_FULL_RELEASE_TREE', prerequisite=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert data['status'] == 'PASS'
    assert data['source_full_release_rc_status'] == 'BLOCKED_PENDING_FULL_RELEASE_TREE'
    assert data['full_release_tree_qualified_by_prerequisite'] is True

    p = base / 'software'; p.mkdir()
    proc, data = run(p, gpu='SOFTWARE_WEBGL', prerequisite=True)
    assert proc.returncode == 2
    assert data['gpu_webgl_status'] == 'BLOCKED'
    assert 'accelerated_webgl' in data['blockers']

    p = base / 'unavailable'; p.mkdir()
    proc, data = run(p, gpu='UNAVAILABLE', prerequisite=True)
    assert proc.returncode == 2
    assert data['gpu_webgl_status'] == 'UNAVAILABLE'

    p = base / 'cpu-fail'; p.mkdir()
    proc, data = run(p, cpu='FAIL', prerequisite=True)
    assert proc.returncode == 2
    assert data['cpu_browser_status'] == 'FAIL'

print('visual qualification normalization contract: PASS')
