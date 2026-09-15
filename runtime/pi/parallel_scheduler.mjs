function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter(Boolean))];
}

function normalizeTask(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`task ${index}: expected an object`);
  const id = String(raw.id ?? '').trim();
  if (!id) throw new Error(`task ${index}: id is required`);
  return {
    ...raw,
    id,
    kind: String(raw.kind ?? raw.tool ?? 'unknown'),
    depends_on: normalizeStringArray(raw.depends_on),
    resource_class: String(raw.resource_class ?? 'default'),
    resource_key: raw.resource_key == null ? null : String(raw.resource_key),
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
}

export async function runTaskDag(rawTasks, runner, options = {}) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error('tasks must be a non-empty array');
  if (typeof runner !== 'function') throw new Error('runner must be a function');

  const tasks = rawTasks.map(normalizeTask);
  validateGraph(tasks);

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
      await emit({
        type: 'newsroom_task_completed',
        ...eventBase(task),
        ts_ms: Date.now(),
        duration_ms: Date.now() - taskStarted,
        backend: value && typeof value === 'object' && 'backend' in value ? String(value.backend) : null,
      });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.set(task.id, message);
      await emit({ type: 'newsroom_task_failed', ...eventBase(task), ts_ms: Date.now(), duration_ms: Date.now() - taskStarted, error: message });
      throw error;
    }
  };

  while (pending.size || running.size) {
    let progressed = false;

    for (const task of [...pending.values()]) {
      const badDep = task.depends_on.find((dep) => failed.has(dep) || blocked.has(dep));
      if (!badDep) continue;
      pending.delete(task.id);
      const reason = `dependency ${badDep} did not complete successfully`;
      blocked.set(task.id, reason);
      await emit({ type: 'newsroom_task_blocked', ...eventBase(task), ts_ms: Date.now(), reason });
      progressed = true;
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
      progressed = true;
    }

    if (running.size) {
      await Promise.race([...running.values()].map((entry) => entry.promise));
      continue;
    }

    if (pending.size) {
      const unresolved = [...pending.values()].map((task) => `${task.id}<-[${task.depends_on.join(',')}]`).join('; ');
      throw new Error(`task graph is cyclic or unschedulable: ${unresolved}`);
    }

    if (!progressed) break;
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

  return {
    batch_id: batchId,
    status,
    task_count: tasks.length,
    completed: [...completed.keys()],
    failed: [...failed.entries()].map(([id, error]) => ({ id, error })),
    blocked: [...blocked.entries()].map(([id, reason]) => ({ id, reason })),
    results: Object.fromEntries(completed),
    max_observed_parallelism: maxObservedParallelism,
    duration_ms: endedAt - startedAt,
  };
}
