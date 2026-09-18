import { spawn, execFileSync } from 'node:child_process';

// Kill descendants before the parent, including grandchildren holding pipes open.
function killTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    // Start every controlled child in its own process group. Killing the
    // group closes a reliable escape path for grandchildren that inherit the
    // stdout/stderr pipes and otherwise keep the parent alive.
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try {
      const rows = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4_000_000 });
      const pairs = rows.trim().split('\n').map(r => r.trim().split(/\s+/).map(Number));
      const visit = pid => { for (const [id, parent] of pairs) if (parent === pid) { visit(id); try { process.kill(id, 'SIGKILL'); } catch {} } };
      visit(child.pid);
    } catch { /* Parent kill is still mandatory if process enumeration fails. */ }
  }
  child.kill('SIGKILL');
}

/** Bounded shared executor. Error messages deliberately exclude command arguments/output. */
export function runProcess(bin, args, signal, cwd, input, stdoutLimit = 1_000_000, timeoutMs = 20_000, allowFailure = false) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(stdoutLimit) || stdoutLimit <= 0) {
      reject(new Error('Invalid process limits')); return;
    }
    if (signal?.aborted) { reject(new Error('Process cancelled')); return; }
    const child = spawn(bin, args, { cwd, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let outBytes = 0, errBytes = 0, failure, done = false, killDeadline;
    const finish = (code) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(killDeadline);
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(new Error(failure));
      else if (code !== 0 && !allowFailure) reject(new Error(`Process exited with code ${code}`));
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code });
    };
    const stop = reason => {
      if (failure || done) return;
      failure = reason; killTree(child);
      // Even an escaped descendant retaining inherited pipes cannot hang this promise.
      killDeadline = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 1500);
    };
    const timer = setTimeout(() => stop('Process execution timeout'), timeoutMs);
    const onAbort = () => stop('Process cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > stdoutLimit) stop('Process stdout limit exceeded');
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      errBytes += chunk.length;
      if (errBytes > 100_000) stop('Process stderr limit exceeded');
      else stderr.push(chunk);
    });
    child.on('error', () => { failure = 'Process failed to start'; finish(null); });
    child.on('close', finish);
    if (child.stdin) {
      child.stdin.on('error', () => stop('Process input failed'));
      child.stdin.end(input);
    }
  });
}
