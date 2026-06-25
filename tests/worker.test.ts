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

const paidManifest: FragmentManifest = {
  id: "2026-01-16-paid",
  title: "Paid Fragment",
  license: "CC-BY",
  access: {
    policy: "paid",
    preview_chars: 12,
    price_per_access: 0.05,
    currency: "USD",
    payment: { profile: "MPP", method: "PaymentAuth", endpoint: "https://pay.example.com/mpp" },
  },
};

describe("discovery route", () => {
  it("always returns 200, even when empty", async () => {
    const deps = makeDeps();
    const ctx = testCtx();
    const res = await handleRequest(get("/.well-known/sphere.json"), deps, ctx);
    expect(res.status).toBe(200);
    const doc = await readJson(res);
    expect(doc.fragment_count).toBe(0);
    expect(doc.fragments).toEqual([]);
  });

  it("lists seeded fragments and serves a cached copy on the second call", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "free body");

    const first = await handleRequest(get("/.well-known/sphere.json"), deps, testCtx());
    expect(first.headers.get("x-sphere-cache")).toBe("miss");
    const doc = await readJson(first);
    expect(doc.fragment_count).toBe(1);

    // The miss populated the cache via waitUntil; settle it then re-request.
    const ctx2 = testCtx();
    const second = await handleRequest(get("/.well-known/sphere.json"), deps, ctx2);
    expect(second.headers.get("x-sphere-cache")).toBe("hit");
  });
});

describe("manifest route", () => {
  it("serves the manifest as JSON and 404s unknown ids", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "free body");

    const ok = await handleRequest(get("/fragments/2026-01-15-free/sphere.json"), deps, testCtx());
    expect(ok.status).toBe(200);
    expect((await readJson(ok)).id).toBe("2026-01-15-free");

    const missing = await handleRequest(get("/fragments/nope/sphere.json"), deps, testCtx());
    expect(missing.status).toBe(404);
  });
});

describe("content route", () => {
  it("returns full content with 200 for free fragments", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "the full free body");
    const res = await handleRequest(get("/fragments/2026-01-15-free/content.md"), deps, testCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("the full free body");
  });

  it("returns a preview and a 402 with a well-formed challenge for paid fragments", async () => {
    const deps = makeDeps();
    seed(deps, paidManifest, "SECRET CONTENT that is long enough to be truncated");
    const res = await handleRequest(get("/fragments/2026-01-16-paid/content.md"), deps, testCtx());

    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toContain("Payment");
    const payload = await readJson(res);
    expect(payload.preview).toBe("SECRET CONTE"); // first 12 chars
    expect(payload.challenge).toEqual({
      profile: "MPP",
      method: "PaymentAuth",
      endpoint: "https://pay.example.com/mpp",
      price_per_access: 0.05,
      currency: "USD",
    });
  });
});

describe("ledger side effects", () => {
  it("appends one lean event per public request with no PII", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "body");

    const ctx = testCtx();
    await handleRequest(
      get("/fragments/2026-01-15-free/content.md", {
        "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120",
        referer: "https://ref.example.com/x?u=1",
      }),
      deps,
      ctx,
    );
    await ctx.settle();

    const events = (deps.events as ReturnType<typeof makeDeps>["events"] & { events: unknown[] }).events;
    expect(events.length).toBe(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.eventType).toBe("access");
    expect(event.uaFamily).toBe("browser");
    expect(event.refSource).toBe("https://ref.example.com");
    expect(JSON.stringify(event)).not.toContain("Macintosh");
  });

  it("does not log events for owner requests", async () => {
    const deps = makeDeps();
    const ctx = testCtx();
    await handleRequest(
      get("/owner/summary", { authorization: "Bearer secret-owner-token" }),
      deps,
      ctx,
    );
    await ctx.settle();
    const events = (deps.events as ReturnType<typeof makeDeps>["events"] & { events: unknown[] }).events;
    expect(events.length).toBe(0);
  });
});

describe("owner face", () => {
  it("rejects missing or wrong bearer tokens with 401", async () => {
    const deps = makeDeps();
    const noAuth = await handleRequest(get("/owner/summary"), deps, testCtx());
    expect(noAuth.status).toBe(401);

    const wrong = await handleRequest(
      get("/owner/summary", { authorization: "Bearer nope" }),
      deps,
      testCtx(),
    );
    expect(wrong.status).toBe(401);
  });

  it("serves summary, usage, and payments with a valid token", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "body");
    const auth = { authorization: "Bearer secret-owner-token" };

    // Generate some traffic first.
    const trafficCtx = testCtx();
    await handleRequest(get("/fragments/2026-01-15-free/content.md"), deps, trafficCtx);
    await trafficCtx.settle();

    const summary = await handleRequest(get("/owner/summary", auth), deps, testCtx());
    expect(summary.status).toBe(200);
    const s = await readJson(summary);
    expect(s.fragment_count).toBe(1);
    expect(s.revenue.total).toBe(0);

    const usage = await handleRequest(
      get("/owner/fragments/2026-01-15-free/usage", auth),
      deps,
      testCtx(),
    );
    expect(usage.status).toBe(200);
    expect((await readJson(usage)).fragment_id).toBe("2026-01-15-free");

    const payments = await handleRequest(get("/owner/payments", auth), deps, testCtx());
    expect(payments.status).toBe(200);
    expect(await readJson(payments)).toEqual({ payments: [], total: 0 });
  });
});

describe("method handling", () => {
  it("rejects non-GET methods with 405", async () => {
    const deps = makeDeps();
    const res = await handleRequest(
      new Request("https://node.example/.well-known/sphere.json", { method: "POST" }),
      deps,
      testCtx(),
    );
    expect(res.status).toBe(405);
  });
});
