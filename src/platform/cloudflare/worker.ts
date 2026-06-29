// Cloudflare Workers entrypoint: fetch(), routing, and binding wiring.
//
// The router `handleRequest` takes injected ports (Deps), so it is fully
// testable without a Cloudflare runtime. The default export builds Deps from the
// Worker `env` via the adapters and delegates. Cloudflare types are allowed here
// (this is the platform layer); core/ never imports them.

import { buildDiscovery, type DiscoveryPublisher } from "../../core/discovery.ts";
import { DEFAULT_PREVIEW_CHARS, gateContent } from "../../core/gate.ts";
import { getContent } from "../../core/fragments.ts";
import { countWords } from "../../core/markdown.ts";
import type { PublisherRef } from "../../core/types.ts";
import {
  renderFragmentPage,
  renderIndexPage,
  renderNotFoundPage,
  type SiteChrome,
} from "../../core/html.ts";
import { makeEvent, recordEvent, type EventType } from "../../core/ledger.ts";
import type {
  BlobStore,
  EventStore,
  FragmentStore,
  KvStore,
  PaymentStore,
} from "../../core/ports.ts";
import {
  d1EventStore,
  d1FragmentStore,
  d1PaymentStore,
  kvStore,
  r2BlobStore,
} from "./adapters.ts";
import {
  bytesFromBase64,
  FAVICON_SVG,
  ICON_PNG_BASE64,
  OG_PNG_BASE64,
} from "./assets.ts";

const DISCOVERY_CACHE_KEY = "discovery:v1";
const DISCOVERY_CACHE_TTL_SECONDS = 60;
const TOP_FRAGMENTS_LIMIT = 5;

export interface NodeConfig {
  publisherName: string;
  publisherSummary?: string;
  /** Publisher's canonical URL (SPHERE_PUBLISHER_URL). Omitted from output if unset. */
  publisherUrl?: string;
  /** URL to the publisher mark (SPHERE_PUBLISHER_ICON). Falls back to the node's own mark. */
  publisherIcon?: string;
  defaultLicense: string;
  ownerToken: string;
}

export interface Deps {
  blobs: BlobStore;
  cache: KvStore;
  events: EventStore;
  fragments: FragmentStore;
  payments: PaymentStore;
  config: NodeConfig;
}

/** Minimal slice of Cloudflare's ExecutionContext, so the router stays portable. */
export interface RequestContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  SPHERE_DB: D1Database;
  SPHERE_CONTENT: R2Bucket;
  SPHERE_CACHE: KVNamespace;
  SPHERE_PUBLISHER_NAME: string;
  SPHERE_PUBLISHER_SUMMARY?: string;
  SPHERE_PUBLISHER_URL?: string;
  SPHERE_PUBLISHER_ICON?: string;
  SPHERE_DEFAULT_LICENSE: string;
  SPHERE_OWNER_TOKEN: string;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Serve a static brand asset with a day-long cache. */
function asset(body: BodyInit, contentType: string): Response {
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=86400" },
  });
}

/** Content negotiation: only browsers (Accept includes text/html) get the human surface. */
function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** Stable path at which the node serves its own canonical mark. */
const MARK_PATH = "/assets/sphere-mark.svg";

/**
 * The publisher reference that travels with the discovery doc and every fragment.
 * The icon defaults to this node's own served mark when SPHERE_PUBLISHER_ICON is
 * unset; an unset url is left undefined and so drops out of the JSON entirely.
 */
function publisherRef(deps: Deps, request: Request): PublisherRef {
  const c = deps.config;
  const origin = new URL(request.url).origin;
  return {
    name: c.publisherName,
    url: c.publisherUrl,
    icon: c.publisherIcon || `${origin}${MARK_PATH}`,
  };
}

/** The discovery publisher block: the compact ref plus the node summary. */
function discoveryPublisher(deps: Deps, request: Request): DiscoveryPublisher {
  const ref = publisherRef(deps, request);
  return { name: ref.name, summary: deps.config.publisherSummary, url: ref.url, icon: ref.icon };
}

function chromeFor(deps: Deps, request: Request): SiteChrome {
  const ref = publisherRef(deps, request);
  return {
    publisherName: deps.config.publisherName,
    publisherSummary: deps.config.publisherSummary,
    defaultLicense: deps.config.defaultLicense,
    host: new URL(request.url).host,
    publisherUrl: ref.url,
    publisherIcon: ref.icon,
  };
}

function logEvent(
  deps: Deps,
  ctx: RequestContext,
  request: Request,
  fragmentId: string | null,
  eventType: EventType,
): void {
  const event = makeEvent({
    ts: Date.now(),
    fragmentId,
    eventType,
    userAgent: request.headers.get("user-agent"),
    referer: request.headers.get("referer"),
  });
  ctx.waitUntil(recordEvent(deps.events, event));
}

