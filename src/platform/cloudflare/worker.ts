// Cloudflare Workers entrypoint: fetch(), routing, and binding wiring.
//
// The router `handleRequest` takes injected ports (Deps), so it is fully
// testable without a Cloudflare runtime. The default export builds Deps from the
// Worker `env` via the adapters and delegates. Cloudflare types are allowed here
// (this is the platform layer); core/ never imports them.

import { buildDiscovery, renderLlmsTxt, type DiscoveryPublisher } from "../../core/discovery.ts";
import { DEFAULT_PREVIEW_CHARS, gateContent } from "../../core/gate.ts";
import { getContent, mediaKeyFor } from "../../core/fragments.ts";
import { countWords } from "../../core/markdown.ts";
import { toStoredFragment, validateManifest } from "../../core/publish.ts";
import type { JsonSchema } from "../../core/schema.ts";
import type { FragmentManifest, PublisherRef } from "../../core/types.ts";
// The publish route validates against the SAME contract the CLI uses. esbuild
// (wrangler) and vitest both bundle this JSON import, so the schema ships inside
// the Worker rather than being read from disk at runtime.
import fragmentSchema from "../../../spec/fragment.schema.json";
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

/**
 * The node-authoritative canonical self-URL for a fragment. The node always owns
 * this value (it overrides any authored `canonical`), so the manifest serve path
 * and the owner publish response derive it identically from here.
 */
function canonicalFor(request: Request, id: string): string {
  return `${new URL(request.url).origin}/fragments/${id}`;
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
  // A HEAD is a metadata probe: it routes exactly as the GET but appends no
  // ledger row. Guarding here (rather than at the router) keeps every handler's
  // logging path identical for GET while making HEAD a no-op everywhere.
  if (request.method === "HEAD") return;
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

/**
 * `/llms.txt`: a plain-text discovery aid for a generic agent or crawler that
 * expects the llms.txt convention. Built from the same catalog as the discovery
 * document (via the same builder) so it never drifts. Served regardless of
 * Accept; appends no ledger event and is not cached (a fresh node's empty aid
 * must go live the moment the first fragment lands).
 */
async function handleLlmsTxt(deps: Deps, request: Request): Promise<Response> {
  const fragments = await deps.fragments.list();
  const doc = buildDiscovery(
    { publisher: discoveryPublisher(deps, request), defaultLicense: deps.config.defaultLicense },
    fragments,
  );
  const body = renderLlmsTxt(doc, new URL(request.url).origin);
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
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
  // Attach the fragment's own absolute canonical URL and the publisher reference,
  // so an agent reading a fragment in isolation knows its home and who published
  // it. Additive: no existing manifest field changes meaning. The node is
  // authoritative for the canonical self-URL, so it always overrides any authored
  // `canonical` field.
  const canonical = canonicalFor(request, id);
  return json({ ...fragment.manifest, canonical, publisher: publisherRef(deps, request) });
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

  // Resolve same-node relation targets (bare ids) to their titles so the reading
  // page can name and link them. Only pay for the extra list when the fragment
  // actually has relations; relation-less fragments touch nothing new here.
  let relationTitles = new Map<string, string>();
  const relations = fragment.manifest.relations;
  if (Array.isArray(relations) && relations.length > 0) {
    const all = await deps.fragments.list();
    relationTitles = new Map(all.map((f) => [f.manifest.id, f.manifest.title]));
  }

  // A human page never completes payment: a gated view is a preview-only read.
  logEvent(deps, ctx, request, id, gated ? "preview" : "access");
  return html(
    renderFragmentPage(
      chromeFor(deps, request),
      fragment.manifest,
      {
        markdown,
        gated,
        words: totalWords,
        previewWords,
        updatedTs: fragment.updatedTs,
      },
      relationTitles,
    ),
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

/** Cap on the publish body: enough for a long fragment, small enough to reject abuse. */
const OWNER_WRITE_MAX_BYTES = 1_000_000;

interface PublishMedia {
  name: string;
  content: string;
}

/**
 * Owner publish (upsert): the HTTP face of the CLI's publish path. It drives the
 * SAME core (`validateManifest` + `toStoredFragment`) through the SAME bound
 * ports (`blobs.put`, `fragments.upsert`) — no new storage logic. This is an
 * owner write, not an access, so it appends NO ledger event and is never cached.
 *
 * Media parity note: media content is a string, mirroring the CLI. Binary media
 * carries the same utf8 limitation the CLI already has; that is a known
 * follow-up, not solved here. content.md is the core of this step.
 */
async function handleOwnerPublish(deps: Deps, request: Request, id: string): Promise<Response> {
  // Reject an oversized body up front — by the declared length when present, and
  // again by the actual text length once read (a lying content-length can't slip through).
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > OWNER_WRITE_MAX_BYTES) {
    return json({ error: "payload_too_large", limit: OWNER_WRITE_MAX_BYTES }, 413);
  }
  const raw = await request.text();
  if (raw.length > OWNER_WRITE_MAX_BYTES) {
    return json({ error: "payload_too_large", limit: OWNER_WRITE_MAX_BYTES }, 413);
  }

  let body: { manifest?: unknown; content?: unknown; media?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const manifest = body.manifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return json({ error: "manifest_required" }, 400);
  }
  // The path id is authoritative: the manifest must claim the same id.
  const manifestId = (manifest as { id?: unknown }).id;
  if (manifestId !== id) {
    return json({ error: "id_mismatch", path: id, manifest: manifestId ?? null }, 400);
  }

  if (typeof body.content !== "string") {
    return json({ error: "content_required" }, 400);
  }
  const content = body.content;

  const media: PublishMedia[] = [];
  if (body.media !== undefined) {
    if (!Array.isArray(body.media)) return json({ error: "media_invalid" }, 400);
    for (const item of body.media) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { name?: unknown }).name !== "string" ||
        typeof (item as { content?: unknown }).content !== "string"
      ) {
        return json({ error: "media_invalid" }, 400);
      }
      media.push({ name: (item as PublishMedia).name, content: (item as PublishMedia).content });
    }
  }

  const errors = validateManifest(manifest, fragmentSchema as JsonSchema);
  if (errors.length > 0) return json({ errors }, 422);

  // Validated: drive the same core the CLI drives, through the bound ports.
  const typed = manifest as FragmentManifest;
  const updatedTs = Date.now();
  const stored = toStoredFragment(typed, updatedTs);
  await deps.blobs.put(stored.contentKey, content);
  for (const item of media) {
    await deps.blobs.put(mediaKeyFor(typed.id, item.name), item.content);
  }
  await deps.fragments.upsert(stored);

  return json({ id: typed.id, canonical: canonicalFor(request, typed.id), mediaCount: media.length, updatedTs });
}

