import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_RESULT_BUDGETS = Object.freeze({
  network: 128 * 1024,
  data: 1024 * 1024,
  local: 256 * 1024,
  browser: 256 * 1024,
  default: 128 * 1024,
});

export const DEFAULT_BATCH_OUTPUT_BUDGET = 512 * 1024;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter(Boolean))];
}

function normalizeWriteScopePath(value, taskId) {
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.includes('\0')) throw new Error(`task ${taskId}: write_scope contains NUL`);
  const candidate = raw.replaceAll('\\', '/');
  if (candidate.startsWith('/') || candidate.startsWith('//') || /^[A-Za-z]:\//.test(candidate)) {
    throw new Error(`task ${taskId}: write_scope must be relative: ${raw}`);
  }
  const parts = [];
  for (const part of candidate.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`task ${taskId}: write_scope traversal is not allowed: ${raw}`);
    parts.push(part);
  }
  return parts.length ? parts.join('/') : '.';
}

function normalizeWriteScopes(value, taskId) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const scope = normalizeWriteScopePath(item, taskId);
    if (scope != null && !normalized.includes(scope)) normalized.push(scope);
  }
  return normalized;
}

function defaultResourceClass(kind) {
  const name = String(kind).toLowerCase();
  if (/(fetch|download|news_search|http|curl|url)/.test(name)) return 'network';
  if (/(duckdb|sqlite|query|sql)/.test(name)) return 'data';
  if (/(browser|render|preview|vision|chart|visual|map|publication)/.test(name)) return 'browser';
  if (/(local|metadata|hash|plist|textutil|sips|mdfind|mdls|file)/.test(name)) return 'local';
  return 'default';
}

function deriveNetworkKey(raw) {
  for (const candidate of [raw.url, raw.href, raw.endpoint]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(String(candidate));
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
        return `network:${parsed.hostname.toLowerCase()}`;
      }
    } catch {
      // Invalid URLs are handled by the underlying tool; scheduler stays conservative.
    }
  }
  return 'network:unknown';
}

function classifyTask(raw, kind, customClassifier) {
  const base = { resource_class: defaultResourceClass(kind), resource_key: null };
  const custom = typeof customClassifier === 'function' ? customClassifier({ ...raw, kind }) : null;
  const resourceClass = custom && custom.resource_class ? String(custom.resource_class) : base.resource_class;
  let resourceKey = custom && custom.resource_key != null ? String(custom.resource_key) : null;
  if (resourceClass === 'network' && resourceKey == null) resourceKey = deriveNetworkKey(raw);
  return { resource_class: resourceClass, resource_key: resourceKey };
}

function normalizeTask(raw, index, customClassifier) {
  if (!raw || typeof raw !== 'object') throw new Error(`task ${index}: expected an object`);
  const id = String(raw.id ?? '').trim();
  if (!id) throw new Error(`task ${index}: id is required`);
  const kind = String(raw.kind ?? raw.tool ?? 'unknown');
  const classification = classifyTask(raw, kind, customClassifier);
  return {
    ...raw,
    id,
    kind,
    depends_on: normalizeStringArray(raw.depends_on),
    resource_class: classification.resource_class,
    resource_key: classification.resource_key,
    requested_resource_class: raw.resource_class == null ? null : String(raw.resource_class),
    requested_resource_key: raw.resource_key == null ? null : String(raw.resource_key),
    write_scope: normalizeWriteScopes(raw.write_scope ?? raw.write_scopes, id),
  };
}

function scopesConflict(a, b) {
  if (!a.length || !b.length) return false;
  for (const left of a) {
    for (const right of b) {
      if (left === '.' || right === '.') return true;
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) return true;
    }
  }
  return false;
}

function validateGraph(tasks) {
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) throw new Error(`task ${task.id}: unknown dependency ${dep}`);
      if (dep === task.id) throw new Error(`task ${task.id}: self dependency`);
    }
  }
  const indegree = new Map(tasks.map((task) => [task.id, task.depends_on.length]));
  const dependents = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dep of task.depends_on) dependents.get(dep).push(task.id);
  }
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const dependent of dependents.get(id)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== tasks.length) {
    const cyclic = tasks.filter((task) => indegree.get(task.id) > 0).map((task) => task.id);
    throw new Error(`task graph contains cycle: ${cyclic.join(',')}`);
  }
}