async function handleDiscovery(deps: Deps, ctx: RequestContext, request: Request): Promise<Response> {
  logEvent(deps, ctx, request, null, "discovery");

  const cached = await deps.cache.get(DISCOVERY_CACHE_KEY);
  if (cached) {
    return new Response(cached, {
      headers: { "content-type": "application/json; charset=utf-8", "x-sphere-cache": "hit" },
    });
  }

  const fragments = await deps.fragments.list();
  const doc = buildDiscovery(
    { publisher: discoveryPublisher(deps, request), defaultLicense: deps.config.defaultLicense },
    fragments,
  );
  const body = JSON.stringify(doc);
  ctx.waitUntil(deps.cache.put(DISCOVERY_CACHE_KEY, body, { expirationTtl: DISCOVERY_CACHE_TTL_SECONDS }));

  return new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "x-sphere-cache": "miss" },
  });
}

async function handleManifest(
  deps: Deps,
  ctx: RequestContext,
  request: Request,
  id: string,
): Promise<Response> {
  const fragment = await deps.fragments.get(id);
  if (!fragment) return json({ error: "fragment_not_found", id }, 404);

  logEvent(deps, ctx, request, id, "manifest");
  // Attach the publisher reference so attribution travels with a single fragment
  // read in isolation. Additive: no existing manifest field changes meaning.
  return json({ ...fragment.manifest, publisher: publisherRef(deps, request) });
}

async function handleContent(
  deps: Deps,
  ctx: RequestContext,
  request: Request,
  id: string,
): Promise<Response> {
  const fragment = await deps.fragments.get(id);
  if (!fragment) return json({ error: "fragment_not_found", id }, 404);

  const content = await getContent(deps.blobs, fragment);
  if (content === null) return json({ error: "content_not_found", id }, 404);

  const result = gateContent(fragment.manifest, content);
  logEvent(deps, ctx, request, id, result.eventType);

  const headers: Record<string, string> = { "content-type": result.contentType };
  if (result.wwwAuthenticate) headers["www-authenticate"] = result.wwwAuthenticate;

  return new Response(result.body, { status: result.status, headers });
}

// --- Human face -------------------------------------------------------------
// Rendered alongside the machine contract for browser requests only. These
// reuse the same ports the agent routes use; rendering itself lives in core/.

async function handleHumanIndex(deps: Deps, ctx: RequestContext, request: Request): Promise<Response> {
  logEvent(deps, ctx, request, null, "discovery");

  const fragments = await deps.fragments.list();
  // The index meta line shows each fragment's word count, so load the bodies
  // (in parallel) to count them. Small N; the discovery doc is cached separately.
  const views = await Promise.all(
    fragments.map(async (f) => {
      const content = await getContent(deps.blobs, f);
      return {
        id: f.manifest.id,
        title: f.manifest.title,
        summary: typeof f.manifest.summary === "string" ? f.manifest.summary : undefined,
        policy: f.manifest.access.policy,
        words: content ? countWords(content) : 0,
        updatedTs: f.updatedTs,
      };
    }),
  );
  return html(renderIndexPage(chromeFor(deps, request), views));
}

async function handleHumanFragment(
  deps: Deps,
  ctx: RequestContext,
  request: Request,
  id: string,
): Promise<Response> {
  const fragment = await deps.fragments.get(id);
  if (!fragment) {
    return html(renderNotFoundPage(chromeFor(deps, request), `No fragment "${id}".`), 404);
  }

  const content = await getContent(deps.blobs, fragment);
  if (content === null) {
    return html(renderNotFoundPage(chromeFor(deps, request), `No content for "${id}".`), 404);
  }

  const policy = fragment.manifest.access.policy;
  const gated = policy === "paid" || policy === "metered";
  // Total word count comes from the full body; the page only ever shows the
  // preview slice for a gated fragment, but the counts stay honest.
  const totalWords = countWords(content);
  let markdown = content;
  let previewWords: number | undefined;
  if (gated) {
    const previewChars = fragment.manifest.access.preview_chars ?? DEFAULT_PREVIEW_CHARS;
    markdown = content.slice(0, Math.max(0, previewChars));
    previewWords = countWords(markdown);
  }

  // A human page never completes payment: a gated view is a preview-only read.
  logEvent(deps, ctx, request, id, gated ? "preview" : "access");
  return html(
    renderFragmentPage(chromeFor(deps, request), fragment.manifest, {
      markdown,
      gated,
      words: totalWords,
      previewWords,
      updatedTs: fragment.updatedTs,
    }),
  );
}

function isOwner(deps: Deps, request: Request): boolean {
  const auth = request.headers.get("authorization");
  if (!auth) return false;
  const expected = `Bearer ${deps.config.ownerToken}`;
  return auth === expected;
}

