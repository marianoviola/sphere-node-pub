// Access gate: decide what content.md returns for a fragment based on policy.
// free -> full content, 200. paid/metered -> preview + 402 challenge.
// Verification of payment is a dormant stub: the challenge is built and returned
// but never checked in v1. Pure: no I/O, no Cloudflare imports.

import type { FragmentManifest } from "./types.ts";
import type { EventType } from "./ledger.ts";

export const DEFAULT_PREVIEW_CHARS = 500;

export interface PaymentChallenge {
  profile: string;
  method: string;
  endpoint: string;
  price_per_access: number;
  currency: string;
}

export interface GateResult {
  status: number;
  contentType: string;
  body: string;
  eventType: EventType;
  /** Present only for gated responses. */
  challenge?: PaymentChallenge;
  /** WWW-Authenticate header value for gated responses. */
  wwwAuthenticate?: string;
}

function buildChallenge(manifest: FragmentManifest): PaymentChallenge {
  const access = manifest.access;
  const payment = access.payment;
  return {
    profile: payment?.profile ?? "unknown",
    method: payment?.method ?? "unknown",
    endpoint: payment?.endpoint ?? "",
    price_per_access: access.price_per_access ?? 0,
    currency: access.currency ?? "USD",
  };
}

/**
 * Gate the content of one fragment.
 *
 * @param manifest the fragment manifest (carries the access policy and payment block)
 * @param content  the full content.md text loaded from the blob store
 */
export function gateContent(manifest: FragmentManifest, content: string): GateResult {
  const policy = manifest.access.policy;

  if (policy === "free" || policy === "sponsored") {
    return {
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body: content,
      eventType: "access",
    };
  }

  // paid or metered: serve a bounded preview alongside a 402 challenge.
  const previewChars = manifest.access.preview_chars ?? DEFAULT_PREVIEW_CHARS;
  const preview = content.slice(0, Math.max(0, previewChars));
  const challenge = buildChallenge(manifest);

  const wwwAuthenticate =
    `Payment profile="${challenge.profile}", endpoint="${challenge.endpoint}", ` +
    `price="${challenge.price_per_access}", currency="${challenge.currency}"`;

  const body = JSON.stringify({ policy, preview, challenge });

  return {
    status: 402,
    contentType: "application/json; charset=utf-8",
    body,
    eventType: "payment_required",
    challenge,
    wwwAuthenticate,
  };
}
