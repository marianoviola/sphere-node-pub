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

  it("validates the typed sources contract (and migrates legacy shapes)", async () => {
    const schema = await loadSchema();
    const { validateManifest } = await import("../src/core/publish.ts");
    const base = { id: "2026-01-15-a", title: "A", license: "CC-BY", access: { policy: "free" } };

    // Typed external sources: valid.
    expect(
      validateManifest(
        { ...base, sources: [{ type: "book", title: "Public Sphere", author: "Habermas" }] },
        schema,
      ),
    ).toEqual([]);

    // Legacy: only the old `source` string (deprecated lineage) — does not crash, stays valid.
    expect(
      validateManifest({ ...base, source: "content/notes/public-sphere.md" }, schema),
    ).toEqual([]);

    // Empty sources: valid.
    expect(validateManifest({ ...base, sources: [] }, schema)).toEqual([]);

    // The old internal-lineage `sources` shape (kind/label, no type/title) is rejected.
    const legacy = validateManifest(
      { ...base, sources: [{ kind: "text", url: "https://x", label: "doc" }] },
      schema,
    );
    expect(legacy.length).toBeGreaterThan(0);

    // An unknown source type is rejected.
    expect(
      validateManifest({ ...base, sources: [{ type: "tweet", title: "X" }] }, schema).length,
    ).toBeGreaterThan(0);
  });

  it("validates the typed relations edge (and rejects legacy/malformed shapes)", async () => {
    const schema = await loadSchema();
    const { validateManifest } = await import("../src/core/publish.ts");
    const base = { id: "2026-01-15-a", title: "A", license: "CC-BY", access: { policy: "free" } };

    // Typed edges: same-node id target and absolute external URL target are both valid.
    expect(
      validateManifest(
        {
          ...base,
          relations: [
            { type: "continues", target: "2026-01-14-prequel" },
            { type: "cites", target: "https://other.node/fragments/2026-01-10-source" },
          ],
        },
        schema,
      ),
    ).toEqual([]);

    // Empty relations: valid.
    expect(validateManifest({ ...base, relations: [] }, schema)).toEqual([]);

    // Legacy bare-string relation is rejected (it is not an object edge).
    expect(
      validateManifest({ ...base, relations: ["2026-01-14-prequel"] }, schema).length,
    ).toBeGreaterThan(0);

    // Legacy split shape ({ type, fragment_id } / { type, url }) is rejected: it
    // has no `target`.
    expect(
      validateManifest(
        { ...base, relations: [{ type: "extends", fragment_id: "2026-01-14-prequel" }] },
        schema,
      ).length,
    ).toBeGreaterThan(0);

    // A typeless edge is rejected.
    expect(
      validateManifest({ ...base, relations: [{ target: "2026-01-14-prequel" }] }, schema).length,
    ).toBeGreaterThan(0);
  });
});
