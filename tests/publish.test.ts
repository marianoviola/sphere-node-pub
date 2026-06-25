import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handleRequest } from "../src/platform/cloudflare/worker.ts";
import { publishFragment } from "../scripts/publish.ts";
import type { JsonSchema } from "../src/core/schema.ts";
import { makeDeps, testCtx, get, readJson } from "./helpers.ts";

const SAMPLE_DIR = fileURLToPath(new URL("../examples/fragments/sample", import.meta.url));
const SCHEMA_PATH = new URL("../spec/fragment.schema.json", import.meta.url);

async function loadSchema(): Promise<JsonSchema> {
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as JsonSchema;
}

describe("publish round-trip", () => {
  it("publishes the sample fragment and the node then serves it", async () => {
    const deps = makeDeps();
    const schema = await loadSchema();

    const result = await publishFragment({
      dir: SAMPLE_DIR,
      blobs: deps.blobs,
      fragments: deps.fragments,
      schema,
      now: Date.now(),
    });
    expect(result.id).toBe("2026-01-15-sample-fragment");

    // Discovery now lists it.
    const discovery = await handleRequest(get("/.well-known/sphere.json"), deps, testCtx());
    const doc = await readJson(discovery);
    expect(doc.fragment_count).toBe(1);
    expect(doc.fragments[0].id).toBe("2026-01-15-sample-fragment");

    // Manifest is served.
    const manifest = await handleRequest(
      get("/fragments/2026-01-15-sample-fragment/sphere.json"),
      deps,
      testCtx(),
    );
    expect(manifest.status).toBe(200);

    // Free content is served in full and matches what was published on disk.
    const onDisk = await readFile(`${SAMPLE_DIR}/content.md`, "utf8");
    const content = await handleRequest(
      get("/fragments/2026-01-15-sample-fragment/content.md"),
      deps,
      testCtx(),
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(onDisk);
  });

  it("rejects an invalid fragment manifest", async () => {
    const deps = makeDeps();
    const schema = await loadSchema();
    // Validate a bad manifest directly through the schema path.
    const { validateManifest } = await import("../src/core/publish.ts");
    const errors = validateManifest({ id: "bad id", title: "", access: { policy: "weird" } }, schema);
    expect(errors.length).toBeGreaterThan(0);
  });
});
