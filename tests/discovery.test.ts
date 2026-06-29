import { describe, it, expect } from "vitest";
import { buildDiscovery, SPHERE_VERSION } from "../src/core/discovery.ts";
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
