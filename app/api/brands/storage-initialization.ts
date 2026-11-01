const initialized = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Deduplicate legacy import/default seed work, not mutable business data.
 * A failed initialization is retryable; different database bindings stay isolated. */
export function oncePerDatabase<T>(database: object, key: string, initialize: () => Promise<T>): Promise<T> {
  let tasks = initialized.get(database);
  if (!tasks) { tasks = new Map(); initialized.set(database, tasks); }
  const existing = tasks.get(key);
  if (existing) return existing as Promise<T>;
  const task = initialize().catch(error => { tasks.delete(key); throw error; });
  tasks.set(key, task);
  return task;
}
