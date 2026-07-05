import { describe, it, expect } from "vitest";
import { buildDiscovery, renderLlmsTxt, SPHERE_VERSION } from "../src/core/discovery.ts";
import type { StoredFragment } from "../src/core/types.ts";

const config = {
  publisher: {
    name: "Test Publisher",
    summary: "We publish things.",
    url: "https://pub.example",
    icon: "https://pub.example/mark.svg",
  },
  defaultLicense: "CC-BY",
};

function frag(id: string, policy: "free" | "paid"): StoredFragment {
  return {
    manifest: { id, title: `Title ${id}`, license: "CC-BY", access: { policy } },
    contentKey: `fragments/${id}/content.md`,
    updatedTs: 1,
  };
}

describe("buildDiscovery", () => {
  it("produces a valid empty document with zero fragments", () => {
    const doc = buildDiscovery(config, []);
    expect(doc.sphere_version).toBe(SPHERE_VERSION);
    expect(doc.publisher.name).toBe("Test Publisher");
    // Publisher attribution fields travel in the discovery document.
    expect(doc.publisher.summary).toBe("We publish things.");
    expect(doc.publisher.url).toBe("https://pub.example");
    expect(doc.publisher.icon).toBe("https://pub.example/mark.svg");
    expect(doc.default_license).toBe("CC-BY");
    expect(doc.fragment_count).toBe(0);
    expect(doc.fragments).toEqual([]);
  });

  it("lists fragments with manifest and content links", () => {
    const doc = buildDiscovery(config, [frag("2026-01-15-a", "free"), frag("2026-01-16-b", "paid")]);
    expect(doc.fragment_count).toBe(2);
    expect(doc.fragments[0]).toEqual({
      id: "2026-01-15-a",
      title: "Title 2026-01-15-a",
      policy: "free",
      manifest: "/fragments/2026-01-15-a/sphere.json",
      content: "/fragments/2026-01-15-a/content.md",
    });
  });
});

describe("renderLlmsTxt", () => {
  const ORIGIN = "https://node.example";

  it("renders a valid aid for an empty node with no fragment lines", () => {
    const txt = renderLlmsTxt(buildDiscovery(config, []), ORIGIN);
    expect(txt).toContain("# Test Publisher");
    expect(txt).toContain("> We publish things.");
    // Points at the authoritative machine discovery, absolute.
    expect(txt).toContain(`${ORIGIN}/.well-known/sphere.json`);
    // Empty, but valid: no fragment links, an explicit note instead.
    expect(txt).toContain("No fragments published yet.");
    expect(txt).not.toContain("](https://node.example/fragments/");
  });

  it("lists each fragment as an absolute content.md link with its title", () => {
    const txt = renderLlmsTxt(
      buildDiscovery(config, [frag("2026-01-15-a", "free"), frag("2026-01-16-b", "paid")]),
      ORIGIN,
    );
    expect(txt).toContain("- [Title 2026-01-15-a](https://node.example/fragments/2026-01-15-a/content.md) (free)");
    expect(txt).toContain("- [Title 2026-01-16-b](https://node.example/fragments/2026-01-16-b/content.md) (paid)");
  });

  it("does not double the origin when it carries a trailing slash", () => {
    const txt = renderLlmsTxt(buildDiscovery(config, [frag("2026-01-15-a", "free")]), `${ORIGIN}/`);
    expect(txt).toContain("https://node.example/fragments/2026-01-15-a/content.md");
    expect(txt).not.toContain("https://node.example//");
  });
});
