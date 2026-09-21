import { getStore } from "@netlify/blobs";
import { MemoryStore } from "./memory";
import type { SetOptions, SetResult, Store, StoredValue } from "./store";

// Netlify Blobs with strong consistency. The client is created per invocation on purpose: the runtime injects a
// short-lived token per request, and a cached client keeps a stale one until the warm instance dies (seen in
// production as "Failed to decode token: Token expired"). If Blobs is unreachable for this invocation the instance
// degrades to memory for this call only and the caller reports `x-store: degraded`; the next invocation probes again.

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

/** Probe Blobs for this invocation; on failure use the per-instance memory store and say so. */
export async function resolveStore(): Promise<ResolvedStore> {
  if (process.env.GUARDIAN_STORE === "memory") {
    fallback ??= new MemoryStore();
    return { store: fallback, degraded: false, reason: "memory store by configuration" };
  }
  try {
    const blobs = new BlobsStore();
    await blobs.get("__probe__");
    return { store: blobs, degraded: false, reason: null };
  } catch (err) {
    fallback ??= new MemoryStore();
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ event: "store.degraded", reason }));
    return { store: fallback, degraded: true, reason };
  }
}
