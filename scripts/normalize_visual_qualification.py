#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', default='outputs/visual-browser-qualification.json')
    args = ap.parse_args()
    raw = json.loads(Path(args.input).read_text(encoding='utf-8'))
    cpu = ((raw.get('cpu_visual_lane') or {}).get('status') == 'PASS')
    gpu_raw = (raw.get('gpu_webgl') or {}).get('status')
    gpu = gpu_raw == 'ACCELERATED_WEBGL'
    browser = raw.get('browser_suite_status') == 'PASS'
    full_rc = raw.get('full_release_rc_status') == 'PASS'
    passed = cpu and gpu and browser and full_rc
    out = {
        'schema_version': '1.0.0',
        'qualification_type': 'visual_browser_gpu',
        'status': 'PASS' if passed else 'BLOCKED',
        'cpu_browser_status': 'PASS' if cpu and browser else 'FAIL',
        'gpu_webgl_status': 'PASS' if gpu else ('UNAVAILABLE' if gpu_raw == 'UNAVAILABLE' else 'BLOCKED'),
        'source_gpu_status': gpu_raw,
        'full_release_rc_status': raw.get('full_release_rc_status'),
        'source_artifact': args.input,
        'checks': {
            'browser_suite_passed': browser,
            'cpu_visual_passed': cpu,
            'accelerated_webgl': gpu,
            'full_release_tree_qualified': full_rc,
        },
    }
    blockers = [k for k, v in out['checks'].items() if not v]
    out['blockers'] = blockers
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0 if passed else 2


if __name__ == '__main__':
    raise SystemExit(main())
