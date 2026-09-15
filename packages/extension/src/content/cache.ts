export interface Lru<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  clear(): void;
  readonly size: number;
}

/**
 * A least-recently-used map: reading an entry renews it, and the least recently read is dropped
 * once `limit` is passed. It bounds how much plaintext a page can hold at once.
 */
export function createLru<V>(limit: number): Lru<V> {
  const entries = new Map<string, V>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit !== undefined) {
        entries.delete(key);
        entries.set(key, hit);
      }
      return hit;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
