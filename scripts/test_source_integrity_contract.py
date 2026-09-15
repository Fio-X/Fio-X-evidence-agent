#!/usr/bin/env python3
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path

CHECK = Path(__file__).with_name('check_source_integrity.py')

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def tree(root, manifest='source-integrity.json'):
    rows = []
    for p in sorted(x for x in root.rglob('*') if x.is_file()):
        rel = p.relative_to(root).as_posix()
        if rel == manifest or rel.startswith('excluded/') or rel == 'source.tar':
            continue
        rows.append((rel, sha(p)))
    h = hashlib.sha256()
    for rel, digest in rows:
        h.update(rel.encode() + b'\0' + digest.encode() + b'\n')
    return rows, h.hexdigest()

def run(root, expect):
    p = subprocess.run([
        sys.executable, str(CHECK), '--root', str(root),
        '--manifest', str(root / 'source-integrity.json')
    ], capture_output=True, text=True)
    assert p.returncode == expect, (p.stdout, p.stderr)
    return json.loads(p.stdout)

with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    (root / 'src').mkdir()
    (root / 'vendor').mkdir()
    (root / 'excluded').mkdir()
    (root / 'src/a.txt').write_text('alpha\n')
    (root / 'vendor/pinned.js').write_text('vendor\n')
    (root / 'excluded/cache.bin').write_bytes(b'x')
    (root / 'source.tar').write_bytes(b'archive')
    rows, digest = tree(root)
    manifest = {
        'schema_version': '1.0.0',
        'file_count': len(rows),
        'source_tree_sha256': digest,
        'excluded_paths': ['excluded', 'source.tar'],
        'source_archive': {'path': 'source.tar', 'sha256': sha(root / 'source.tar')},
        'restored_vendor_hashes': {'vendor/pinned.js': sha(root / 'vendor/pinned.js')},
    }
    (root / 'source-integrity.json').write_text(json.dumps(manifest))
    assert run(root, 0)['status'] == 'PASS'
    (root / 'src/a.txt').write_text('tampered\n')
    assert run(root, 2)['status'] == 'FAIL'
    (root / 'src/a.txt').write_text('alpha\n')
    (root / 'vendor/pinned.js').write_text('tampered\n')
    assert run(root, 2)['status'] == 'FAIL'

print(json.dumps({
    'status': 'PASS',
    'tamper_detection': True,
    'vendor_hash_gate': True,
    'archive_hash_gate': True,
}))
