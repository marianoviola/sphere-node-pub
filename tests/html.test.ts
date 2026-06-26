import { describe, it, expect } from "vitest";
import { handleRequest } from "../src/platform/cloudflare/worker.ts";
import { contentKeyFor } from "../src/core/fragments.ts";
import { renderMarkdown } from "../src/core/markdown.ts";
import { renderIndexPage, renderFragmentPage } from "../src/core/html.ts";
import type { FragmentManifest, StoredFragment } from "../src/core/types.ts";
import { makeDeps, testCtx, get } from "./helpers.ts";

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
  summary: "A short free summary.",
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

const htmlGet = (path: string) => get(path, { accept: "text/html,application/xhtml+xml" });

describe("renderMarkdown", () => {
  it("renders the documented content.md subset", () => {
    const out = renderMarkdown(
      "# Title\n\nA **bold** and _italic_ line with a [link](https://example.com).\n\n## Heading\n\n- one\n- two\n\n```js\nconst x = 1;\n```",
    );
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain('<a href="https://example.com">link</a>');
    expect(out).toContain("<h2>Heading</h2>");
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it("escapes HTML and neutralizes dangerous URLs", () => {
    const out = renderMarkdown("<script>alert(1)</script>\n\n[x](javascript:alert(1))");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain('<a href="#">x</a>');
  });
});

describe("renderIndexPage", () => {
  it("shows publisher, fragments, policy chips, meta lines, and the Sphere credit", () => {
    const out = renderIndexPage(
      {
        publisherName: "Acme Press",
        publisherSummary: "We publish things.",
        defaultLicense: "CC-BY-NC",
        host: "acme.example",
      },
      [
        { id: "2026-01-15-free", title: "Free Fragment", summary: "Free summary.", policy: "free", words: 1240, updatedTs: Date.UTC(2026, 5, 24) },
        { id: "2026-01-16-paid", title: "Paid Fragment", policy: "paid", words: 2980, updatedTs: Date.UTC(2026, 5, 21) },
      ],
    );
    expect(out).toContain("Acme Press");
    expect(out).toContain("PUBLISHER");
    expect(out).toContain("We publish things.");
    expect(out).toContain('href="/fragments/2026-01-15-free"');
    expect(out).toContain("chip--free");
    expect(out).toContain("chip--paid");
    expect(out).toContain("CC-BY-NC"); // node default license, not invented
    expect(out).toContain("2 fragments");
    expect(out).toContain("updated Jun 24, 2026"); // latest fragment date
    expect(out).toContain("1,240&nbsp;w&nbsp;·&nbsp;2026-01-15-free");
    expect(out).toContain("running on Sphere");
    expect(out).toContain("https://sphere.pub");
  });
});

describe("renderFragmentPage", () => {
  it("renders full content, license line, and machine chips for a free fragment", () => {
    const free = renderFragmentPage({ publisherName: "Acme", host: "acme.example" }, freeManifest, {
      markdown: "## Body\n\nfull text here",
      gated: false,
      words: 3,
      updatedTs: Date.UTC(2026, 5, 24),
    });
    expect(free).toContain("full text here");
    expect(free).toContain("200 · free"); // honest machine status
    expect(free).toContain("CC-BY"); // real fragment license
    expect(free).toContain("/fragments/2026-01-15-free/sphere.json");
    expect(free).toContain("/fragments/2026-01-15-free/content.md");
    expect(free).toContain("↑ machine-readable");
    expect(free).not.toContain("The rest of this fragment is paid");
  });

  it("renders the preview and the honest, not-charged gate for a paid fragment", () => {
    const gated = renderFragmentPage({ publisherName: "Acme", host: "acme.example" }, paidManifest, {
      markdown: "SECRET CONTE",
      gated: true,
      words: 100,
      previewWords: 2,
      updatedTs: Date.UTC(2026, 5, 21),
    });
    expect(gated).toContain("SECRET CONTE");
    expect(gated).toContain("402 · paid"); // honest machine status
    expect(gated).toContain("class=\"gate\"");
    expect(gated).toContain("The rest of this fragment is paid");
    expect(gated).toContain("$0.05 / read");
    expect(gated).toContain("returned, not charged");
  });
});

describe("human routes via content negotiation", () => {
  it("serves an HTML index for browser requests to /", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "free body");
    const res = await handleRequest(htmlGet("/"), deps, testCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Free Fragment");
    expect(body).toContain("Test Publisher");
  });

  it("leaves / as a 404 for non-HTML clients (machine contract unchanged)", async () => {
    const deps = makeDeps();
    const res = await handleRequest(get("/"), deps, testCtx());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("renders a free fragment page with full content", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "# Free Fragment\n\nThe whole body is here.");
    const res = await handleRequest(htmlGet("/fragments/2026-01-15-free"), deps, testCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("The whole body is here.");
    expect(body).not.toContain("The rest of this fragment is paid");
  });

  it("renders a gated fragment as a preview, never a 402 or the full body", async () => {
    const deps = makeDeps();
    seed(deps, paidManifest, "SECRET CONTENT that is long enough to be truncated");
    const res = await handleRequest(htmlGet("/fragments/2026-01-16-paid"), deps, testCtx());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("SECRET CONTE"); // first 12 chars
    expect(body).not.toContain("long enough to be truncated");
    expect(body).toContain("The rest of this fragment is paid");
    expect(body).toContain("returned, not charged");
  });

  it("does not leak the human surface into the machine content route", async () => {
    const deps = makeDeps();
    seed(deps, paidManifest, "SECRET CONTENT that is long enough to be truncated");
    // Even with an HTML Accept header, the machine path keeps its 402 contract.
    const res = await handleRequest(htmlGet("/fragments/2026-01-16-paid/content.md"), deps, testCtx());
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("serves an HTML 404 for an unknown fragment page", async () => {
    const deps = makeDeps();
    const res = await handleRequest(htmlGet("/fragments/nope"), deps, testCtx());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Not found");
  });

  it("logs ledger events for human views: discovery for index, preview for a gated read", async () => {
    const deps = makeDeps();
    seed(deps, paidManifest, "SECRET CONTENT that is long enough to be truncated");

    const ctx1 = testCtx();
    await handleRequest(htmlGet("/"), deps, ctx1);
    await ctx1.settle();

    const ctx2 = testCtx();
    await handleRequest(htmlGet("/fragments/2026-01-16-paid"), deps, ctx2);
    await ctx2.settle();

    const events = (deps.events as ReturnType<typeof makeDeps>["events"] & { events: { eventType: string }[] }).events;
    expect(events.map((e) => e.eventType)).toEqual(["discovery", "preview"]);
  });
});