/**
 * Platform-neutral router. Tests call this directly with in-memory ports.
 *
 * GET and HEAD share one routing path: a HEAD is routed exactly as the GET
 * would be, then its body is stripped at the single exit below. HEAD is a
 * metadata probe, so it appends no ledger events (see `logEvent`).
 */
export async function handleRequest(
  request: Request,
  deps: Deps,
  ctx: RequestContext,
): Promise<Response> {
  const method = request.method;
  // The owner publish route is the one write in the contract; everything else is
  // read-only. PUT is dispatched here so the generic 405 below (and its
  // GET, HEAD allow header) stays exactly as it was for the public surface.
  if (method === "PUT") {
    return routePut(request, deps);
  }
  if (method !== "GET" && method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
  }

  const res = await routeGet(request, deps, ctx);
  // A HEAD carries the same status and headers as the GET, with an empty body.
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

/** GET routing. Reached by both GET and HEAD (HEAD strips the body afterward). */
async function routeGet(
  request: Request,
  deps: Deps,
  ctx: RequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Machine contract (unchanged). These always return the same bytes regardless
  // of the Accept header, so agents and the human surface never collide.
  if (path === "/.well-known/sphere.json") {
    return handleDiscovery(deps, ctx, request);
  }

  // Plain-text discovery aid (llms.txt convention). Fixed path, served to any
  // client regardless of Accept; no ledger event, not cached.
  if (path === "/llms.txt") {
    return handleLlmsTxt(deps, request);
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

  // Root: the node's front door, negotiated so it NEVER 404s. A browser gets the
  // human index; a machine — including a generic agent handed the bare URL, whose
  // Accept is `application/json`, `*/*`, or a Sphere machine type — gets the
  // discovery document, byte-identical to /.well-known/sphere.json (same builder,
  // same `discovery` ledger event, no redirect so a single fetch resolves).
  if (path === "/") {
    return wantsHtml(request)
      ? handleHumanIndex(deps, ctx, request)
      : handleDiscovery(deps, ctx, request);
  }

  // Human face. Only served when the client asks for HTML; otherwise these
  // paths fall through to the 404 they returned before, so the machine
  // contract is untouched.
  if (wantsHtml(request)) {
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

/**
 * PUT routing. The only write path in the contract: owner-authenticated publish
 * at `/owner/fragments/{id}`, under the SAME Bearer check as the owner read
 * routes. Any other PUT target is not a valid method for that resource.
 */
async function routePut(request: Request, deps: Deps): Promise<Response> {
  const path = new URL(request.url).pathname;

  const writeMatch = path.match(/^\/owner\/fragments\/([^/]+)$/);
  if (!writeMatch) {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
  }

  if (!isOwner(deps, request)) {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }

  return handleOwnerPublish(deps, request, decodeURIComponent(writeMatch[1]!));
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