function serialized(value) {
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function persistJsonArtifact(root, prefix, value) {
  const text = serialized(value);
  const digest = sha256(text);
  if (!root) return { path: null, sha256: digest };
  const rel = `runtime/parallel-results/${prefix}-${digest}.json`;
  const path = join(root, rel);
  await mkdir(join(root, 'runtime', 'parallel-results'), { recursive: true });
  try {
    await writeFile(path, `${text}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = (await readFile(path, 'utf8')).trimEnd();
    if (sha256(existing) !== digest) throw new Error(`parallel result artifact collision: ${rel}`);
  }
  return { path: rel, sha256: digest };
}

function compactEnvelope(base, previewSource, cap) {
  const minimum = { ...base, preview_json: '' };
  if (byteLength(serialized(minimum)) > cap) return minimum;
  let previewBytes = Math.max(0, cap - byteLength(serialized(minimum)) - 128);
  let preview = Buffer.from(previewSource, 'utf8').subarray(0, previewBytes).toString('utf8');
  let candidate = { ...base, preview_json: preview };
  while (byteLength(serialized(candidate)) > cap && previewBytes > 0) {
    previewBytes = Math.floor(previewBytes * 0.75);
    preview = Buffer.from(previewSource, 'utf8').subarray(0, previewBytes).toString('utf8');
    candidate = { ...base, preview_json: preview };
  }
  return candidate;
}

async function applyTaskOutputBudget(task, value, options) {
  const budgets = { ...DEFAULT_RESULT_BUDGETS, ...(options.resultBudgets ?? {}) };
  const cap = positiveInt(budgets[task.resource_class], positiveInt(budgets.default, DEFAULT_RESULT_BUDGETS.default));
  const text = serialized(value);
  const originalBytes = byteLength(text);
  if (originalBytes <= cap) {
    return { value, truncated: false, original_bytes: originalBytes, returned_bytes: originalBytes, artifact_ref: null, sha256: sha256(text) };
  }
  const artifact = await persistJsonArtifact(options.artifactRoot, `task-${task.id}`, value);
  const base = {
    truncated: true,
    truncation_reason: 'parallel_task_output_budget',
    resource_class: task.resource_class,
    original_bytes: originalBytes,
    full_result_ref: artifact.path,
    full_result_sha256: artifact.sha256,
  };
  const bounded = compactEnvelope(base, text, cap);
  return {
    value: bounded,
    truncated: true,
    original_bytes: originalBytes,
    returned_bytes: byteLength(serialized(bounded)),
    artifact_ref: artifact.path,
    sha256: artifact.sha256,
  };
}

function resourceStatsRow(map, resourceClass) {
  if (!map.has(resourceClass)) {
    map.set(resourceClass, { started: 0, completed: 0, failed: 0, total_duration_ms: 0, peak_concurrency: 0 });
  }
  return map.get(resourceClass);
}

function objectFromSortedMap(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function applyAggregateBudget(results, rawResults, taskById, options) {
  const cap = positiveInt(options.batchOutputBudget, DEFAULT_BATCH_OUTPUT_BUDGET);
  const text = serialized(results);
  const originalBytes = byteLength(text);
  if (originalBytes <= cap) {
    return { results, truncated: false, original_bytes: originalBytes, returned_bytes: originalBytes, artifact_ref: null, sha256: sha256(text) };
  }
  const artifact = await persistJsonArtifact(options.artifactRoot, 'batch', rawResults);
  const compacted = {};
  for (const [id, value] of Object.entries(results)) {
    const task = taskById.get(id);
    compacted[id] = compactEnvelope({
      truncated: true,
      truncation_reason: 'parallel_batch_output_budget',
      task_id: id,
      resource_class: task?.resource_class ?? 'default',
      full_batch_ref: artifact.path,
      full_batch_sha256: artifact.sha256,
    }, serialized(value), Math.max(2048, Math.floor(cap / Math.max(1, Object.keys(results).length))));
  }
  let returnedBytes = byteLength(serialized(compacted));
  if (returnedBytes > cap) {
    for (const id of Object.keys(compacted)) delete compacted[id].preview_json;
    returnedBytes = byteLength(serialized(compacted));
  }
  if (returnedBytes > cap) throw new Error(`parallel aggregate output metadata exceeds ${cap} bytes`);
  return {
    results: compacted,
    truncated: true,
    original_bytes: originalBytes,
    returned_bytes: returnedBytes,
    artifact_ref: artifact.path,
    sha256: artifact.sha256,
  };
}

export async function runTaskDag(rawTasks, runner, options = {}) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error('tasks must be a non-empty array');
  if (typeof runner !== 'function') throw new Error('runner must be a function');
  const tasks = rawTasks.map((task, index) => normalizeTask(task, index, options.classifyTask));
  validateGraph(tasks);
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const maxConcurrency = positiveInt(options.maxConcurrency, 6);
  const resourceLimits = { ...(options.resourceLimits ?? {}) };
  const keyLimits = { ...(options.keyLimits ?? {}) };
  const emit = typeof options.emit === 'function' ? options.emit : async () => {};
  const artifactRoot = options.artifactRoot ?? process.env.NEWSROOM_ARTIFACT_DIR ?? null;
  const budgetOptions = { ...options, artifactRoot };
  const batchId = String(options.batchId ?? `batch-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
  const startedAt = Date.now();
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const running = new Map();
  const completed = new Map();
  const rawCompleted = new Map();
  const failed = new Map();
  const blocked = new Map();
  const resourceStats = new Map();
  const backendDistribution = new Map();
  let maxObservedParallelism = 0;
  let truncatedTaskResults = 0;
  const resourceCount = (resourceClass) => [...running.values()].filter((entry) => entry.task.resource_class === resourceClass).length;
  const keyCount = (resourceKey) => resourceKey == null ? 0 : [...running.values()].filter((entry) => entry.task.resource_key === resourceKey).length;
  const resourceLimit = (resourceClass) => positiveInt(resourceLimits[resourceClass], maxConcurrency);
  const keyLimit = (resourceKey) => {
    if (resourceKey == null) return maxConcurrency;
    if (keyLimits[resourceKey] != null) return positiveInt(keyLimits[resourceKey], maxConcurrency);
    return resourceKey.startsWith('network:') ? Math.min(2, maxConcurrency) : maxConcurrency;
  };
  const hasWriteConflict = (task) => [...running.values()].some((entry) => scopesConflict(task.write_scope, entry.task.write_scope));
  const eventBase = (task) => ({
    batch_id: batchId,
    task_id: task.id,
    kind: task.kind,
    resource_class: task.resource_class,
    resource_key: task.resource_key,
    requested_resource_class: task.requested_resource_class,
    requested_resource_key: task.requested_resource_key,
    depends_on: task.depends_on,
    write_scope: task.write_scope,
  });
  await emit({ type: 'newsroom_parallel_batch_start', batch_id: batchId, task_count: tasks.length, max_concurrency: maxConcurrency, ts_ms: startedAt });
  const startTask = async (task) => {
    pending.delete(task.id);
    const taskStarted = Date.now();
    const stats = resourceStatsRow(resourceStats, task.resource_class);
    stats.started += 1;
    stats.peak_concurrency = Math.max(stats.peak_concurrency, resourceCount(task.resource_class) + 1);
    await emit({ type: 'newsroom_task_started', ...eventBase(task), ts_ms: taskStarted, active_tasks: running.size + 1, active_resource_tasks: resourceCount(task.resource_class) + 1 });
    try {
      const rawValue = await runner(task);
      rawCompleted.set(task.id, rawValue);
      const bounded = await applyTaskOutputBudget(task, rawValue, budgetOptions);
      if (bounded.truncated) truncatedTaskResults += 1;
      completed.set(task.id, bounded.value);
      const completedAt = Date.now();
      const durationMs = completedAt - taskStarted;
      stats.completed += 1;
      stats.total_duration_ms += durationMs;
      const backend = rawValue && typeof rawValue === 'object' && 'backend' in rawValue ? String(rawValue.backend) : null;
      if (backend) backendDistribution.set(backend, (backendDistribution.get(backend) ?? 0) + 1);
      await emit({ type: 'newsroom_task_completed', ...eventBase(task), ts_ms: completedAt, duration_ms: durationMs, backend, output_truncated: bounded.truncated, output_original_bytes: bounded.original_bytes, output_returned_bytes: bounded.returned_bytes, full_result_ref: bounded.artifact_ref, full_result_sha256: bounded.sha256 });
      return bounded.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.set(task.id, message);
      const failedAt = Date.now();
      const durationMs = failedAt - taskStarted;
      stats.failed += 1;
      stats.total_duration_ms += durationMs;
      await emit({ type: 'newsroom_task_failed', ...eventBase(task), ts_ms: failedAt, duration_ms: durationMs, error: message });
      throw error;
    }
  };
  while (pending.size || running.size) {
    for (const task of [...pending.values()]) {
      const badDep = task.depends_on.find((dep) => failed.has(dep) || blocked.has(dep));
      if (!badDep) continue;
      pending.delete(task.id);
      const reason = `dependency ${badDep} did not complete successfully`;
      blocked.set(task.id, reason);
      await emit({ type: 'newsroom_task_blocked', ...eventBase(task), ts_ms: Date.now(), reason });
    }
    for (const task of [...pending.values()]) {
      if (running.size >= maxConcurrency) break;
      if (!task.depends_on.every((dep) => completed.has(dep))) continue;
      if (resourceCount(task.resource_class) >= resourceLimit(task.resource_class)) continue;
      if (task.resource_key != null && keyCount(task.resource_key) >= keyLimit(task.resource_key)) continue;
      if (hasWriteConflict(task)) continue;
      const promise = startTask(task).catch(() => undefined).finally(() => running.delete(task.id));
      running.set(task.id, { task, promise });
      maxObservedParallelism = Math.max(maxObservedParallelism, running.size);
    }
    if (running.size) {
      await Promise.race([...running.values()].map((entry) => entry.promise));
      continue;
    }
    if (pending.size) {
      const unresolved = [...pending.values()].map((task) => `${task.id}<-[${task.depends_on.join(',')}]`).join('; ');
      throw new Error(`task graph is unschedulable: ${unresolved}`);
    }
  }
  const endedAt = Date.now();
  const status = failed.size || blocked.size ? 'partial' : 'ok';
  const orderedIds = [...taskOrder.keys()];
  const completedIds = orderedIds.filter((id) => completed.has(id));
  const failedRows = orderedIds.filter((id) => failed.has(id)).map((id) => ({ id, error: failed.get(id) }));
  const blockedRows = orderedIds.filter((id) => blocked.has(id)).map((id) => ({ id, reason: blocked.get(id) }));
  const results = {};
  const rawResults = {};
  for (const id of completedIds) {
    results[id] = completed.get(id);
    rawResults[id] = rawCompleted.get(id);
  }
  const aggregate = await applyAggregateBudget(results, rawResults, taskById, budgetOptions);
  const resourceStatsObject = objectFromSortedMap(resourceStats);
  const backendDistributionObject = objectFromSortedMap(backendDistribution);
  const durationMs = endedAt - startedAt;
  const outputBudget = {
    per_task_truncated: truncatedTaskResults,
    batch_truncated: aggregate.truncated,
    aggregate_original_bytes: aggregate.original_bytes,
    aggregate_returned_bytes: aggregate.returned_bytes,
    aggregate_limit_bytes: positiveInt(options.batchOutputBudget, DEFAULT_BATCH_OUTPUT_BUDGET),
    full_batch_ref: aggregate.artifact_ref,
    full_batch_sha256: aggregate.sha256,
  };
  await emit({ type: 'newsroom_parallel_batch_end', batch_id: batchId, ts_ms: endedAt, duration_ms: durationMs, status, completed_tasks: completed.size, failed_tasks: failed.size, blocked_tasks: blocked.size, max_observed_parallelism: maxObservedParallelism, resource_stats: resourceStatsObject, backend_distribution: backendDistributionObject, output_budget: outputBudget });
  return {
    batch_id: batchId,
    status,
    task_count: tasks.length,
    completed: completedIds,
    failed: failedRows,
    blocked: blockedRows,
    results: aggregate.results,
    max_observed_parallelism: maxObservedParallelism,
    duration_ms: durationMs,
    resource_stats: resourceStatsObject,
    backend_distribution: backendDistributionObject,
    output_budget: outputBudget,
  };
}
