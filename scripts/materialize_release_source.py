#!/usr/bin/env python3
from __future__ import annotations
import argparse, fnmatch, hashlib, json, shutil, subprocess, sys, tarfile, tempfile, zipfile
from pathlib import Path, PurePosixPath

PLOTLY_SHA = '9666a0e617e211ef2fbab8e9c9e07b224de1a67f56802d532ad59a42d5822df3'
NATURAL_EARTH = {
    'naturalearth_lowres.dbf': 'd2ae1c99adcf8e4586a5b12c639672035fa2f3f469e7255947de00401c3ed7e1',
    'naturalearth_lowres.shp': '08e341606e8391e458c3f08deb312de664b56bfae376064c5aa0aee6681a5f55',
    'naturalearth_lowres.shx': '8b0be2ad97dd484aee5c2ebc98697d5372e832b8ae58a35a661aeef6b985668d',
}
REGENERATED_V110 = {
    'fixtures/v110-systems/large-network-5000.json': '5d0112b3493b62a5a9ba738f46e0533151074ac911f0028e64828a8bb0fb1dee',
    'fixtures/v110-systems/world-outline.json': '0adf5b7a8af2cae68f5a13ae427861bbe332235405b117e51028681a9f028ca0',
}
PLOTLY_PATHS = [
    'runtime/pi/vendor/plotly-3.3.1.min.js',
    'runtime/web/vendor/plotly-3.3.1.min.js',
]
GENERATED_EXCLUSIONS = [
    'fixtures/*.png', 'fixtures/**/*.png',
    'bootstrap-staging', 'transport',
    'target', 'node_modules', '.newsroom', 'outputs', '__pycache__', '**/__pycache__', '*.pyc', '**/*.pyc',
]


def sha(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()


def excluded(rel: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        pattern=pattern.replace('\\','/').rstrip('/')
        if rel == pattern or rel.startswith(pattern + '/') or fnmatch.fnmatch(rel, pattern): return True
    return False


def should_copy(rel: str) -> bool:
    if excluded(rel, GENERATED_EXCLUSIONS):
        return False
    if rel in PLOTLY_PATHS or rel in REGENERATED_V110:
        return False
    if rel in {f'fixtures/external/naturalearth_lowres/{name}' for name in NATURAL_EARTH}:
        return False
    return True


def safe_rel(name: str, strip_prefix: str | None = None) -> str:
    p=PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts:
        raise SystemExit(f'unsafe archive member: {name}')
    parts=list(p.parts)
    if strip_prefix and parts and parts[0] == strip_prefix:
        parts=parts[1:]
    if not parts:
        return ''
    rel=PurePosixPath(*parts).as_posix()
    if rel.startswith('../') or rel == '..':
        raise SystemExit(f'unsafe archive member: {name}')
    return rel


def safe_members(tf: tarfile.TarFile):
    for m in tf.getmembers():
        p=Path(m.name)
        if m.islnk() or m.issym() or p.is_absolute() or '..' in p.parts:
            raise SystemExit(f'unsafe archive member: {m.name}')
        if m.isfile():
            yield m


def copy_missing_from_tar(root: Path, archive: Path) -> tuple[int,int]:
    copied=preserved=0
    with tempfile.TemporaryDirectory() as td:
        tmp=Path(td)
        with tarfile.open(archive, 'r:*') as tf:
            members=list(safe_members(tf)); tf.extractall(tmp, members=members, filter='data')
        for src in sorted(p for p in tmp.rglob('*') if p.is_file()):
            rel=src.relative_to(tmp).as_posix()
            if not should_copy(rel):
                continue
            dst=root/rel
            if dst.exists():
                preserved += 1
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src,dst); copied += 1
    return copied,preserved


def copy_missing_from_zip(root: Path, archive: Path) -> tuple[int,int]:
    copied=preserved=0
    with zipfile.ZipFile(archive) as zf:
        infos=[i for i in zf.infolist() if not i.is_dir()]
        top_parts={PurePosixPath(i.filename).parts[0] for i in infos if PurePosixPath(i.filename).parts}
        strip_prefix=next(iter(top_parts)) if len(top_parts)==1 else None
        final: dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            rel=safe_rel(info.filename, strip_prefix)
            if rel:
                final[rel]=info
        for rel in sorted(final):
            if not should_copy(rel):
                continue
            dst=root/rel
            if dst.exists():
                preserved += 1
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(final[rel]) as src, dst.open('wb') as out:
                shutil.copyfileobj(src,out)
            copied += 1
    return copied,preserved


def copy_missing_from_archive(root: Path, archive: Path) -> tuple[int,int]:
    if zipfile.is_zipfile(archive):
        return copy_missing_from_zip(root, archive)
    if tarfile.is_tarfile(archive):
        return copy_missing_from_tar(root, archive)
    raise SystemExit(f'unsupported source archive format: {archive}')


def regenerate_v110(root: Path):
    generator = root/'scripts'/'build_v110_system_fixtures.py'
    if not generator.is_file():
        raise SystemExit(f'missing v110 fixture generator: {generator}')
    subprocess.run([sys.executable, str(generator)], cwd=root, check=True)
    for rel, expected in REGENERATED_V110.items():
        actual = sha(root/rel)
        if actual != expected:
            raise SystemExit(f'regenerated fixture hash mismatch for {rel}: expected {expected}, got {actual}')


def restore_file(src: Path, dst: Path, expected: str):
    actual=sha(src)
    if actual != expected: raise SystemExit(f'hash mismatch for {src}: expected {expected}, got {actual}')
    dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src,dst)
    if sha(dst) != expected: raise SystemExit(f'post-copy hash mismatch: {dst}')


