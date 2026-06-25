// Event ledger: shape, privacy reduction, and append helper.
// Privacy is a hard constraint. We NEVER persist IP, full user-agent, or PII.
// Raw header strings enter here and leave only as coarse, non-identifying
// buckets. Zero Cloudflare names or imports.

import type { EventStore } from "./ports.ts";

export type EventType =
  | "discovery"
  | "manifest"
  | "preview"
  | "access"
  | "payment_required"
  | "unlock";

/** The complete set of columns persisted per public request. Nothing else. */
export interface LedgerEvent {
  ts: number;
  fragmentId: string | null;
  eventType: EventType;
  uaFamily: string;
  refSource: string;
}

/**
 * Reduce a raw user-agent to a coarse family bucket. The original string is
 * never returned or stored. Buckets are deliberately broad so they cannot
 * fingerprint a specific client.
 */
export function uaFamily(userAgent: string | null | undefined): string {
  if (!userAgent) return "none";
  const ua = userAgent.toLowerCase();

  // Known AI / agent crawlers, kept as one flat bucket.
  if (/(gptbot|oai-searchbot|chatgpt|claudebot|claude-web|anthropic|perplexitybot|google-extended|bingbot|ccbot|bytespider|amazonbot)/.test(ua)) {
    return "agent";
  }
  // Generic automated declarations.
  if (/bot|crawler|spider|slurp/.test(ua)) return "bot";
  // Command-line and library clients.
  if (/curl|wget|python-requests|httpx|aiohttp|node-fetch|undici|go-http|okhttp|java\//.test(ua)) return "cli";
  // Real browsers.
  if (/mozilla|chrome|safari|firefox|edge|webkit/.test(ua)) return "browser";

  return "other";
}

/**
 * Reduce a referrer to its origin (scheme + host [+ port]) only. Path and query
 * are dropped because they can carry identifiers. Returns "direct" when there is
 * no usable referrer.
 */
export function refSource(referer: string | null | undefined): string {
  if (!referer) return "direct";
  try {
    const url = new URL(referer);
    return url.origin;
  } catch {
    return "direct";
  }
}

/** Build a ledger event from raw request inputs, reducing privacy-sensitive fields. */
export function makeEvent(input: {
  ts: number;
  fragmentId: string | null;
  eventType: EventType;
  userAgent: string | null | undefined;
  referer: string | null | undefined;
}): LedgerEvent {
  return {
    ts: input.ts,
    fragmentId: input.fragmentId,
    eventType: input.eventType,
    uaFamily: uaFamily(input.userAgent),
    refSource: refSource(input.referer),
  };
}

/** Append an event through the store port. */
export async function recordEvent(store: EventStore, event: LedgerEvent): Promise<void> {
  await store.append(event);
}
