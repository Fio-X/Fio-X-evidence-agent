import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { duckdbBundledExtensionArgs } from '../runtime/pi/computation_rows.mjs';

const DUCK = process.env.NEWSROOM_DUCKDB_BIN || 'duckdb';
const have = spawnSync(DUCK, ['--version']);
if (have.status !== 0) { console.log('SKIP duckdb binary not found'); process.exit(process.env.NEWSROOM_REQUIRE_NO_SKIP === '1' ? 1 : 0); }
const version = String(have.stdout).match(/v[\d.]+/)?.[0];
const work = mkdtempSync(join(tmpdir(), 'duckdb-ext-test-'));
try {
  // Off (anything but exactly "1"): no arguments, so the command line is unchanged.
  for (const v of [undefined, '', '0', 'true', ' 1', '11']) assert.deepEqual(duckdbBundledExtensionArgs(v, work), [], String(v));
  // On: an unusable directory is an error, never a silent fallback.
  for (const dir of [undefined, '', 'relative/dir', `${work}'x`]) assert.throws(() => duckdbBundledExtensionArgs('1', dir), /DUCKDB_BUNDLED_EXT_MISSING/);
  const args = duckdbBundledExtensionArgs('1', work);
  assert.ok(args.includes('LOAD excel') && !args.some((a) => /httpfs|spatial/.test(a)) && args.includes('SET autoinstall_known_extensions = false') && args.includes('SET autoload_known_extensions = false'));

  // The fetch script: hash mismatch fails and leaves nothing; a good local .gz unpacks to the pinned layout.
  const installed = join(homedir(), '.duckdb', 'extensions', version ?? '', 'osx_arm64', 'excel.duckdb_extension');
  const fetchPy = new URL('./fetch_duckdb_ext.py', import.meta.url).pathname;
  const bad = join(work, 'bad.gz'); writeFileSync(bad, zlib.gzipSync(Buffer.from('not an extension')));
  const out1 = join(work, 'out-bad');
  const r = spawnSync('python3', ['-I', fetchPy, '--out', out1, '--from-gz', bad], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /sha256 mismatch/); assert.equal(existsSync(out1), false);
  const unknown = spawnSync('python3', ['-I', fetchPy, '--out', join(work, 'o2'), '--platform', 'linux_amd64', '--from-gz', bad], { encoding: 'utf8' });
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /no pinned sha256/);

  if (process.platform === 'darwin' && process.arch === 'arm64' && version === 'v1.5.5' && existsSync(installed)) {
    const good = join(work, 'good.gz'); writeFileSync(good, zlib.gzipSync(readFileSync(installed)));
    const out = join(work, 'ext');
    const ok = spawnSync('python3', ['-I', fetchPy, '--out', out, '--from-gz', good], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(out, 'v1.5.5', 'osx_arm64', 'excel.duckdb_extension')));
    assert.equal(spawnSync('python3', ['-I', fetchPy, '--out', out, '--from-gz', good], { encoding: 'utf8' }).status, 1); // not empty

    // A tiny local xlsx, built by hand.
    const data = join(work, 'run', 'data'); mkdirSync(data, { recursive: true });
    const xlsx = join(data, 't.xlsx');
    execFileSync('python3', ['-I', '-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
z.writestr('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
z.writestr('xl/workbook.xml','<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
z.writestr('xl/_rels/workbook.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
z.writestr('xl/worksheets/sheet1.xml','<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>country</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2"><v>1.5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>B</t></is></c><c r="B3"><v>2.5</v></c></row></sheetData></worksheet>')
z.close()`, xlsx]);
    // The same command-line shape queryDuckDb builds: bundled args, allowed directory, external access off, locked.
    const base = (extra, sql) => ['-json', ':memory:', ...extra, '-cmd', `SET allowed_directories = ['${data}']`, '-cmd', 'SET enable_external_access = false', '-cmd', 'SET allow_community_extensions = false', '-cmd', 'SET lock_configuration = true', '-c', sql];
    const home = join(work, 'home'); mkdirSync(home);
    const run = (extra, sql) => spawnSync(DUCK, base(extra, sql), { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    const on = duckdbBundledExtensionArgs('1', out);
    const q = `SELECT * FROM read_xlsx('${xlsx}')`;
    const read = run(on, q);
    assert.equal(read.status, 0, read.stderr); assert.deepEqual(JSON.parse(read.stdout).map((x) => x.country), ['A', 'B']);
    // A bundle directory that does not exist fails in LOAD, not silently.
    assert.notEqual(run(duckdbBundledExtensionArgs('1', join(work, 'nope')), q).status, 0);
    // Off: the original refusal, unchanged.
    const off = run([], q);
    assert.notEqual(off.status, 0); assert.match(off.stderr, /disabled by configuration|Extension|Catalog/i);
    // With the bundle on, SQL that tries to install, load or reconfigure is still refused (and nothing lands in HOME).
    for (const sql of ['INSTALL spatial', 'LOAD spatial', 'INSTALL httpfs', `LOAD '${join(out, 'other.duckdb_extension')}'`, "SET extension_directory = '/tmp'", 'SET autoinstall_known_extensions = true']) {
      const res = run(on, sql); assert.notEqual(res.status, 0, sql);
    }
    assert.equal(existsSync(join(home, '.duckdb')), false);
  } else console.log('note: reading test skipped (needs v1.5.5 osx_arm64 with the extension installed once)');
  console.log('duckdb bundled extension tests ok');
} finally { rmSync(work, { recursive: true, force: true }); }
