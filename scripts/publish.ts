// Owner write path: upload a prepared fragment directory to the node's stores.
//
// This script consumes the FRAGMENT CONTRACT only (sphere.json + content.md +
// optional media/). It knows nothing about Astro, any CMS, or any source
// format. It validates against spec/fragment.schema.json, uploads content/media
// to the BlobStore, and upserts the fragment row in the FragmentStore.
//
// The reusable logic is `publishFragment`, which takes injected ports so it can
// run against in-memory adapters in tests or against Cloudflare via wrangler in
// real use.
//
// Usage:
//   node scripts/publish.ts <fragment-dir>             # dry run: validate + plan
//   node scripts/publish.ts <fragment-dir> --remote    # execute via wrangler

import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateManifest, toStoredFragment } from "../src/core/publish.ts";
import { mediaKeyFor } from "../src/core/fragments.ts";
import type { JsonSchema } from "../src/core/schema.ts";
import type { BlobStore, FragmentStore } from "../src/core/ports.ts";
import type { FragmentManifest, StoredFragment } from "../src/core/types.ts";

const SPEC_PATH = new URL("../spec/fragment.schema.json", import.meta.url);

export async function loadSchema(): Promise<JsonSchema> {
  return JSON.parse(await readFile(SPEC_PATH, "utf8")) as JsonSchema;
}

async function listMediaFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(join(dir, "media"));
  } catch {
    return [];
  }
}

/** Validate and publish a fragment directory through the given ports. */
export async function publishFragment(opts: {
  dir: string;
  blobs: BlobStore;
  fragments: FragmentStore;
  schema: JsonSchema;
  now: number;
}): Promise<{ id: string; mediaCount: number }> {
  const { dir, blobs, fragments, schema, now } = opts;

  const manifest = JSON.parse(await readFile(join(dir, "sphere.json"), "utf8")) as FragmentManifest;
  const errors = validateManifest(manifest, schema);
  if (errors.length > 0) {
    throw new Error(`Invalid fragment in ${dir}:\n  - ${errors.join("\n  - ")}`);
  }

  const content = await readFile(join(dir, "content.md"), "utf8");
  const stored = toStoredFragment(manifest, now);

  await blobs.put(stored.contentKey, content);

  const media = await listMediaFiles(dir);
  for (const name of media) {
    const body = await readFile(join(dir, "media", name), "utf8");
    await blobs.put(mediaKeyFor(manifest.id, name), body);
  }

  await fragments.upsert(stored);
  return { id: manifest.id, mediaCount: media.length };
}

// --- Real (wrangler-backed) adapters for the CLI --remote path. Untested by
// design: they touch real Cloudflare resources the owner provisioned. ---

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildUpsertSql(stored: StoredFragment): string {
  const m = stored.manifest;
  const vals = [
    sqlString(m.id),
    sqlString(m.title),
    sqlString(m.access.policy),
    sqlString(m.license),
    sqlString(JSON.stringify(m)),
    sqlString(stored.contentKey),
    String(stored.updatedTs),
    String(stored.updatedTs),
  ].join(", ");
  return (
    `INSERT INTO fragments (id, title, policy, license, manifest_json, content_key, created_ts, updated_ts) ` +
    `VALUES (${vals}) ON CONFLICT(id) DO UPDATE SET title=excluded.title, policy=excluded.policy, ` +
    `license=excluded.license, manifest_json=excluded.manifest_json, content_key=excluded.content_key, ` +
    `updated_ts=excluded.updated_ts;`
  );
}

function wranglerBlobStore(bucket: string): BlobStore {
  return {
    async get() {
      throw new Error("read not supported in CLI blob store");
    },
    async put(key, value) {
      const tmp = join(mkdtempSync(join(tmpdir(), "sphere-")), "blob");
      writeFileSync(tmp, value);
      execFileSync("wrangler", ["r2", "object", "put", `${bucket}/${key}`, "--file", tmp, "--remote"], {
        stdio: "inherit",
      });
    },
  };
}

function wranglerFragmentStore(dbBinding: string): FragmentStore {
  const unsupported = () => {
    throw new Error("read not supported in CLI fragment store");
  };
  return {
    get: unsupported,
    list: unsupported,
    count: unsupported,
    async upsert(fragment) {
      const tmp = join(mkdtempSync(join(tmpdir(), "sphere-")), "upsert.sql");
      writeFileSync(tmp, buildUpsertSql(fragment));
      execFileSync("wrangler", ["d1", "execute", dbBinding, "--remote", "--file", tmp], {
        stdio: "inherit",
      });
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const args = argv.filter((a) => !a.startsWith("--"));
  const remote = argv.includes("--remote");
  const dir = args[0];
  if (!dir) {
    console.error("Usage: node scripts/publish.ts <fragment-dir> [--remote]");
    process.exitCode = 1;
    return;
  }

  const schema = await loadSchema();

  if (!remote) {
    // Dry run: validate and print the plan without touching any store.
    const manifest = JSON.parse(await readFile(join(dir, "sphere.json"), "utf8")) as FragmentManifest;
    const errors = validateManifest(manifest, schema);
    if (errors.length > 0) {
      console.error(`Invalid fragment:\n  - ${errors.join("\n  - ")}`);
      process.exitCode = 1;
      return;
    }
    const stored = toStoredFragment(manifest, Date.now());
    const media = await listMediaFiles(dir);
    console.log("Dry run (no writes). Pass --remote to publish via wrangler.");
    console.log(`  fragment:   ${manifest.id} (${manifest.access.policy})`);
    console.log(`  content ->  R2 key ${stored.contentKey}`);
    for (const name of media) console.log(`  media   ->  R2 key ${mediaKeyFor(manifest.id, name)}`);
    console.log("  catalog ->  upsert fragments row in D1 (SPHERE_DB)");
    return;
  }

  const bucket = process.env.SPHERE_CONTENT_BUCKET ?? "sphere-node-content";
  const dbBinding = process.env.SPHERE_DB_BINDING ?? "SPHERE_DB";
  const result = await publishFragment({
    dir,
    blobs: wranglerBlobStore(bucket),
    fragments: wranglerFragmentStore(dbBinding),
    schema,
    now: Date.now(),
  });
  console.log(`Published ${result.id} (${result.mediaCount} media file(s)).`);
}

// Run main() only when invoked as a script, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
