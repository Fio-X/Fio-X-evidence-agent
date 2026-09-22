#!/usr/bin/env python3
import subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
required=[
 'Cargo.toml','src/main.rs','runtime/pi/newsroom.ts','runtime/web/publication.mjs','runtime/browser/browser_qa.py',
 'runtime/visual/publication_binding.mjs','runtime/visual/svg_security.mjs','runtime/pi/tool_phase_policy.mjs',
 'schemas/publication-spec.schema.json','schemas/map-spec.schema.json','config/release-profiles.json','scripts/release_check.py'
]
missing=[p for p in required if not (ROOT/p).is_file()]
if missing: raise SystemExit('missing source distribution files: '+', '.join(missing))
raw=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT)
source_files=[ROOT/part.decode() for part in raw.split(b'\0') if part and (ROOT/part.decode()).is_file()]
if any('.env' == p.relative_to(ROOT).as_posix() or 'target' in p.parts for p in source_files):
    raise SystemExit('source distribution includes ignored credentials or build outputs')
if len(source_files)<600: raise SystemExit(f'source tree unexpectedly small: {len(source_files)} files')
print(f'source distribution v1.12 PASS ({len(source_files)} files)')
