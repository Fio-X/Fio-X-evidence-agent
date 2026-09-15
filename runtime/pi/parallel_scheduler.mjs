function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter(Boolean))];
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
  const explicit = raw.resource_key == null ? '' : String(raw.resource_key).trim();
  if (explicit.startsWith('network:') && explicit.length > 'network:'.length) return explicit;
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
    write_scope: normalizeStringArray(raw.write_scope),
  };
}

function scopesConflict(a, b) {
  if (!a.length || !b.length) return false;
  for (const left of a) {
    for (const right of b) {
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

export async function runTaskDag(rawTasks, runner, options = {}) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error('tasks must be a non-empty array');
  if (typeof runner !== 'function') throw new Error('runner must be a function');

  const tasks = rawTasks.map((task, index) => normalizeTask(task, index, options.classifyTask));
  validateGraph(tasks);
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));

  const maxConcurrency = positiveInt(options.maxConcurrency, 6);
  const resourceLimits = { ...(options.resourceLimits ?? {}) };
  const keyLimits = { ...(options.keyLimits ?? {}) };
  const emit = typeof options.emit === 'function' ? options.emit : async () => {};
  const batchId = String(options.batchId ?? `batch-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
  const startedAt = Date.now();

  const pending = new Map(tasks.map((task) => [task.id, task]));
  const running = new Map();
  const completed = new Map();
  const failed = new Map();
  const blocked = new Map();
  let maxObservedParallelism = 0;

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
    await emit({ type: 'newsroom_task_started', ...eventBase(task), ts_ms: taskStarted, active_tasks: running.size + 1 });
    try {
      const value = await runner(task);
      completed.set(task.id, value);
      const completedAt = Date.now();
      await emit({
        type: 'newsroom_task_completed',
        ...eventBase(task),
        ts_ms: completedAt,
        duration_ms: completedAt - taskStarted,
        backend: value && typeof value === 'object' && 'backend' in value ? String(value.backend) : null,
      });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.set(task.id, message);
      const failedAt = Date.now();
      await emit({ type: 'newsroom_task_failed', ...eventBase(task), ts_ms: failedAt, duration_ms: failedAt - taskStarted, error: message });
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

      const promise = startTask(task)
        .catch(() => undefined)
        .finally(() => running.delete(task.id));
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
  await emit({
    type: 'newsroom_parallel_batch_end',
    batch_id: batchId,
    ts_ms: endedAt,
    duration_ms: endedAt - startedAt,
    status,
    completed_tasks: completed.size,
    failed_tasks: failed.size,
    blocked_tasks: blocked.size,
    max_observed_parallelism: maxObservedParallelism,
  });

  const orderedIds = [...taskOrder.keys()];
  const completedIds = orderedIds.filter((id) => completed.has(id));
  const failedRows = orderedIds.filter((id) => failed.has(id)).map((id) => ({ id, error: failed.get(id) }));
  const blockedRows = orderedIds.filter((id) => blocked.has(id)).map((id) => ({ id, reason: blocked.get(id) }));
  const results = {};
  for (const id of completedIds) results[id] = completed.get(id);

  return {
    batch_id: batchId,
    status,
    task_count: tasks.length,
    completed: completedIds,
    failed: failedRows,
    blocked: blockedRows,
    results,
    max_observed_parallelism: maxObservedParallelism,
    duration_ms: endedAt - startedAt,
  };
}
