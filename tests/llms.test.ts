import { describe, it, expect } from "vitest";
import { handleRequest } from "../src/platform/cloudflare/worker.ts";
import { contentKeyFor } from "../src/core/fragments.ts";
import type { FragmentManifest, StoredFragment } from "../src/core/types.ts";
import { makeDeps, testCtx, get, readJson } from "./helpers.ts";

function seed(deps: ReturnType<typeof makeDeps>, manifest: FragmentManifest, content: string): void {
  const stored: StoredFragment = {
    manifest,
    contentKey: contentKeyFor(manifest.id),
    updatedTs: Date.now(),
  };
  void deps.fragments.upsert(stored);
  void deps.blobs.put(stored.contentKey, content);
}

const freeManifest: FragmentManifest = {
  id: "2026-01-15-free",
  title: "Free Fragment",
  license: "CC-BY",
  access: { policy: "free" },
};

function eventsOf(deps: ReturnType<typeof makeDeps>): unknown[] {
  return (deps.events as ReturnType<typeof makeDeps>["events"] & { events: unknown[] }).events;
}

describe("empty node is a valid node", () => {
  it("serves valid empty discovery on both the well-known and root machine routes", async () => {
    const deps = makeDeps();

    const wellKnown = await handleRequest(get("/.well-known/sphere.json"), deps, testCtx());
    expect(wellKnown.status).toBe(200);
    const doc = await readJson(wellKnown);
    expect(doc.fragment_count).toBe(0);
    expect(doc.fragments).toEqual([]);

    // Root, negotiated as a machine request, returns the same empty-but-valid doc.
    const root = await handleRequest(get("/", { accept: "application/json" }), deps, testCtx());
    expect(root.status).toBe(200);
    const rootDoc = await readJson(root);
    expect(rootDoc.fragment_count).toBe(0);
    expect(rootDoc.fragments).toEqual([]);
  });

  it("renders the human empty state at the root for a browser", async () => {
    const deps = makeDeps();
    const res = await handleRequest(get("/", { accept: "text/html" }), deps, testCtx());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This node is live and ready.");
    expect(html).toContain("publish_fragment");
  });
});

describe("/llms.txt discovery aid", () => {
  it("serves a valid empty aid as text/plain and logs no ledger event", async () => {
    const deps = makeDeps();
    const ctx = testCtx();
    const res = await handleRequest(get("/llms.txt"), deps, ctx);
    await ctx.settle();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# Test Publisher");
    expect(body).toContain("https://node.example/.well-known/sphere.json");
    expect(body).toContain("No fragments published yet.");

    // Owner/aid reads leave the ledger untouched.
    expect(eventsOf(deps).length).toBe(0);
  });

  it("lists the fragments with absolute content.md URLs when the catalog is non-empty", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "free body");

    const ctx = testCtx();
    const res = await handleRequest(get("/llms.txt"), deps, ctx);
    await ctx.settle();

    const body = await res.text();
    expect(body).toContain(
      "- [Free Fragment](https://node.example/fragments/2026-01-15-free/content.md) (free)",
    );
    expect(eventsOf(deps).length).toBe(0);
  });

  it("answers HEAD /llms.txt with the text/plain content-type and an empty body", async () => {
    const deps = makeDeps();
    const res = await handleRequest(
      new Request("https://node.example/llms.txt", { method: "HEAD" }),
      deps,
      testCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("");
  });
});
