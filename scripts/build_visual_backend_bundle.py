#!/usr/bin/env python3
from pathlib import Path
import hashlib
ROOT=Path(__file__).resolve().parents[1]
src=ROOT/'runtime/visual/backend_policy.mjs'
out=ROOT/'runtime/pi/backend_policy.mjs'
text=src.read_text(encoding='utf-8')
out.write_text('// Generated from runtime/visual/backend_policy.mjs. Do not edit by hand.\n'+text,encoding='utf-8')
print(f'{out} sha256={hashlib.sha256(text.encode()).hexdigest()}')
