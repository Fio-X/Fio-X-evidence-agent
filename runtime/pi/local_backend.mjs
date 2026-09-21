import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const NATIVE = Object.freeze({
  mdls: '/usr/bin/mdls',
  mdfind: '/usr/bin/mdfind',
  textutil: '/usr/bin/textutil',
  sips: '/usr/bin/sips',
  qlmanage: '/usr/bin/qlmanage',
  sqlite3: '/usr/bin/sqlite3',
  curl: '/usr/bin/curl',
  file: '/usr/bin/file',
  shasum: '/usr/bin/shasum',
  plutil: '/usr/bin/plutil',
});

const PLAIN_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.rs', '.toml', '.ini', '.cfg', '.sql', '.log',
]);

function artifactRoot() {
  return path.resolve(process.env.NEWSROOM_ARTIFACT_DIR || process.cwd());
}

function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

async function resolveSandboxPath(input, { mustExist = true } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path must be a non-empty string');
  const root = artifactRoot();
  const candidate = path.resolve(root, input);
  if (!within(root, candidate)) throw new Error(`path escapes NEWSROOM_ARTIFACT_DIR: ${input}`);
  if (!mustExist) return candidate;
  const resolved = await realpath(candidate);
  const resolvedRoot = await realpath(root).catch(() => root);
  if (!within(resolvedRoot, resolved)) throw new Error(`resolved path escapes NEWSROOM_ARTIFACT_DIR: ${input}`);
  return resolved;
}

