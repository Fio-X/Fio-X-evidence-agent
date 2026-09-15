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


def tree_rows(root: Path, exclusions: list[str], ignored: set[str]) -> list[tuple[str, str]]:
    rows = []
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        rel = path.relative_to(root).as_posix()
        if rel in ignored or excluded(rel, exclusions):
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


def safe_path(root: Path, rel: str) -> Path:
    candidate = (root / rel).resolve()
    candidate.relative_to(root.resolve())
    return candidate


def verify_archive(root: Path, manifest: dict, archive_override: Path | None, errors: list[str]) -> dict:
    archive = manifest.get('source_archive') or {}
    expected = archive.get('sha256')
    name = archive.get('name')
    evidence_rel = archive.get('verification_evidence')
    if not expected or not name or not evidence_rel:
        errors.append('source_archive requires name, sha256, and verification_evidence')
        return {'mode': 'invalid'}

    evidence_path = safe_path(root, evidence_rel)
    if archive_override is not None:
        if not archive_override.is_file():
            errors.append(f'source archive missing: {archive_override}')
            return {'mode': 'recomputed'}
        actual = sha256_file(archive_override)
        if actual != expected:
            errors.append(f'source archive sha256 expected {expected}, got {actual}')
        receipt = {
            'schema_version': '1.0.0',
            'status': 'PASS' if actual == expected else 'FAIL',
            'archive_name': name,
            'archive_sha256': actual,
            'expected_sha256': expected,
        }
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
        return {'mode': 'recomputed', 'actual_sha256': actual, 'evidence': evidence_rel}

    if not evidence_path.is_file():
        errors.append(f'source archive verification evidence missing: {evidence_rel}')
        return {'mode': 'receipt'}
    try:
        receipt = json.loads(evidence_path.read_text())
    except Exception as exc:
        errors.append(f'invalid source archive verification evidence: {exc}')
        return {'mode': 'receipt'}
    if receipt.get('status') != 'PASS':
        errors.append('source archive verification evidence is not PASS')
    if receipt.get('archive_name') != name:
        errors.append('source archive verification evidence name mismatch')
    if receipt.get('archive_sha256') != expected or receipt.get('expected_sha256') != expected:
        errors.append('source archive verification evidence sha256 mismatch')
    return {'mode': 'receipt', 'evidence': evidence_rel}


def verify(root: Path, manifest_path: Path, archive_override: Path | None = None) -> dict:
    manifest = json.loads(manifest_path.read_text())
    manifest_rel = manifest_path.relative_to(root).as_posix()
    exclusions = list(manifest.get('excluded_paths', []))
    archive = manifest.get('source_archive') or {}
    evidence_rel = archive.get('verification_evidence')
    ignored = {manifest_rel}
    if evidence_rel:
        ignored.add(str(evidence_rel).replace('\\', '/'))
    rows = tree_rows(root, exclusions, ignored)
    errors = []
    expected_count = manifest.get('file_count')
    if expected_count != len(rows):
        errors.append(f'file_count expected {expected_count}, got {len(rows)}')
    actual_tree = tree_hash(rows)
    if manifest.get('source_tree_sha256') != actual_tree:
        errors.append(f'source_tree_sha256 expected {manifest.get("source_tree_sha256")}, got {actual_tree}')

    try:
        archive_result = verify_archive(root, manifest, archive_override, errors)
    except ValueError:
        errors.append('source archive verification evidence path escapes root')
        archive_result = {'mode': 'invalid'}

    restored = manifest.get('restored_vendor_hashes') or {}
    if not isinstance(restored, dict):
        errors.append('restored_vendor_hashes must be an object')
    else:
        for rel, expected in sorted(restored.items()):
            try:
                candidate = safe_path(root, rel)
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
        'archive_verification': archive_result,
        'errors': errors,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--archive', help='transient source archive to recompute and write verification receipt')
    args = ap.parse_args()
    root = Path(args.root).resolve()
    manifest = Path(args.manifest).resolve()
    try:
        manifest.relative_to(root)
    except ValueError:
        raise SystemExit('manifest must be inside root')
    archive = Path(args.archive).resolve() if args.archive else None
    result = verify(root, manifest, archive)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result['status'] == 'PASS' else 2

if __name__ == '__main__':
    raise SystemExit(main())
