// Store interface: a tiny JSON key/value API with etag compare-and-set.

export interface StoredValue<T> {
  readonly value: T;
  readonly etag: string | null;
}

export interface SetOptions {
  readonly onlyIfMatch?: string;
  readonly onlyIfNew?: boolean;
}

export interface SetResult {
  readonly modified: boolean;
  readonly etag: string | null;
}

export interface Store {
  readonly kind: "blobs" | "memory";
  get<T>(key: string): Promise<StoredValue<T> | null>;
  set<T>(key: string, value: T, opts?: SetOptions): Promise<SetResult>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface CasOutcome<T, R> {
  readonly ok: boolean;
  readonly value: T;
  readonly result: R;
  readonly attempts: number;
}

/**
 * Read-modify-write with etag compare-and-set. `fn` must be pure over its input.
 * After `retries` lost races the last read value is returned with ok=false so the caller
 * can still serve a bounded decision.
 */
export async function updateWithCas<T, R>(
  store: Store,
  key: string,
  init: () => T,
  fn: (current: T) => { value: T; result: R },
  retries = 4,
): Promise<CasOutcome<T, R>> {
  let last: { value: T; result: R } | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const cur = await store.get<T>(key);
    const base = cur ? cur.value : init();
    last = fn(base);
    const res = await store.set(key, last.value, cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return { ok: true, value: last.value, result: last.result, attempts: attempt };
    if (attempt < retries) await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * attempt));
  }
  const cur = await store.get<T>(key);
  const base = cur ? cur.value : init();
  const fallback = fn(base);
  return { ok: false, value: base, result: last ? last.result : fallback.result, attempts: retries };
}
