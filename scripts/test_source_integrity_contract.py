#!/usr/bin/env python3
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path

CHECK = Path(__file__).with_name('check_source_integrity.py')
UPDATE = Path(__file__).with_name('update_source_integrity.py')

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def tree(root, ignored):
    rows=[]
    for p in sorted(x for x in root.rglob('*') if x.is_file()):
        rel=p.relative_to(root).as_posix()
        if rel in ignored or rel.startswith('excluded/'): continue
        rows.append((rel,sha(p)))
    h=hashlib.sha256()
    for rel,digest in rows: h.update(rel.encode()+b'\0'+digest.encode()+b'\n')
    return rows,h.hexdigest()

def run(root,expect,archive=None):
    cmd=[sys.executable,str(CHECK),'--root',str(root),'--manifest',str(root/'source-integrity.json')]
    if archive is not None: cmd += ['--archive',str(archive)]
    p=subprocess.run(cmd,capture_output=True,text=True)
    assert p.returncode==expect,(p.stdout,p.stderr)
    return json.loads(p.stdout)

with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as ad:
    root=Path(td); archive=Path(ad)/'source.tar'
    (root/'src').mkdir(); (root/'vendor').mkdir(); (root/'generated').mkdir(); (root/'excluded').mkdir(); (root/'ci-evidence').mkdir()
    (root/'src/a.txt').write_text('alpha\n')
    (root/'vendor/pinned.js').write_text('vendor\n')
    (root/'generated/fixture.json').write_text('{"deterministic":true}\n')
    (root/'excluded/cache.bin').write_bytes(b'x')
    archive.write_bytes(b'archive')
    evidence_rel='ci-evidence/source-import-verification.json'; ignored={'source-integrity.json',evidence_rel}
    rows,digest=tree(root,ignored)
    manifest={
      'schema_version':'2.1.0','file_count':len(rows),'source_tree_sha256':digest,'excluded_paths':['excluded'],
      'source_archive':{'name':'source.tar','sha256':sha(archive),'verification_evidence':evidence_rel},
      'restored_vendor_hashes':{'vendor/pinned.js':sha(root/'vendor/pinned.js')},
      'regenerated_fixture_hashes':{'generated/fixture.json':sha(root/'generated/fixture.json')},
    }
    (root/'source-integrity.json').write_text(json.dumps(manifest))
    first=run(root,0,archive)
    assert first['archive_verification']['mode']=='recomputed'
    assert first['restored_vendor_count']==1 and first['regenerated_fixture_count']==1
    assert run(root,0)['archive_verification']['mode']=='receipt'

    (root/'src/a.txt').write_text('tampered\n'); assert run(root,2)['status']=='FAIL'; (root/'src/a.txt').write_text('alpha\n')
    (root/'vendor/pinned.js').write_text('tampered\n'); vendor_fail=run(root,2); assert any('restored vendor sha256 mismatch' in e for e in vendor_fail['errors']); (root/'vendor/pinned.js').write_text('vendor\n')
    (root/'generated/fixture.json').write_text('{"deterministic":false}\n'); generated_fail=run(root,2); assert any('regenerated fixture sha256 mismatch' in e for e in generated_fail['errors']); (root/'generated/fixture.json').write_text('{"deterministic":true}\n')

    receipt=json.loads((root/evidence_rel).read_text()); receipt['archive_sha256']='0'*64; (root/evidence_rel).write_text(json.dumps(receipt)); assert run(root,2)['status']=='FAIL'
    (root/evidence_rel).unlink(); bad_archive=Path(ad)/'bad.tar'; bad_archive.write_bytes(b'wrong'); assert run(root,2,bad_archive)['status']=='FAIL'

with tempfile.TemporaryDirectory() as td:
    root=Path(td); (root/'src').mkdir(); (root/'ci-evidence').mkdir()
    (root/'src/a.txt').write_text('alpha\\n')
    (root/'release-manifest.json').write_text('derived\\n')
    manifest={
      'schema_version':'2.1.0','file_count':0,'source_tree_sha256':'0'*64,
      'excluded_paths':['release-manifest.json'],
      'source_archive':{'name':'source.tar','sha256':'a'*64,'verification_evidence':'ci-evidence/source-import-verification.json'},
      'restored_vendor_hashes':{},'regenerated_fixture_hashes':{},
    }
    (root/'source-integrity.json').write_text(json.dumps(manifest))
    proc=subprocess.run([sys.executable,str(UPDATE),'--root',str(root),'--manifest','source-integrity.json'],capture_output=True,text=True)
    assert proc.returncode==0,(proc.stdout,proc.stderr)
    manifest_text=(root/'source-integrity.json').read_text()
    assert manifest_text.endswith('\n') and not manifest_text.endswith('\\\\n')
    updated=json.loads(manifest_text)
    before=updated['source_tree_sha256']
    (root/'release-manifest.json').write_text('derived changed\\n')
    proc2=subprocess.run([sys.executable,str(UPDATE),'--root',str(root),'--manifest','source-integrity.json'],capture_output=True,text=True)
    assert proc2.returncode==0,(proc2.stdout,proc2.stderr)
    updated2=json.loads((root/'source-integrity.json').read_text())
    assert updated2['source_tree_sha256']==before

print(json.dumps({'status':'PASS','tree_tamper_detection':True,'vendor_hash_gate':True,'regenerated_fixture_hash_gate':True,'archive_recompute_gate':True,'archive_receipt_gate':True,'source_integrity_update_round_trip':True,'release_manifest_excluded_from_source_tree':True,'transport_not_required_in_release_tree':True}))