async function handleOwnerSummary(deps: Deps): Promise<Response> {
  const [fragmentCount, summary, top, paymentTotal, payments] = await Promise.all([
    deps.fragments.count(),
    deps.events.summary(),
    deps.events.topFragments(TOP_FRAGMENTS_LIMIT),
    deps.payments.total(),
    deps.payments.list(),
  ]);

  // Enrich top fragments with titles where available.
  const topWithTitles = await Promise.all(
    top.map(async (t) => {
      const f = await deps.fragments.get(t.fragmentId);
      return { id: t.fragmentId, title: f?.manifest.title ?? null, events: t.count };
    }),
  );

  return json({
    publisher: deps.config.publisherName,
    fragment_count: fragmentCount,
    events: { total: summary.total, by_type: summary.byType },
    top_fragments: topWithTitles,
    revenue: { total: paymentTotal, currency: "USD", payments: payments.length },
  });
}

async function handleOwnerUsage(deps: Deps, id: string): Promise<Response> {
  const points = await deps.events.usageForFragment(id);
  return json({
    fragment_id: id,
    points: points.map((p) => ({ day: p.day, event_type: p.eventType, count: p.count })),
  });
}

async function handleOwnerPayments(deps: Deps): Promise<Response> {
  const [payments, total] = await Promise.all([deps.payments.list(), deps.payments.total()]);
  return json({ payments, total });
}

/**
 * Platform-neutral router. Tests call this directly with in-memory ports.
 */
export async function handleRequest(
  request: Request,
  deps: Deps,
  ctx: RequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
  }

  // Machine contract (unchanged). These always return the same bytes regardless
  // of the Accept header, so agents and the human surface never collide.
  if (path === "/.well-known/sphere.json") {
    return handleDiscovery(deps, ctx, request);
  }

  const manifestMatch = path.match(/^\/fragments\/([^/]+)\/sphere\.json$/);
  if (manifestMatch) {
    return handleManifest(deps, ctx, request, decodeURIComponent(manifestMatch[1]!));
  }

  const contentMatch = path.match(/^\/fragments\/([^/]+)\/content\.md$/);
  if (contentMatch) {
    return handleContent(deps, ctx, request, decodeURIComponent(contentMatch[1]!));
  }

  // Brand assets: favicon, raster icon, and the Open Graph banner. Served to
  // any client regardless of Accept; they don't touch the machine contract and
  // log no ledger events.
  if (path === MARK_PATH) return asset(FAVICON_SVG, "image/svg+xml; charset=utf-8");
  if (path === "/favicon.svg") return asset(FAVICON_SVG, "image/svg+xml; charset=utf-8");
  if (path === "/icon.png") return asset(bytesFromBase64(ICON_PNG_BASE64), "image/png");
  if (path === "/favicon.ico") return asset(bytesFromBase64(ICON_PNG_BASE64), "image/png");
  if (path === "/og.png") return asset(bytesFromBase64(OG_PNG_BASE64), "image/png");

  // Human face. Only served when the client asks for HTML; otherwise these
  // paths fall through to the 404 they returned before, so the machine
  // contract is untouched.
  if (wantsHtml(request)) {
    if (path === "/") {
      return handleHumanIndex(deps, ctx, request);
    }
    const fragmentPageMatch = path.match(/^\/fragments\/([^/]+)\/?$/);
    if (fragmentPageMatch) {
      return handleHumanFragment(deps, ctx, request, decodeURIComponent(fragmentPageMatch[1]!));
    }
  }

  // Owner face. Read-only, bearer-gated, no ledger events.
  if (path.startsWith("/owner/")) {
    if (!isOwner(deps, request)) {
      return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }

    if (path === "/owner/summary") return handleOwnerSummary(deps);
    if (path === "/owner/payments") return handleOwnerPayments(deps);

    const usageMatch = path.match(/^\/owner\/fragments\/([^/]+)\/usage$/);
    if (usageMatch) return handleOwnerUsage(deps, decodeURIComponent(usageMatch[1]!));

    return json({ error: "not_found" }, 404);
  }

  return json({ error: "not_found" }, 404);
}

/** Build Deps from Worker bindings. */
export function depsFromEnv(env: Env): Deps {
  return {
    blobs: r2BlobStore(env.SPHERE_CONTENT),
    cache: kvStore(env.SPHERE_CACHE),
    events: d1EventStore(env.SPHERE_DB),
    fragments: d1FragmentStore(env.SPHERE_DB),
    payments: d1PaymentStore(env.SPHERE_DB),
    config: {
      publisherName: env.SPHERE_PUBLISHER_NAME ?? "Sphere Node",
      publisherSummary: env.SPHERE_PUBLISHER_SUMMARY || undefined,
      publisherUrl: env.SPHERE_PUBLISHER_URL || undefined,
      publisherIcon: env.SPHERE_PUBLISHER_ICON || undefined,
      defaultLicense: env.SPHERE_DEFAULT_LICENSE ?? "CC-BY",
      ownerToken: env.SPHERE_OWNER_TOKEN ?? "",
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, depsFromEnv(env), ctx);
  },
};
