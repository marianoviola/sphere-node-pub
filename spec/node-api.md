# Sphere Node HTTP API

This document is the source of truth for the node's HTTP contract. The fragment
manifest shape is defined in `fragment.schema.json`.

All responses are UTF-8. The node is single-tenant: one publisher, one owner.

## Canonical fragment reference

A fragment has exactly one canonical location on its home node:

```
GET /fragments/{id}
```

`{id}` is the URL path segment, format `yyyy-mm-dd-slug` (see
`fragment.schema.json`). Its machine views are the two sub-resources of that
location: `/fragments/{id}/sphere.json` (the manifest) and
`/fragments/{id}/content.md` (the body). The fragment's ABSOLUTE canonical URL is
therefore:

```
{node_base}/fragments/{id}
```

A **reference** to a fragment is exactly one of:

- **same-node** — the bare `id` (`2026-01-15-sample-fragment`), resolved against
  this node, or
- **external** — an absolute URL to another node's canonical fragment URL
  (`https://other.node/fragments/2026-01-15-their-fragment`).

This single scheme is used identically everywhere a fragment is referenced:
`relations[].target` (see `fragment.schema.json`), inline links inside
`content.md`, and the machine views above. There is no second addressing form;
an `id` is just the same-node short form of the absolute canonical URL.

## Public face (unauthenticated, for agents)

### `GET /.well-known/sphere.json`

Publisher discovery document. ALWAYS returns `200`, even when the node has no
fragments. Served from the KV cache, falling back to D1 when the cache is cold.

The `publisher` object carries attribution: `name`, an optional `summary`, the
publisher's canonical `url`, and an `icon` URL (the publisher mark). `icon`
defaults to this node's own served mark (`/assets/sphere-mark.svg`); `url` is
omitted when unset.

```json
{
  "sphere_version": "1.0",
  "publisher": {
    "name": "Example Publisher",
    "summary": "Agent-readable publishing.",
    "url": "https://example.com",
    "icon": "https://node.example/assets/sphere-mark.svg"
  },
  "default_license": "CC-BY",
  "fragment_count": 1,
  "fragments": [
    {
      "id": "2026-01-15-sample-fragment",
      "title": "Sample Fragment",
      "policy": "free",
      "manifest": "/fragments/2026-01-15-sample-fragment/sphere.json",
      "content": "/fragments/2026-01-15-sample-fragment/content.md"
    }
  ]
}
```

Ledger event: `discovery`.

### `GET /fragments/{id}/sphere.json`

Fragment manifest. Metadata is always available regardless of access policy.
`404` if the fragment is unknown.

The node attaches two fields to the manifest response, both additive — no
authored manifest field changes meaning:

- `canonical`: the fragment's own absolute canonical URL
  (`{node_base}/fragments/{id}`), so an agent reading a fragment in isolation
  knows its home. The node is authoritative for this value and always sets it,
  overriding any authored `canonical` field.
- `publisher`: a compact publisher reference (`{ name, url, icon }`), so
  attribution travels with a single fragment read, not only via the node index.

The authored `relations` array is served through unchanged in its authored JSON
position. Each edge is `{ type, target }` where `target` is a canonical fragment
reference per the scheme above (a same-node `id` or an absolute external fragment
URL). The node validates this shape on ingest (publish) against
`fragment.schema.json`; it does not rewrite or resolve targets at read time.

### `GET /assets/sphere-mark.svg`

The node's canonical publisher mark (an SVG), served with `image/svg+xml` and a
cache header. This is the default target of `publisher.icon` above.

Ledger event: `manifest`.

### `GET /fragments/{id}/content.md`

- Policy `free`: full content, `200`, `text/markdown`.
- Policy `paid` or `metered`: HTTP `402`. The exact shape is chosen by
  `access.payment.profile` (case-insensitive) — see **Payment challenge
  shapes** below. In v1 the challenge is RETURNED but NEVER VERIFIED; payment
  verification and settlement are a dormant stub regardless of profile.

`404` if the fragment is unknown.

Also reachable at the fragment's bare canonical URL, `GET /fragments/{id}`,
via content negotiation — see **Content negotiation on `/fragments/{id}`**
below.

Ledger event: `access` (free) or `payment_required` (gated).

#### Payment challenge shapes

**Generic (any profile other than `x402` or `mpp`, including unset)** — the
original v1 shape, unchanged:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
WWW-Authenticate: Payment profile="MPP", endpoint="https://pay.example.com/mpp", price="0.02", currency="USD"

{
  "policy": "paid",
  "preview": "First N characters of the content ...",
  "challenge": {
    "profile": "MPP",
    "method": "PaymentAuth",
    "endpoint": "https://pay.example.com/mpp",
    "price_per_access": 0.02,
    "currency": "USD"
  }
}
```

**`profile: "mpp"`** — a real `Payment` HTTP auth-scheme challenge
(paymentauth.org `draft-httpauth-payment-00`) on `WWW-Authenticate`. MPP is a
header-level scheme, so the JSON body is unchanged from the generic shape
above:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
WWW-Authenticate: Payment id="2026-01-15-x:mpp", realm="https://pay.example.com/mpp", method="PaymentAuth", intent="charge", request="eyJhbW91bnQiOjAuMDIsImN1cnJlbmN5IjoiVVNEIn0"
```

