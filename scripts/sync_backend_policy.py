#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / 'config' / 'tool-registry.json'
OUT = ROOT / 'config' / 'backend-policy.json'

MACOS_NATIVE = {
    'artifact_inventory': ['mdfind', 'mdls', 'file'],
    'fetch_url': ['curl'],
    'download_data': ['curl'],
    'newsroom_parallel_tasks': ['mdfind', 'mdls', 'textutil', 'sips', 'sqlite3', 'curl', 'file', 'shasum'],
}
SPECIALIZED = {
    'duckdb_query': 'duckdb',
}

def classify(tool: dict) -> dict:
    name = str(tool['name'])
    phase = str(tool.get('phase', 'core'))
    cap = str(tool.get('capability_class', 'unknown'))
    if name in MACOS_NATIVE:
        return {
            'policy': 'local_first',
            'macos_candidates': MACOS_NATIVE[name],
            'fallback': 'portable_runtime',
            'rationale': 'Safe native primitives can reduce startup or I/O overhead while preserving the high-level tool contract.',
        }
    if name in SPECIALIZED:
        return {
            'policy': 'specialized',
            'macos_candidates': ['sqlite3'] if name == 'duckdb_query' else [],
            'fallback': SPECIALIZED[name],
            'rationale': 'The specialized backend provides semantics or formats that a generic system utility cannot replace safely.',
        }
    lowered = name.lower()
    if 'browser' in lowered or 'vision' in lowered:
        return {
            'policy': 'specialized',
            'macos_candidates': ['qlmanage'] if 'vision' in lowered else [],
            'fallback': 'browser_or_model_runtime',
            'rationale': 'Native utilities may assist inspection, but browser/model semantics remain authoritative.',
        }
    if cap in {'retrieval', 'discovery'}:
        return {
            'policy': 'portable_network',
            'macos_candidates': ['curl'],
            'fallback': 'portable_runtime',
            'rationale': 'Network discovery remains provider/API-specific; curl is available for compatible HTTP transport paths.',
        }
    if cap in {'visual', 'publication'}:
        return {
            'policy': 'portable',
            'macos_candidates': ['sips', 'qlmanage'] if cap == 'visual' else ['qlmanage'],
            'fallback': 'portable_runtime',
            'rationale': 'Native tools can accelerate previews or metadata but do not replace deterministic render/QA contracts.',
        }
    return {
        'policy': 'portable',
        'macos_candidates': [],
        'fallback': 'portable_runtime',
        'rationale': f'No safe macOS-native substitution is required for the {phase}/{cap} tool contract.',
    }

def main() -> int:
    registry = json.loads(REGISTRY.read_text())
    tools = registry.get('tools', registry if isinstance(registry, list) else [])
    if not isinstance(tools, list):
        raise SystemExit('tool registry must contain a tools list')
    entries = {str(t['name']): classify(t) for t in tools}
    payload = {
        'schema_version': '1.0.0',
        'platform': 'macos',
        'principle': 'local-first when semantics are equivalent; specialized backends remain authoritative when they add required capability',
        'tools': entries,
    }
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + '\n')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
