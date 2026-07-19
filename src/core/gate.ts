// Access gate: decide what content.md returns for a fragment based on policy.
// free -> full content, 200. paid/metered -> preview + 402 challenge.
// Verification of payment is a dormant stub: the challenge is built and returned
// but never checked in v1. Pure: no I/O, no Cloudflare imports.
//
// The challenge is shaped by `access.payment.profile` (case-insensitive):
//  - "x402" replaces the whole response body with the real x402
//    PaymentRequired envelope (github.com/coinbase/x402 spec v2) — x402 is a
//    body-based protocol, so the generic {policy, preview, challenge} shape
//    doesn't apply. Sphere's own preview rides in `extensions.sphere`, x402's
//    own designated extension point.
//  - "mpp" keeps the generic JSON body but sets a real "Payment" HTTP
//    auth-scheme challenge (paymentauth.org draft-httpauth-payment-00) on
//    WWW-Authenticate — MPP is a header-level scheme, so the body is untouched.
//  - anything else (including unset) keeps the original generic challenge
//    shape, byte-identical to v1 before this file grew profile awareness.
// None of these verify or settle a payment; v1 only advertises the challenge.

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
  /** WWW-Authenticate header value for gated responses (mpp/generic only; x402 doesn't use one). */
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

/** Base64url-encode (no padding) a UTF-8 string, per the MPP `request` param. */
function base64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The real "Payment" HTTP auth-scheme challenge: id, realm, method, intent,
 * and a base64url `request` param carrying the payment-method-specific data.
 * `realm` is the payment endpoint itself (the natural protection-space
 * identifier here). `id` is derived from the fragment id rather than a fresh
 * random nonce — v1 never verifies a payment, so there is nothing yet for a
 * nonce to protect; a real facilitator integration would mint one per request.
 */
function mppChallenge(manifest: FragmentManifest, challenge: PaymentChallenge): string {
  const request = base64url(
    JSON.stringify({ amount: challenge.price_per_access, currency: challenge.currency }),
  );
  return (
    `Payment id="${manifest.id}:mpp", realm="${challenge.endpoint || "unknown"}", ` +
    `method="${challenge.method}", intent="charge", request="${request}"`
  );
}

/**
 * The real x402 `PaymentRequired` envelope, as the entire response body.
 * `amount` passes `access.payment.amount` through when the publisher has set
 * it (the asset's atomic-unit string); otherwise it falls back to the plain
 * decimal `price_per_access` as configured — getting that value into the
 * correct units for a specific asset is a real-payment-integration concern
 * this compact layer doesn't take on.
 */
function x402Body(
  manifest: FragmentManifest,
  challenge: PaymentChallenge,
  policy: string,
  preview: string,
  contentUrl: string,
): string {
  const payment = manifest.access.payment;
  const envelope = {
    x402Version: 1,
    resource: { url: contentUrl, description: manifest.title, mimeType: "text/markdown" },
    accepts: [
      {
        scheme: "exact",
        network: payment?.network ?? "unknown",
        amount: payment?.amount ?? String(challenge.price_per_access),
        asset: payment?.asset ?? "unknown",
        payTo: payment?.pay_to ?? "",
        maxTimeoutSeconds: payment?.max_timeout_seconds ?? 60,
        extra: { currency: challenge.currency },
      },
    ],
    extensions: { sphere: { policy, preview } },
  };
  return JSON.stringify(envelope);
}

/**
 * Gate the content of one fragment.
 *
 * @param manifest the fragment manifest (carries the access policy and payment block)
 * @param content  the full content.md text loaded from the blob store
 * @param contentUrl the resource's absolute canonical content URL; only used
 *   by the x402 envelope's `resource.url` (ignored for every other profile)
 */
export function gateContent(manifest: FragmentManifest, content: string, contentUrl = ""): GateResult {
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
  const profile = challenge.profile.toLowerCase();

  if (profile === "x402") {
    return {
      status: 402,
      contentType: "application/json; charset=utf-8",
      body: x402Body(manifest, challenge, policy, preview, contentUrl),
      eventType: "payment_required",
      challenge,
    };
  }

  const wwwAuthenticate =
    profile === "mpp"
      ? mppChallenge(manifest, challenge)
      : `Payment profile="${challenge.profile}", endpoint="${challenge.endpoint}", ` +
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
