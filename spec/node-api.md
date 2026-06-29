# Sphere Node HTTP API

This document is the source of truth for the node's HTTP contract. The fragment
manifest shape is defined in `fragment.schema.json`.

All responses are UTF-8. The node is single-tenant: one publisher, one owner.

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

The node attaches a compact `publisher` reference (`{ name, url, icon }`) to the
manifest response, so attribution travels with a single fragment read in
isolation, not only via the node index. This is additive — no authored manifest
field changes meaning.

### `GET /assets/sphere-mark.svg`

The node's canonical publisher mark (an SVG), served with `image/svg+xml` and a
cache header. This is the default target of `publisher.icon` above.

Ledger event: `manifest`.

### `GET /fragments/{id}/content.md`

- Policy `free`: full content, `200`, `text/markdown`.
- Policy `paid` or `metered`: HTTP `402` with a JSON body carrying the preview
  (first `access.preview_chars` characters of the content) and the payment
  challenge built from the manifest `access.payment` block. A
  `WWW-Authenticate: Payment` header is also set.

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
WWW-Authenticate: Payment profile="MPP", endpoint="https://pay.example.com/mpp"

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

In v1 the challenge is RETURNED but NOT verified. Payment verification is a
dormant stub. Ledger event: `access` (free) or `payment_required` (gated).

`404` if the fragment is unknown.

## Human face (content-negotiated, for browsers)

The node also renders a minimal human-readable surface. It is selected purely by
content negotiation: a request whose `Accept` header includes `text/html` gets
HTML; everything else is unaffected. The machine routes above are byte-for-byte
unchanged regardless of `Accept` — a browser hitting
`/fragments/{id}/content.md` still gets the `402`/markdown machine response. The
human routes are additive: their paths returned `404` before and still `404`
(as JSON) for non-HTML clients.

A browser never sees a raw `402` or raw Markdown.

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
