#!/usr/bin/env python3
"""Offline A/B harness for bounded completion retry context."""
import json, os, statistics, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / 'target' / 'release' / 'news'
MOCK = ROOT / 'scripts' / 'perf_mock_pi.py'
TOPIC = 'map flow trend complex visual story with HTML desktop and mobile PNG output'

def run(packet):
    with tempfile.TemporaryDirectory(prefix='retry-context-ab-') as tmp:
        env = os.environ.copy()
        env['NEWSROOM_MOCK_PI'] = str(MOCK)
        if packet:
            env['NEWSROOM_RETRY_CONTEXT_PACKET_EXPERIMENT'] = '1'
        else:
            env.pop('NEWSROOM_RETRY_CONTEXT_PACKET_EXPERIMENT', None)
        proc = subprocess.run([str(BINARY), 'investigate', '--out', tmp, '--pi-bin', str(MOCK), TOPIC], env=env, text=True, capture_output=True, timeout=15)
        dirs = [p for p in Path(tmp).iterdir() if p.is_dir()]
        assert len(dirs) == 1, (proc.returncode, proc.stderr)
        events = [json.loads(line) for line in (dirs[0] / 'events.jsonl').read_text().splitlines()]
        metrics = [e for e in events if e.get('type') == 'newsroom_rpc_metrics']
        return {
            'returncode': proc.returncode,
            'prompt_bytes': sum(e.get('prompt_bytes', 0) for e in metrics),
            'rpc_count': len(metrics),
            'retry_count': max(0, len(metrics) - 1) if len(metrics) > 1 else sum(max(0, e.get('prompt_count', 1) - 1) for e in metrics),
            'launch_count': len(metrics),
            'packet_bytes': sum(len(json.dumps(e, separators=(',', ':'))) for e in events if e.get('type') == 'retry_context_packet'),
        }

def main():
    baseline = [run(False) for _ in range(10)]
    packet = [run(True) for _ in range(10)]
    b = statistics.median(x['prompt_bytes'] for x in baseline)
    p = statistics.median(x['prompt_bytes'] for x in packet)
    assert all(x['retry_count'] == 2 for x in baseline + packet)
    assert all(x['returncode'] != 0 for x in baseline + packet), 'completion must remain fail-closed for incomplete mock'
    result = {
        'repetitions_per_variant': 10,
        'baseline_median_prompt_bytes': b,
        'packet_median_prompt_bytes': p,
        'prompt_byte_reduction_percent': (1 - p / b) * 100 if b else 0,
        'baseline_rpc_count': statistics.median(x['rpc_count'] for x in baseline),
        'packet_rpc_count': statistics.median(x['rpc_count'] for x in packet),
        'baseline_child_launches': statistics.median(x['launch_count'] for x in baseline),
        'packet_child_launches': statistics.median(x['launch_count'] for x in packet),
        'baseline_completion_retries': statistics.median(x['retry_count'] for x in baseline),
        'packet_completion_retries': statistics.median(x['retry_count'] for x in packet),
        'baseline_returncodes': sorted(set(x['returncode'] for x in baseline)),
        'packet_returncodes': sorted(set(x['returncode'] for x in packet)),
    }
    print(json.dumps(result, sort_keys=True))

if __name__ == '__main__':
    main()