**`profile: "x402"`** — the entire body becomes the real x402
`PaymentRequired` envelope (github.com/coinbase/x402 spec v2); there is no
`WWW-Authenticate` header. `network`, `asset`, `pay_to`, `amount`, and
`max_timeout_seconds` are optional fields on the manifest's `access.payment`
block (additive; fall back to sane defaults when unset). Sphere's own preview
text rides in `extensions.sphere`, x402's own designated extension point:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "resource": {
    "url": "https://node.example/fragments/2026-01-15-x/content.md",
    "description": "Fragment title",
    "mimeType": "text/markdown"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "0.02",
      "asset": "USDC",
      "payTo": "0xabc123",
      "maxTimeoutSeconds": 60,
      "extra": { "currency": "USD" }
    }
  ],
  "extensions": { "sphere": { "policy": "paid", "preview": "First N characters ..." } }
}
```

None of these verify or settle a payment in v1 — only the challenge shape
differs by profile. Two commerce standards checked by some agent-readiness
audits, **ACP** (Agentic Commerce Protocol) and **UCP** (Universal Commerce
Protocol), are intentionally NOT implemented: as of writing, neither has a
discovery-only mode — both require a real checkout/cart API to honestly claim
support, which is out of scope for this compact layer.

### `GET /robots.txt`

Plain text. Allows every user agent, points at `/sitemap.xml`, and declares
[Content Signals](https://contentsignals.org): `search=yes, ai-input=yes`
always (staying discoverable to search and agent-input crawlers is this
project's entire purpose), and `ai-train` from `SPHERE_ALLOW_AI_TRAINING`
(`"no"` unless the publisher explicitly sets it to `"yes"`). Served regardless
of `Accept`; no ledger event.

### `GET /sitemap.xml`

Standard XML sitemap: the human index (`/`) plus every fragment's canonical
reading page (`/fragments/{id}`), each with a `<lastmod>` derived from the
node's own data (`updatedTs`; omitted for the root entry on an empty node).
Served regardless of `Accept`; no ledger event.

### Content negotiation on `/fragments/{id}`

The bare canonical fragment URL negotiates three ways: `Accept: text/html`
gets the human reading page (below); `Accept: text/markdown` gets exactly what
`/fragments/{id}/content.md` returns (same status, body, and headers); any
other `Accept` still `404`s, as it always has. Responses carry `Vary: Accept`.

## Human face (content-negotiated, for browsers)

The node also renders a minimal human-readable surface. It is selected purely by
content negotiation: a request whose `Accept` header includes `text/html` gets
HTML; everything else is unaffected. The machine routes above are byte-for-byte
unchanged regardless of `Accept` — a browser hitting
`/fragments/{id}/content.md` still gets the `402`/markdown machine response. The
human routes are additive: their paths returned `404` before and still `404`
(as JSON) for non-HTML clients.

A browser never sees a raw `402` or raw Markdown.

Both human routes below also carry a `Link: </.well-known/sphere.json>;
rel="alternate"; type="application/json"` header (the same target as the HTML
`<link rel="alternate">` in each page's `<head>`), so a client that only reads
headers — not HTML — can still find the machine surface.

### `GET /` (Accept: text/html)

Publisher index: the publisher name and optional summary
(`SPHERE_PUBLISHER_NAME`, `SPHERE_PUBLISHER_SUMMARY`), a list of fragments
(title, summary, and a policy badge, each linking to its reading page), and a
footer crediting the Sphere project. Driven entirely by node data and config.

Ledger event: `discovery`.

### `GET /fragments/{id}` (Accept: text/html)

Fragment reading page, rendered in the shared template.

- Policy `free`/`sponsored`: the full `content.md` rendered to HTML.
- Policy `paid`/`metered`: only the preview (first `access.preview_chars`
  characters) rendered to HTML, plus a short line explaining the rest is gated
  and pointing at the machine `content.md` route. Payment is never performed
  from a browser, so a gated page is a preview-only read.

`404` (HTML) if the fragment or its content is unknown.

Ledger event: `access` (free) or `preview` (gated).

## Owner face (bearer token, single owner)

All owner endpoints require `Authorization: Bearer <SPHERE_OWNER_TOKEN>` and are
read-only. Missing or wrong token returns `401`. Owner requests do NOT append
ledger events.

### `GET /owner/summary`

```json
{
  "publisher": "Example Publisher",
  "fragment_count": 1,
  "events": { "total": 12, "by_type": { "discovery": 4, "manifest": 5, "access": 3 } },
  "top_fragments": [{ "id": "2026-01-15-sample-fragment", "title": "Sample Fragment", "events": 8 }],
  "revenue": { "total": 0, "currency": "USD", "payments": 0 }
}
```

Revenue is always zero in v1 (payments are dormant).

### `GET /owner/fragments/{id}/usage`

Event series over time for one fragment, bucketed by day.

```json
{
  "fragment_id": "2026-01-15-sample-fragment",
  "points": [{ "day": "2026-01-15", "event_type": "manifest", "count": 3 }]
}
```

### `GET /owner/payments`

Payment ledger. Empty in v1; the shape is present for forward compatibility.

```json
{ "payments": [], "total": 0 }
```

## Ledger events

Every public request appends exactly one row: `ts, fragment_id, event_type,
ua_family, ref_source`. `event_type` is one of: `discovery`, `manifest`,
`preview`, `access`, `payment_required`, `unlock`. `unlock` is dormant in v1
(emitted only once payment verification is implemented); `preview` is emitted
when a browser views the human page of a gated fragment (a preview-only read).
Human and agent traffic share these event types and are distinguished by
`ua_family` (e.g. `browser` vs `agent`).

The ledger NEVER stores IP address, full user-agent, or any other PII.
`ua_family` is a coarse bucket; `ref_source` is a normalized referrer origin.