async function available(binary) {
  try {
    await access(binary);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(binary, args, { timeoutMs = 10_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const overflow = (stream) => {
      child.kill('SIGKILL');
      finish(reject, new Error(`${path.basename(binary)} ${stream} exceeded ${maxBytes} bytes`));
    };
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) return overflow('stdout');
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes > maxBytes) return overflow('stderr');
      err.push(chunk);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) return finish(resolve, { stdout, stderr, code, signal });
      finish(reject, new Error(`${path.basename(binary)} exited ${code ?? signal}: ${stderr.trim() || stdout.trim()}`));
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`${path.basename(binary)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

export async function localBackendStatus() {
  const tools = {};
  for (const [name, binary] of Object.entries(NATIVE)) {
    tools[name] = process.platform === 'darwin' && await available(binary);
  }
  return {
    platform: process.platform,
    local_first: process.platform === 'darwin',
    artifact_root: artifactRoot(),
    tools,
  };
}

export async function localMetadata(input) {
  const target = await resolveSandboxPath(input);
  const st = await lstat(target);
  if (process.platform === 'darwin' && await available(NATIVE.mdls)) {
    try {
      const { stdout } = await runCommand(NATIVE.mdls, [
        '-name', 'kMDItemFSName',
        '-name', 'kMDItemContentType',
        '-name', 'kMDItemFSSize',
        '-name', 'kMDItemContentModificationDate',
        target,
      ]);
      return { backend: 'macos:mdls', path: target, size: st.size, metadata: stdout.trim() };
    } catch { /* fall through */ }
  }
  if (process.platform === 'darwin' && await available(NATIVE.file)) {
    try {
      const { stdout } = await runCommand(NATIVE.file, ['-b', '--mime-type', target]);
      return { backend: 'macos:file', path: target, size: st.size, mime_type: stdout.trim() };
    } catch { /* fall through */ }
  }
  return {
    backend: 'portable:stat',
    path: target,
    size: st.size,
    mtime_ms: st.mtimeMs,
    mode: st.mode,
    is_file: st.isFile(),
    is_directory: st.isDirectory(),
  };
}

async function portableSha256(target) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function localHash(input) {
  const target = await resolveSandboxPath(input);
  if (process.platform === 'darwin' && await available(NATIVE.shasum)) {
    try {
      const { stdout } = await runCommand(NATIVE.shasum, ['-a', '256', target]);
      const digest = stdout.trim().split(/\s+/)[0];
      if (/^[0-9a-f]{64}$/i.test(digest)) return { backend: 'macos:shasum', path: target, algorithm: 'sha256', digest };
    } catch { /* fall through */ }
  }
  return { backend: 'portable:crypto', path: target, algorithm: 'sha256', digest: await portableSha256(target) };
}

function trimText(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

export async function localPlistJson(input, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const target = await resolveSandboxPath(input);
  if (process.platform !== 'darwin' || !(await available(NATIVE.plutil))) {
    throw new Error('plutil is only available on the macOS local backend');
  }
  const { stdout } = await runCommand(NATIVE.plutil, ['-convert', 'json', '-o', '-', target], { maxBytes });
  const clipped = trimText(stdout, maxBytes);
  return { backend: 'macos:plutil', path: target, ...clipped };
}

export async function localText(input, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const target = await resolveSandboxPath(input);
  const ext = path.extname(target).toLowerCase();
  if (PLAIN_TEXT_EXTENSIONS.has(ext) || ext === '') {
    const raw = await readFile(target, 'utf8');
    return { backend: 'portable:fs', path: target, ...trimText(raw, maxBytes) };
  }
  if (process.platform === 'darwin' && ext === '.plist' && await available(NATIVE.plutil)) {
    return await localPlistJson(input, { maxBytes });
  }
  if (process.platform === 'darwin' && await available(NATIVE.textutil)) {
    const { stdout } = await runCommand(NATIVE.textutil, ['-convert', 'txt', '-stdout', target], { maxBytes });
    return { backend: 'macos:textutil', path: target, ...trimText(stdout, maxBytes) };
  }
  throw new Error(`no safe local text extractor for ${ext || 'this file type'}`);
}

export async function localImageInfo(input) {
  const target = await resolveSandboxPath(input);
  if (process.platform === 'darwin' && await available(NATIVE.sips)) {
    const { stdout } = await runCommand(NATIVE.sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', target]);
    return { backend: 'macos:sips', path: target, metadata: stdout.trim() };
  }
  const st = await lstat(target);
  return { backend: 'portable:stat', path: target, size: st.size, note: 'image dimensions require macOS sips' };
}

async function walkNames(root, query, limit) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  async function visit(dir) {
    if (results.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (tokens.every((token) => entry.name.toLowerCase().includes(token))) results.push(full);
    }
  }
  await visit(root);
  return results;
}

export async function localSpotlight(query, { limit = 50 } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query must be non-empty');
  const root = artifactRoot();
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
  if (process.platform === 'darwin' && await available(NATIVE.mdfind)) {
    try {
      const { stdout } = await runCommand(NATIVE.mdfind, ['-onlyin', root, query], { maxBytes: 2 * 1024 * 1024 });
      const results = stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).filter((p) => within(root, path.resolve(p))).slice(0, capped);
      if (results.length) return { backend: 'macos:mdfind', query, root, results };
    } catch { /* fall through */ }
  }
  return { backend: 'portable:filename-walk', query, root, results: await walkNames(root, query, capped) };
}

function safeReadOnlySql(sql) {
  const normalized = String(sql || '').trim().replace(/^--.*$/gm, '').trim();
  return /^(select|with|pragma\s+(table_info|table_list|index_list|index_info)\b)/i.test(normalized) && !/\b(attach|detach|insert|update|delete|replace|create|drop|alter|vacuum|reindex)\b/i.test(normalized);
}

function boundedRows(rows, maxBytes, maxRows) {
  const limited = rows.slice(0, maxRows);
  const preview = [];
  let bytes = 2;
  for (const row of limited) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + (preview.length ? 1 : 0);
    if (bytes + rowBytes > maxBytes) break;
    preview.push(row);
    bytes += rowBytes;
  }
  return { rows: preview, bytes, truncated: preview.length < rows.length };
}

export async function localSqliteQuery(input, sql, { maxBytes = 4 * 1024 * 1024, maxRows = Number.MAX_SAFE_INTEGER } = {}) {
  const target = await resolveSandboxPath(input);
  if (!safeReadOnlySql(sql)) throw new Error('local_sqlite_query accepts read-only SELECT/WITH or safe metadata PRAGMA statements');
  if (process.platform !== 'darwin' || !(await available(NATIVE.sqlite3))) {
    throw new Error('sqlite3 is only available on the macOS local backend');
  }
  const { stdout } = await runCommand(NATIVE.sqlite3, ['-readonly', '-json', target, String(sql)], {
    // The budget applies to the returned preview, not to the local computation.
    // Keep the process-side parse bounded while allowing enough room to count rows.
    maxBytes: Math.max(maxBytes, 16 * 1024 * 1024),
    timeoutMs: 30_000,
  });
  let rows;
  try { rows = stdout.trim() ? JSON.parse(stdout) : []; }
  catch { rows = stdout.trim(); }
  if (!Array.isArray(rows)) return { backend: 'macos:sqlite3', path: target, rows };
  if (maxRows === Number.MAX_SAFE_INTEGER && maxBytes >= 4 * 1024 * 1024) {
    return { backend: 'macos:sqlite3', path: target, rows };
  }
  const bounded = boundedRows(rows, Math.max(1, Math.trunc(maxBytes)), Math.max(1, Math.trunc(maxRows)));
  return {
    backend: 'macos:sqlite3',
    path: target,
    rows: bounded.rows,
    total_rows: rows.length,
    preview_bytes: bounded.bytes,
    truncated: bounded.truncated,
  };
}
