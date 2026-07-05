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

  it("renders GFM pipe tables with alignment", () => {
    const out = renderMarkdown(
      "| Name | Score |\n| :--- | ----: |\n| Ada  | 9     |\n| Lin  | 12    |",
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect(out).toContain('<th style="text-align:left">Name</th>');
    expect(out).toContain('<th style="text-align:right">Score</th>');
    expect(out).toContain('<td style="text-align:right">9</td>');
    expect(out).toContain("<td style=\"text-align:left\">Lin</td>");
  });

  it("emits a mermaid block for client-side rendering, not a code block", () => {
    const out = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");
    expect(out).toContain('<pre class="mermaid">');
    expect(out).toContain("A --&gt; B"); // entity decodes to A --> B in textContent
    expect(out).not.toContain("language-mermaid");
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

  it("renders the mark from the served asset and links the name to publisher.url", () => {
    const out = renderIndexPage(
      { publisherName: "Acme Press", publisherUrl: "https://acme.example", publisherIcon: "/assets/sphere-mark.svg" },
      [{ id: "x", title: "X", policy: "free", words: 10, updatedTs: Date.UTC(2026, 0, 1) }],
    );
    expect(out).toContain('src="/assets/sphere-mark.svg"'); // mark from served asset, not inline svg
    expect(out).toContain('<a class="pub-link" href="https://acme.example">Acme Press</a>');
  });

  it("advertises the machine discovery document with an alternate link", () => {
    const out = renderIndexPage({ publisherName: "Acme Press" }, [
      { id: "x", title: "X", policy: "free", words: 10, updatedTs: Date.UTC(2026, 0, 1) },
    ]);
    expect(out).toContain('<link rel="alternate" type="application/json" href="/.well-known/sphere.json">');
  });

  it("is mobile-responsive: viewport meta and a stacking breakpoint", () => {
    const out = renderIndexPage({ publisherName: "Acme Press" }, [
      { id: "x", title: "X", policy: "free", words: 10, updatedTs: Date.UTC(2026, 0, 1) },
    ]);
    expect(out).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(out).toContain("@media (max-width: 640px)");
    expect(out).toContain("flex-direction: column"); // index rows stack on mobile
  });

  it("renders a friendly empty state for a node with no fragments", () => {
    const out = renderIndexPage({ publisherName: "Acme Press" }, []);
    // Live, not broken: one line of reassurance...
    expect(out).toContain("This node is live and ready.");
    // ...and one line on how to publish the first fragment.
    expect(out).toContain("publish_fragment");
    expect(out).toContain("scripts/publish.ts");
    // Still a full, valid page with the publisher chrome and Sphere credit.
    expect(out).toContain("Acme Press");
    expect(out).toContain("running on Sphere");
    // No fragment rows rendered.
    expect(out).not.toContain('class="frag"');
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

  it("renders a typed Sources section (linked) for a fragment with sources", () => {
    const withSources: FragmentManifest = {
      id: "2026-01-15-free",
      title: "Free Fragment",
      license: "CC-BY",
      access: { policy: "free" },
      sources: [
        { type: "book", title: "The Structural Transformation of the Public Sphere", author: "Jürgen Habermas", date: "1962" },
        { type: "webpage", title: "Pay Per Crawl", url: "https://blog.cloudflare.com/introducing-pay-per-crawl/" },
      ],
    };
    const out = renderFragmentPage({ publisherName: "Acme", host: "acme.example" }, withSources, {
      markdown: "## Body\n\ntext",
      gated: false,
      words: 2,
      updatedTs: Date.UTC(2026, 0, 15),
    });
    expect(out).toContain('class="sources"');
    expect(out).toContain(">SOURCES<");
    expect(out).toContain("The Structural Transformation of the Public Sphere");
    expect(out).toContain("Jürgen Habermas");
    expect(out).toContain('<a class="source-title" href="https://blog.cloudflare.com/introducing-pay-per-crawl/"');
    expect(out).toContain(">book<");
  });

  it("renders no Sources section when sources is empty or absent", () => {
    const out = renderFragmentPage({ publisherName: "Acme" }, freeManifest, {
      markdown: "x",
      gated: false,
      words: 1,
      updatedTs: Date.UTC(2026, 0, 15),
    });
    expect(out).not.toContain('class="sources"');
  });

  it("does not surface legacy internal-lineage entries (no title) as sources", () => {
    const legacy = {
      ...freeManifest,
      // The old internal-lineage shape: kind/url/label, no title.
      sources: [{ kind: "text", url: "https://github.com/x/blob/main/doc.md", label: "Original Markdown source" }],
    } as unknown as FragmentManifest;
    const out = renderFragmentPage({ publisherName: "Acme" }, legacy, {
      markdown: "x",
      gated: false,
      words: 1,
      updatedTs: Date.UTC(2026, 0, 15),
    });
    expect(out).not.toContain('class="sources"');
    expect(out).not.toContain("Original Markdown source");
  });

  it("renders a Related section: same-node resolved, unknown id degraded, external linked out", () => {
    const withRelations: FragmentManifest = {
      id: "2026-01-15-free",
      title: "Free Fragment",
      license: "CC-BY",
      access: { policy: "free" },
      relations: [
        { type: "continues", target: "2026-01-14-prequel" },
        { type: "responds-to", target: "2026-01-10-missing" },
        { type: "cites", target: "https://other.node/fragments/2026-01-10-source" },
      ],
    };
    const out = renderFragmentPage(
      { publisherName: "Acme", host: "acme.example" },
      withRelations,
      { markdown: "## Body\n\ntext", gated: false, words: 2, updatedTs: Date.UTC(2026, 0, 15) },
      new Map([["2026-01-14-prequel", "The Prequel"]]),
    );
    expect(out).toContain('class="relations"');
    expect(out).toContain(">RELATED<");
    // Same-node target resolves to a title and links to its reading page.
    expect(out).toContain('<a class="relation-target" href="/fragments/2026-01-14-prequel">The Prequel</a>');
    expect(out).toContain(">continues<");
    // Unknown same-node id degrades to plain text (no link), never throws.
    expect(out).toContain('<span class="relation-target">2026-01-10-missing</span>');
    // External target links out, marked external with rel="noopener".
    expect(out).toContain('<a class="relation-target" href="https://other.node/fragments/2026-01-10-source" rel="noopener">');
    expect(out).toContain('class="relation-ext"');
  });

  it("renders no Related section when relations is empty or absent", () => {
    const out = renderFragmentPage({ publisherName: "Acme" }, freeManifest, {
      markdown: "x",
      gated: false,
      words: 1,
      updatedTs: Date.UTC(2026, 0, 15),
    });
    expect(out).not.toContain('class="relations"');
    expect(out).not.toContain(">RELATED<");
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

  it("serves the discovery document for machine requests to / (never 404)", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "free body");

    // A generic agent handed the bare URL asks for JSON (or */*): the front door
    // greets it with the same document as /.well-known/sphere.json, not a 404.
    const root = await handleRequest(get("/", { accept: "application/json" }), deps, testCtx());
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("application/json");

    const wellKnown = await handleRequest(get("/.well-known/sphere.json"), deps, testCtx());
    expect(await root.text()).toBe(await wellKnown.text()); // same builder, same bytes
  });

  it("serves the machine root for a wildcard Accept (*/*), not a 404", async () => {
    const deps = makeDeps();
    const res = await handleRequest(get("/", { accept: "*/*" }), deps, testCtx());
    expect(res.status).toBe(200);
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

  it("resolves same-node relation titles from the catalog on the reading page", async () => {
    const deps = makeDeps();
    seed(deps, { ...freeManifest, id: "2026-01-14-prequel", title: "The Prequel" }, "prequel body");
    seed(
      deps,
      {
        ...freeManifest,
        relations: [
          { type: "continues", target: "2026-01-14-prequel" },
          { type: "cites", target: "https://other.node/fragments/2026-01-10-source" },
        ],
      },
      "# Free Fragment\n\nThe whole body is here.",
    );
    const res = await handleRequest(htmlGet("/fragments/2026-01-15-free"), deps, testCtx());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(">RELATED<");
    // The same-node target's title is resolved from deps.fragments.list().
    expect(body).toContain('href="/fragments/2026-01-14-prequel">The Prequel</a>');
    expect(body).toContain('href="https://other.node/fragments/2026-01-10-source" rel="noopener"');
  });

  it("does not leak the human surface into the machine content route", async () => {
    const deps = makeDeps();
    seed(deps, paidManifest, "SECRET CONTENT that is long enough to be truncated");
    // Even with an HTML Accept header, the machine path keeps its 402 contract.
    const res = await handleRequest(htmlGet("/fragments/2026-01-16-paid/content.md"), deps, testCtx());
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("serves brand assets regardless of Accept, and links them in page <head>", async () => {
    const deps = makeDeps();
    seed(deps, freeManifest, "free body");

    const favicon = await handleRequest(get("/favicon.svg"), deps, testCtx());
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toContain("image/svg+xml");

    const og = await handleRequest(get("/og.png"), deps, testCtx());
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toContain("image/png");
    const ogBytes = new Uint8Array(await og.arrayBuffer());
    expect(ogBytes.byteLength).toBeGreaterThan(1000);
    // PNG magic number — confirms we decoded real image bytes, not text.
    expect(Array.from(ogBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const icon = await handleRequest(get("/icon.png"), deps, testCtx());
    expect(icon.headers.get("content-type")).toContain("image/png");

    const page = await (await handleRequest(htmlGet("/"), deps, testCtx())).text();
    expect(page).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg"');
    expect(page).toContain('property="og:image" content="https://node.example/og.png"');
    expect(page).toContain('name="twitter:card" content="summary_large_image"');
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
