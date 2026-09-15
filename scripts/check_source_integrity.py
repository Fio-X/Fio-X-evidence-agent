#!/usr/bin/env python3
import argparse, fnmatch, hashlib, json
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def excluded(rel: str, patterns: list[str]) -> bool:
    rel = rel.replace('\\', '/')
    for pattern in patterns:
        pattern = str(pattern).replace('\\', '/').rstrip('/')
        if not pattern:
            continue
        if rel == pattern or rel.startswith(pattern + '/') or fnmatch.fnmatch(rel, pattern):
            return True
    return False


def tree_rows(root: Path, exclusions: list[str], manifest_rel: str) -> list[tuple[str, str]]:
    rows = []
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        rel = path.relative_to(root).as_posix()
        if rel == manifest_rel or excluded(rel, exclusions):
            continue
        rows.append((rel, sha256_file(path)))
    return rows


def tree_hash(rows: list[tuple[str, str]]) -> str:
    h = hashlib.sha256()
    for rel, digest in rows:
        h.update(rel.encode('utf-8'))
        h.update(b'\0')
        h.update(digest.encode('ascii'))
        h.update(b'\n')
    return h.hexdigest()


def verify(root: Path, manifest_path: Path) -> dict:
    manifest = json.loads(manifest_path.read_text())
    manifest_rel = manifest_path.relative_to(root).as_posix()
    exclusions = list(manifest.get('excluded_paths', []))
    rows = tree_rows(root, exclusions, manifest_rel)
    errors = []
    expected_count = manifest.get('file_count')
    if expected_count != len(rows):
        errors.append(f'file_count expected {expected_count}, got {len(rows)}')
    actual_tree = tree_hash(rows)
    if manifest.get('source_tree_sha256') != actual_tree:
        errors.append(f'source_tree_sha256 expected {manifest.get("source_tree_sha256")}, got {actual_tree}')

    archive = manifest.get('source_archive') or {}
    archive_path = archive.get('path')
    archive_sha = archive.get('sha256')
    if bool(archive_path) != bool(archive_sha):
        errors.append('source_archive requires both path and sha256')
    elif archive_path:
        candidate = (root / archive_path).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            errors.append('source_archive path escapes root')
        else:
            if not candidate.is_file():
                errors.append(f'source archive missing: {archive_path}')
            else:
                actual = sha256_file(candidate)
                if actual != archive_sha:
                    errors.append(f'source archive sha256 expected {archive_sha}, got {actual}')

    restored = manifest.get('restored_vendor_hashes') or {}
    if not isinstance(restored, dict):
        errors.append('restored_vendor_hashes must be an object')
    else:
        for rel, expected in sorted(restored.items()):
            candidate = (root / rel).resolve()
            try:
                candidate.relative_to(root.resolve())
            except ValueError:
                errors.append(f'vendor path escapes root: {rel}')
                continue
            if not candidate.is_file():
                errors.append(f'restored vendor missing: {rel}')
                continue
            actual = sha256_file(candidate)
            if actual != expected:
                errors.append(f'restored vendor sha256 mismatch: {rel}')

    return {
        'status': 'PASS' if not errors else 'FAIL',
        'file_count': len(rows),
        'source_tree_sha256': actual_tree,
        'excluded_paths': exclusions,
        'restored_vendor_count': len(restored) if isinstance(restored, dict) else 0,
        'errors': errors,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--manifest', required=True)
    args = ap.parse_args()
    root = Path(args.root).resolve()
    manifest = Path(args.manifest).resolve()
    try:
        manifest.relative_to(root)
    except ValueError:
        raise SystemExit('manifest must be inside root')
    result = verify(root, manifest)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result['status'] == 'PASS' else 2

if __name__ == '__main__':
    raise SystemExit(main())