def release_tree(root: Path, manifest_rel: str, receipt_rel: str, exclusions: list[str]):
    rows=[]
    for p in sorted(x for x in root.rglob('*') if x.is_file()):
        rel=p.relative_to(root).as_posix()
        if rel in {manifest_rel, receipt_rel} or rel.startswith('.git/') or excluded(rel, exclusions): continue
        rows.append((rel,sha(p)))
    h=hashlib.sha256()
    for rel,digest in rows:
        h.update(rel.encode('utf-8')); h.update(b'\0'); h.update(digest.encode('ascii')); h.update(b'\n')
    return rows,h.hexdigest()


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--root',default='.')
    ap.add_argument('--archive',required=True)
    ap.add_argument('--plotly-source',required=True)
    ap.add_argument('--natural-earth-dir',required=True)
    ap.add_argument('--upstream-archive-sha256',default='13a68016a7e129164555cd3a450364f871c14e92b1957ef1c9cce727cfe8632c')
    ap.add_argument('--manifest',default='source-integrity.json')
    args=ap.parse_args()
    root=Path(args.root).resolve(); archive=Path(args.archive).resolve()
    plotly=Path(args.plotly_source).resolve(); ne=Path(args.natural_earth_dir).resolve()
    copied,preserved=copy_missing_from_archive(root,archive)
    for rel in PLOTLY_PATHS: restore_file(plotly, root/rel, PLOTLY_SHA)
    for name,digest in NATURAL_EARTH.items(): restore_file(ne/name, root/'fixtures/external/naturalearth_lowres'/name, digest)
    regenerate_v110(root)
    manifest={
      'schema_version':'1.1.0',
      'import_strategy':'fill-missing-preserve-hardened-head',
      'file_count':0,
      'source_tree_sha256':'PENDING',
      'excluded_paths':GENERATED_EXCLUSIONS,
      'source_archive':{
        'name':archive.name,'sha256':sha(archive),
        'verification_evidence':'ci-evidence/source-import-verification.json',
        'upstream_hardening_archive_sha256':args.upstream_archive_sha256,
      },
      'restored_vendor_hashes':{
        PLOTLY_PATHS[0]:PLOTLY_SHA,PLOTLY_PATHS[1]:PLOTLY_SHA,
        **{f'fixtures/external/naturalearth_lowres/{k}':v for k,v in NATURAL_EARTH.items()},
      },
      'generated_visuals_excluded':True,
      'regenerated_fixture_hashes':REGENERATED_V110,
      'materialization':{'copied_missing_files':copied,'preserved_existing_files':preserved},
    }
    rows,digest=release_tree(root,args.manifest,manifest['source_archive']['verification_evidence'],manifest['excluded_paths'])
    manifest['file_count']=len(rows); manifest['source_tree_sha256']=digest
    (root/args.manifest).write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'materialization':manifest['materialization'],'file_count':len(rows),'source_tree_sha256':digest},sort_keys=True))
if __name__=='__main__': main()
