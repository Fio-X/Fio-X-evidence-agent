#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from sync_backend_policy import classify  # noqa: E402

registry = json.loads((ROOT / 'config/tool-registry.json').read_text())
tools = registry.get('tools', registry if isinstance(registry, list) else [])
if not isinstance(tools, list):
    raise SystemExit('tool registry must contain a tools list')

names = [str(t.get('name', '')).strip() for t in tools]
if any(not name for name in names):
    raise SystemExit('tool registry contains an unnamed tool')
if len(names) != len(set(names)):
    duplicates = sorted({name for name in names if names.count(name) > 1})
    raise SystemExit(f'tool registry contains duplicate tools: {duplicates}')

policy = json.loads((ROOT / 'config/backend-policy.json').read_text())
entries = policy.get('tools', {})
if not isinstance(entries, dict):
    raise SystemExit('backend policy must contain a tools object')

registry_names = set(names)
policy_names = set(entries)
missing = sorted(registry_names - policy_names)
extra = sorted(policy_names - registry_names)
if missing or extra:
    raise SystemExit(f'backend policy drift: missing={missing}, extra={extra}')

allowed = {'local_first', 'specialized', 'portable_network', 'portable'}
for name, entry in entries.items():
    if entry.get('policy') not in allowed:
        raise SystemExit(f'{name}: invalid policy {entry.get("policy")}')
    if not isinstance(entry.get('macos_candidates'), list):
        raise SystemExit(f'{name}: macos_candidates must be a list')
    if not entry.get('fallback'):
        raise SystemExit(f'{name}: fallback is required')

expected = {str(tool['name']): classify(tool) for tool in tools}
if entries != expected:
    drift = sorted(name for name in registry_names if entries.get(name) != expected.get(name))
    raise SystemExit(f'backend policy generated-content drift: {drift}')

print(f'backend policy: PASS ({len(names)} tools)')
