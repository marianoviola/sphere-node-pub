// Cloudflare adapters: map R2 -> BlobStore, KV -> KvStore, D1 -> EventStore /
// FragmentStore / PaymentStore. This is the ONLY place Cloudflare bindings are
// touched. core/ never sees these types. A future AWS or Node adapter is a
// sibling file implementing the same ports.

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
} from "../../core/ports.ts";
import type { LedgerEvent, EventType } from "../../core/ledger.ts";
import type { FragmentManifest, StoredFragment } from "../../core/types.ts";

export function r2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? await obj.text() : null;
    },
    async put(key, value) {
      await bucket.put(key, value);
    },
  };
}

export function kvStore(ns: KVNamespace): KvStore {
  return {
    async get(key) {
      return ns.get(key);
    },
    async put(key, value, options) {
      await ns.put(key, value, options);
    },
  };
}

export function d1EventStore(db: D1Database): EventStore {
  return {
    async append(event: LedgerEvent) {
      await db
        .prepare(
          "INSERT INTO events (ts, fragment_id, event_type, ua_family, ref_source) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(event.ts, event.fragmentId, event.eventType, event.uaFamily, event.refSource)
        .run();
    },
    async summary(): Promise<EventSummary> {
      const res = await db
        .prepare("SELECT event_type, COUNT(*) AS c FROM events GROUP BY event_type")
        .all<{ event_type: string; c: number }>();
      const byType: Record<string, number> = {};
      let total = 0;
      for (const row of res.results ?? []) {
        byType[row.event_type] = row.c;
        total += row.c;
      }
      return { total, byType };
    },
    async topFragments(limit: number): Promise<TopFragment[]> {
      const res = await db
        .prepare(
          "SELECT fragment_id, COUNT(*) AS c FROM events WHERE fragment_id IS NOT NULL GROUP BY fragment_id ORDER BY c DESC LIMIT ?",
        )
        .bind(limit)
        .all<{ fragment_id: string; c: number }>();
      return (res.results ?? []).map((r) => ({ fragmentId: r.fragment_id, count: r.c }));
    },
    async usageForFragment(fragmentId: string): Promise<UsagePoint[]> {
      const res = await db
        .prepare(
          "SELECT date(ts / 1000, 'unixepoch') AS day, event_type, COUNT(*) AS c FROM events WHERE fragment_id = ? GROUP BY day, event_type ORDER BY day",
        )
        .bind(fragmentId)
        .all<{ day: string; event_type: string; c: number }>();
      return (res.results ?? []).map((r) => ({
        day: r.day,
        eventType: r.event_type as EventType,
        count: r.c,
      }));
    },
  };
}

interface FragmentRow {
  manifest_json: string;
  content_key: string;
  updated_ts: number;
}

function rowToStored(row: FragmentRow): StoredFragment {
  return {
    manifest: JSON.parse(row.manifest_json) as FragmentManifest,
    contentKey: row.content_key,
    updatedTs: row.updated_ts,
  };
}

export function d1FragmentStore(db: D1Database): FragmentStore {
  return {
    async get(id: string): Promise<StoredFragment | null> {
      const row = await db
        .prepare("SELECT manifest_json, content_key, updated_ts FROM fragments WHERE id = ?")
        .bind(id)
        .first<FragmentRow>();
      return row ? rowToStored(row) : null;
    },
    async list(): Promise<StoredFragment[]> {
      const res = await db
        .prepare("SELECT manifest_json, content_key, updated_ts FROM fragments ORDER BY updated_ts DESC")
        .all<FragmentRow>();
      return (res.results ?? []).map(rowToStored);
    },
    async count(): Promise<number> {
      const row = await db.prepare("SELECT COUNT(*) AS c FROM fragments").first<{ c: number }>();
      return row?.c ?? 0;
    },
    async upsert(fragment: StoredFragment): Promise<void> {
      const m = fragment.manifest;
      await db
        .prepare(
          `INSERT INTO fragments (id, title, policy, license, manifest_json, content_key, created_ts, updated_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             policy = excluded.policy,
             license = excluded.license,
             manifest_json = excluded.manifest_json,
             content_key = excluded.content_key,
             updated_ts = excluded.updated_ts`,
        )
        .bind(
          m.id,
          m.title,
          m.access.policy,
          m.license,
          JSON.stringify(m),
          fragment.contentKey,
          fragment.updatedTs,
          fragment.updatedTs,
        )
        .run();
    },
  };
}

export function d1PaymentStore(db: D1Database): PaymentStore {
  return {
    async list(): Promise<PaymentRecord[]> {
      const res = await db
        .prepare(
          "SELECT ts, fragment_id, amount, currency, profile, status FROM payments ORDER BY ts DESC",
        )
        .all<{
          ts: number;
          fragment_id: string | null;
          amount: number;
          currency: string | null;
          profile: string | null;
          status: string;
        }>();
      return (res.results ?? []).map((r) => ({
        ts: r.ts,
        fragmentId: r.fragment_id,
        amount: r.amount,
        currency: r.currency,
        profile: r.profile,
        status: r.status,
      }));
    },
    async total(): Promise<number> {
      const row = await db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE status = 'settled'")
        .first<{ t: number }>();
      return row?.t ?? 0;
    },
  };
}
