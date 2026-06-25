// In-memory port implementations for tests. They mirror the Cloudflare adapters'
// behavior without any Cloudflare runtime, so the router and publish path can be
// exercised deterministically.

import type {
  BlobStore,
  EventStore,
  EventSummary,
  FragmentStore,
  KvStore,
  PaymentRecord,
  PaymentStore,
  TopFragment,
  UsagePoint,
} from "../src/core/ports.ts";
import type { LedgerEvent } from "../src/core/ledger.ts";
import type { StoredFragment } from "../src/core/types.ts";
import type { Deps, NodeConfig, RequestContext } from "../src/platform/cloudflare/worker.ts";

export function memBlobStore(): BlobStore & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    async get(key) {
      return dump.has(key) ? dump.get(key)! : null;
    },
    async put(key, value) {
      dump.set(key, value);
    },
  };
}

export function memKvStore(): KvStore & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    async get(key) {
      return dump.has(key) ? dump.get(key)! : null;
    },
    async put(key, value) {
      dump.set(key, value);
    },
  };
}

export function memEventStore(): EventStore & { events: LedgerEvent[] } {
  const events: LedgerEvent[] = [];
  return {
    events,
    async append(event) {
      events.push(event);
    },
    async summary(): Promise<EventSummary> {
      const byType: Record<string, number> = {};
      for (const e of events) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
      return { total: events.length, byType };
    },
    async topFragments(limit): Promise<TopFragment[]> {
      const counts = new Map<string, number>();
      for (const e of events) {
        if (e.fragmentId) counts.set(e.fragmentId, (counts.get(e.fragmentId) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([fragmentId, count]) => ({ fragmentId, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    },
    async usageForFragment(fragmentId): Promise<UsagePoint[]> {
      const buckets = new Map<string, number>();
      for (const e of events) {
        if (e.fragmentId !== fragmentId) continue;
        const day = new Date(e.ts).toISOString().slice(0, 10);
        const key = `${day}|${e.eventType}`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      return [...buckets.entries()].map(([key, count]) => {
        const [day, eventType] = key.split("|");
        return { day: day!, eventType: eventType as UsagePoint["eventType"], count };
      });
    },
  };
}

export function memFragmentStore(): FragmentStore & { dump: Map<string, StoredFragment> } {
  const dump = new Map<string, StoredFragment>();
  return {
    dump,
    async get(id) {
      return dump.get(id) ?? null;
    },
    async list() {
      return [...dump.values()].sort((a, b) => b.updatedTs - a.updatedTs);
    },
    async count() {
      return dump.size;
    },
    async upsert(fragment) {
      dump.set(fragment.manifest.id, fragment);
    },
  };
}

export function memPaymentStore(): PaymentStore {
  return {
    async list(): Promise<PaymentRecord[]> {
      return [];
    },
    async total() {
      return 0;
    },
  };
}

export function testConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    publisherName: "Test Publisher",
    defaultLicense: "CC-BY",
    ownerToken: "secret-owner-token",
    ...overrides,
  };
}

export function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    blobs: memBlobStore(),
    cache: memKvStore(),
    events: memEventStore(),
    fragments: memFragmentStore(),
    payments: memPaymentStore(),
    config: testConfig(),
    ...overrides,
  };
}

/** A RequestContext that collects waitUntil promises so tests can await side effects. */
export function testCtx(): RequestContext & { settle(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    async settle() {
      await Promise.all(pending);
    },
  };
}

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://node.example${path}`, { method: "GET", headers });
}

/** Read a response body as JSON, typed loosely for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readJson(res: Response): Promise<any> {
  return res.json() as Promise<any>;
}
