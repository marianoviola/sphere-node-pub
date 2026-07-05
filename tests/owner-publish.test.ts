import { describe, it, expect } from "vitest";
import { handleRequest } from "../src/platform/cloudflare/worker.ts";
import { mediaKeyFor } from "../src/core/fragments.ts";
import { makeDeps, testCtx, get, readJson } from "./helpers.ts";

const AUTH = { authorization: "Bearer secret-owner-token" };

function put(
  path: string,
  body: unknown,
  headers: Record<string, string> = AUTH,
): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`https://node.example${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
}

const freeManifest = {
  id: "2026-02-01-published",
  title: "Published Fragment",
  license: "CC-BY",
  access: { policy: "free" as const },
};

describe("owner publish route", () => {
  it("upserts a fragment the machine routes then serve", async () => {
    const deps = makeDeps();

    const res = await handleRequest(
      put("/owner/fragments/2026-02-01-published", {
        manifest: freeManifest,
        content: "the full published body",
      }),
      deps,
      testCtx(),
    );
    expect(res.status).toBe(200);
    const out = await readJson(res);
    expect(out.id).toBe("2026-02-01-published");
    expect(out.canonical).toBe("https://node.example/fragments/2026-02-01-published");
    expect(out.mediaCount).toBe(0);
    expect(typeof out.updatedTs).toBe("number");

    // The published manifest is now served on the machine contract...
    const manifest = await readJson(
      await handleRequest(get("/fragments/2026-02-01-published/sphere.json"), deps, testCtx()),
    );
    expect(manifest.id).toBe("2026-02-01-published");
    expect(manifest.title).toBe("Published Fragment");

    // ...and content.md returns exactly what was published.
    const content = await handleRequest(
      get("/fragments/2026-02-01-published/content.md"),
      deps,
      testCtx(),
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("the full published body");
  });

  it("appends no ledger event for a publish (owner write, not an access)", async () => {
    const deps = makeDeps();
    const ctx = testCtx();
    await handleRequest(
      put("/owner/fragments/2026-02-01-published", {
        manifest: freeManifest,
        content: "body",
      }),
      deps,
      ctx,
    );
    await ctx.settle();
    const events = (deps.events as ReturnType<typeof makeDeps>["events"] & { events: unknown[] }).events;
    expect(events.length).toBe(0);
  });

  it("rejects an invalid manifest with 422 and the validator's error list", async () => {
    const deps = makeDeps();
    // paid policy with no payment block and no price -> access-rule failure.
    const res = await handleRequest(
      put("/owner/fragments/2026-02-01-bad", {
        manifest: {
          id: "2026-02-01-bad",
          title: "Bad",
          license: "CC-BY",
          access: { policy: "paid" },
        },
        content: "body",
      }),
      deps,
      testCtx(),
    );
    expect(res.status).toBe(422);
    const out = await readJson(res);
    expect(Array.isArray(out.errors)).toBe(true);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors.join(" ")).toContain("payment");
    // Nothing was written.
    expect(await deps.fragments.count()).toBe(0);
  });

  it("rejects a manifest id that does not match the path with 400", async () => {
    const deps = makeDeps();
    const res = await handleRequest(
      put("/owner/fragments/2026-02-01-published", {
        manifest: { ...freeManifest, id: "2026-02-01-different" },
        content: "body",
      }),
      deps,
      testCtx(),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("id_mismatch");
    expect(await deps.fragments.count()).toBe(0);
  });

  it("rejects an unparseable body with 400", async () => {
    const deps = makeDeps();
    const res = await handleRequest(
      put("/owner/fragments/2026-02-01-published", "{ not json"),
      deps,
      testCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing or wrong bearer tokens with 401", async () => {
    const deps = makeDeps();
    const noAuth = await handleRequest(
      put("/owner/fragments/2026-02-01-published", { manifest: freeManifest, content: "b" }, {}),
      deps,
      testCtx(),
    );
    expect(noAuth.status).toBe(401);

    const wrong = await handleRequest(
      put(
        "/owner/fragments/2026-02-01-published",
        { manifest: freeManifest, content: "b" },
        { authorization: "Bearer nope" },
      ),
      deps,
      testCtx(),
    );
    expect(wrong.status).toBe(401);
    // An unauthorized write touches nothing.
    expect(await deps.fragments.count()).toBe(0);
  });

  it("rejects a body larger than the size limit with 413", async () => {
    const deps = makeDeps();
    const huge = "x".repeat(1_000_001);
    const res = await handleRequest(
      put("/owner/fragments/2026-02-01-published", { manifest: freeManifest, content: huge }),
      deps,
      testCtx(),
    );
    expect(res.status).toBe(413);
    expect(await deps.fragments.count()).toBe(0);
  });

  it("writes optional media under mediaKeyFor(id, name)", async () => {
    const deps = makeDeps();
    await handleRequest(
      put("/owner/fragments/2026-02-01-published", {
        manifest: freeManifest,
        content: "body",
        media: [{ name: "cover.svg", content: "<svg></svg>" }],
      }),
      deps,
      testCtx(),
    );
    const dump = (deps.blobs as ReturnType<typeof makeDeps>["blobs"] & { dump: Map<string, string> }).dump;
    expect(dump.get(mediaKeyFor("2026-02-01-published", "cover.svg"))).toBe("<svg></svg>");
  });

  it("re-publishing the same id updates in place (upsert, no duplicate)", async () => {
    const deps = makeDeps();
    const first = await handleRequest(
      put("/owner/fragments/2026-02-01-published", {
        manifest: freeManifest,
        content: "first body",
      }),
      deps,
      testCtx(),
    );
    expect(first.status).toBe(200);

    const second = await handleRequest(
      put("/owner/fragments/2026-02-01-published", {
        manifest: { ...freeManifest, title: "Republished" },
        content: "second body",
      }),
      deps,
      testCtx(),
    );
    expect(second.status).toBe(200);

    expect(await deps.fragments.count()).toBe(1);
    const manifest = await readJson(
      await handleRequest(get("/fragments/2026-02-01-published/sphere.json"), deps, testCtx()),
    );
    expect(manifest.title).toBe("Republished");
    const content = await handleRequest(
      get("/fragments/2026-02-01-published/content.md"),
      deps,
      testCtx(),
    );
    expect(await content.text()).toBe("second body");
  });
});
