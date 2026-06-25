// Port interfaces. core/ depends ONLY on this file for outside-world access.
// A future Node+S3+Postgres or AWS adapter implements these same interfaces in
// a sibling folder under platform/ with NO change to core/.

import type { StoredFragment } from "./types.ts";
import type { EventType, LedgerEvent } from "./ledger.ts";

/** Object content store (content.md, media). Cloudflare adapter wraps R2. */
export interface BlobStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Key-value cache. Cloudflare adapter wraps KV. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface UsagePoint {
  day: string;
  eventType: EventType;
  count: number;
}

export interface TopFragment {
  fragmentId: string;
  count: number;
}

export interface EventSummary {
  total: number;
  byType: Record<string, number>;
}

/** Append-only event ledger plus read aggregations. Cloudflare adapter wraps D1. */
export interface EventStore {
  append(event: LedgerEvent): Promise<void>;
  summary(): Promise<EventSummary>;
  topFragments(limit: number): Promise<TopFragment[]>;
  usageForFragment(fragmentId: string): Promise<UsagePoint[]>;
}

/** Fragment catalog. Cloudflare adapter wraps the D1 `fragments` table. */
export interface FragmentStore {
  get(id: string): Promise<StoredFragment | null>;
  list(): Promise<StoredFragment[]>;
  count(): Promise<number>;
  upsert(fragment: StoredFragment): Promise<void>;
}

export interface PaymentRecord {
  ts: number;
  fragmentId: string | null;
  amount: number;
  currency: string | null;
  profile: string | null;
  status: string;
}

/** Payment ledger. Dormant in v1: list() returns []. Cloudflare adapter wraps D1. */
export interface PaymentStore {
  list(): Promise<PaymentRecord[]>;
  total(): Promise<number>;
}
