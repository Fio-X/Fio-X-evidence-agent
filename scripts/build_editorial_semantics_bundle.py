#!/usr/bin/env python3
from pathlib import Path
import hashlib

ROOT=Path(__file__).resolve().parents[1]
for name in ['measure_semantics.mjs','editorial_semantics.mjs']:
    src=ROOT/'runtime/visual'/name
    out=ROOT/'runtime/pi'/name
    text=src.read_text(encoding='utf-8')
    out.write_text(f'// Generated from runtime/visual/{name}. Do not edit by hand.\n'+text,encoding='utf-8')
    print(f'{out} sha256={hashlib.sha256(text.encode()).hexdigest()}')
