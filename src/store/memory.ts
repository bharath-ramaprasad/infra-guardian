import type { SetOptions, SetResult, Store, StoredValue } from "./store";

// In-memory store: tests, local runs without Blobs, and the degraded fallback inside one instance.

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private readonly data = new Map<string, { json: string; etag: string }>();
  private counter = 0;

  async get<T>(key: string): Promise<StoredValue<T> | null> {
    const e = this.data.get(key);
    return e ? { value: JSON.parse(e.json) as T, etag: e.etag } : null;
  }

  async set<T>(key: string, value: T, opts: SetOptions = {}): Promise<SetResult> {
    const cur = this.data.get(key);
    if (opts.onlyIfNew && cur) return { modified: false, etag: cur.etag };
    if (opts.onlyIfMatch !== undefined && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false, etag: cur?.etag ?? null };
    const etag = `m${++this.counter}`;
    this.data.set(key, { json: JSON.stringify(value), etag });
    return { modified: true, etag };
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}
