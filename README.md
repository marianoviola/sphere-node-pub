# Sphere Node

Status: v1, work in progress.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/marianoviola/sphere-node)

A Sphere Node is a single-tenant, self-hosted content server. It publishes one
publisher's content as agent-readable "fragments" and serves them over a small
HTTP contract designed for AI agents: a public discovery document, per-fragment
manifests, free content, and a `402` payment challenge for paid content. It runs
on Cloudflare Workers with D1, R2, and KV, and you run it yourself.

This repository is the node. The authoring plugin and its tools live in a
separate repository and are out of scope here.

## What it serves

Public, unauthenticated, for agents:

- `GET /.well-known/sphere.json` — publisher discovery (always `200`).
- `GET /fragments/{id}/sphere.json` — fragment manifest.
- `GET /fragments/{id}/content.md` — full content for `free` fragments, or a
  preview plus a `402` payment challenge for `paid`/`metered` fragments. In v1
  the challenge is returned but not verified (payment is a dormant stub).

Human, content-negotiated (browsers only):

- `GET /` — HTML index of the publisher and its fragments.
- `GET /fragments/{id}` — readable HTML page: full content for `free`
  fragments, a preview plus a gated note for `paid`/`metered`. Requests with
  `Accept: text/html` get HTML; the machine routes above are unchanged.

Owner, bearer-token, read-only:

- `GET /owner/summary` — counts, top fragments, revenue (zero in v1).
- `GET /owner/fragments/{id}/usage` — event series for one fragment.
- `GET /owner/payments` — payment ledger (empty in v1).

The full contract is in [`spec/node-api.md`](spec/node-api.md) and
[`spec/fragment.schema.json`](spec/fragment.schema.json).

## Architecture

Domain logic in `src/core/` has zero Cloudflare imports and depends only on the
ports in `src/core/ports.ts` (`BlobStore`, `KvStore`, `EventStore`,
`FragmentStore`, `PaymentStore`). The Cloudflare implementation lives in
`src/platform/cloudflare/` (R2 -> BlobStore, KV -> KvStore, D1 -> the rest). A
future Node+S3+Postgres or AWS adapter would be a sibling folder under
`platform/` with no change to `core/`.

## Deploy

### Deploy to Cloudflare button

The button at the top of this README points at this repository:

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/marianoviola/sphere-node)
```

The button reads `wrangler.toml`, provisions a D1 database, an R2 bucket, and a
KV namespace for you, and rewrites the resource IDs into your copy. The
placeholder `database_id` and KV `id` values in `wrangler.toml` exist only so the
button has a field to rewrite.

### Manual Wrangler deploy

For a manual deploy, delete the `database_id` and KV `id` lines in
`wrangler.toml` (or leave them blank). Wrangler v4 will offer to provision the
missing resources on first deploy and write the real IDs back. Then:

```bash
npm install
npm run deploy   # applies D1 migrations against the SPHERE_DB binding, then deploys
```

`npm run deploy` references the **binding** `SPHERE_DB`, not a database name, so
it keeps working if you let Wrangler pick a different underlying database name.

### Owner token

The owner endpoints are gated by a bearer token. It is a **secret**, never a
var, and never committed:

```bash
wrangler secret put SPHERE_OWNER_TOKEN
```

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and set the
token there (`.dev.vars` is gitignored).

## Publish a fragment

A fragment is a directory with `sphere.json`, `content.md`, and optional
`media/`. See [`examples/fragments/sample/`](examples/fragments/sample/).

```bash
node scripts/publish.ts examples/fragments/sample            # dry run: validate + plan
node scripts/publish.ts examples/fragments/sample --remote   # upload via wrangler
```

The publish path consumes the fragment contract only. It validates against
`spec/fragment.schema.json`, uploads content/media to R2, and upserts the
fragment row in D1. It knows nothing about any CMS or source format.

## Ledger privacy

Every public request appends one lean row: `ts, fragment_id, event_type,
ua_family, ref_source`. The node never stores IP addresses, full user-agents, or
any other PII. `ua_family` is a coarse bucket (for example `agent`, `browser`,
`cli`); `ref_source` is a normalized referrer origin only. Overcollection is a
defect, not a feature.

## Develop

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev (needs .dev.vars + local D1 migrations)
```

To run migrations against a local D1 for `wrangler dev`:

```bash
wrangler d1 migrations apply SPHERE_DB --local
```

## License

The Sphere Node source code in this repository is licensed under the
[Apache License 2.0](LICENSE).

This code license is separate from any content license. The CC BY license used
for published content and fragments (for example the `SPHERE_DEFAULT_LICENSE`
default and the sample fragment) applies to that content, not to this code.
Apache 2.0 covers the node software; CC BY does not.
