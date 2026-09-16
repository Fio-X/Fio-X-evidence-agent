#!/usr/bin/env python3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
required=[
 'Cargo.toml','src/main.rs','runtime/pi/newsroom.ts','runtime/web/publication.mjs','runtime/browser/browser_qa.py',
 'runtime/visual/publication_binding.mjs','runtime/visual/svg_security.mjs','runtime/pi/tool_phase_policy.mjs',
 'schemas/publication-spec.schema.json','schemas/map-spec.schema.json','config/release-profiles.json','scripts/release_check.py'
]
missing=[p for p in required if not (ROOT/p).is_file()]
if missing: raise SystemExit('missing source distribution files: '+', '.join(missing))
source_files=[p for p in ROOT.rglob('*') if p.is_file() and 'outputs' not in p.parts and '.git' not in p.parts and '__pycache__' not in p.parts]
if len(source_files)<600: raise SystemExit(f'source tree unexpectedly small: {len(source_files)} files')
print(f'source distribution v1.12 PASS ({len(source_files)} files)')
