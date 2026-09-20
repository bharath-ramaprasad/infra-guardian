import { getStore } from "@netlify/blobs";
import { MemoryStore } from "./memory";
import type { SetOptions, SetResult, Store, StoredValue } from "./store";

// Netlify Blobs with strong consistency. If Blobs is unreachable the instance degrades to memory
// and the caller reports `x-store: degraded`; nothing is swallowed silently.

const STORE_NAME = "infra-guardian";

export class BlobsStore implements Store {
  readonly kind = "blobs" as const;
  private readonly blobs = getStore({ name: STORE_NAME, consistency: "strong" });

  async get<T>(key: string): Promise<StoredValue<T> | null> {
    const r = await this.blobs.getWithMetadata(key, { type: "json" });
    if (r === null || r.data === null || r.data === undefined) return null;
    return { value: r.data as T, etag: r.etag ?? null };
  }

  async set<T>(key: string, value: T, opts: SetOptions = {}): Promise<SetResult> {
    const r =
      opts.onlyIfMatch !== undefined
        ? await this.blobs.setJSON(key, value, { onlyIfMatch: opts.onlyIfMatch })
        : opts.onlyIfNew
          ? await this.blobs.setJSON(key, value, { onlyIfNew: true })
          : await this.blobs.setJSON(key, value);
    return { modified: r.modified, etag: r.etag ?? null };
  }

  async list(prefix: string): Promise<string[]> {
    const r = await this.blobs.list({ prefix });
    return r.blobs.map((b) => b.key).sort();
  }

  async delete(key: string): Promise<void> {
    await this.blobs.delete(key);
  }
}

export interface ResolvedStore {
  readonly store: Store;
  readonly degraded: boolean;
  readonly reason: string | null;
}

let fallback: MemoryStore | null = null;
let blobs: BlobsStore | null = null;

/** Probe Blobs once per instance; on failure use a per-instance memory store and say so. */
export async function resolveStore(): Promise<ResolvedStore> {
  if (process.env.GUARDIAN_STORE === "memory") {
    fallback ??= new MemoryStore();
    return { store: fallback, degraded: false, reason: "memory store by configuration" };
  }
  try {
    blobs ??= new BlobsStore();
    await blobs.get("__probe__");
    return { store: blobs, degraded: false, reason: null };
  } catch (err) {
    fallback ??= new MemoryStore();
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ event: "store.degraded", reason }));
    return { store: fallback, degraded: true, reason };
  }
}
