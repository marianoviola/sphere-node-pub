import { describe, it, expect } from "vitest";
import { renderSitemap } from "../src/core/sitemap.ts";
import type { StoredFragment } from "../src/core/types.ts";

const ORIGIN = "https://node.example";

function frag(id: string, updatedTs: number): StoredFragment {
  return {
    manifest: { id, title: `Title ${id}`, license: "CC-BY", access: { policy: "free" } },
    contentKey: `fragments/${id}/content.md`,
    updatedTs,
  };
}

describe("renderSitemap", () => {
  it("lists only the root entry, with no lastmod, for an empty node", () => {
    const xml = renderSitemap([], ORIGIN);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml).not.toContain("<lastmod>");
  });

  it("lists the root plus every fragment's canonical URL, each with its own lastmod", () => {
    const xml = renderSitemap(
      [frag("2026-01-15-a", Date.parse("2026-01-15T00:00:00Z")), frag("2026-01-16-b", Date.parse("2026-01-16T00:00:00Z"))],
      ORIGIN,
    );
    expect(xml).toContain(`<loc>${ORIGIN}/fragments/2026-01-15-a</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/fragments/2026-01-16-b</loc>`);
    // Root lastmod tracks the most recently updated fragment.
    const rootBlock = xml.slice(xml.indexOf(`<loc>${ORIGIN}/</loc>`), xml.indexOf(`<loc>${ORIGIN}/fragments/`));
    expect(rootBlock).toContain("<lastmod>2026-01-16</lastmod>");
  });

  it("does not double the origin when it carries a trailing slash", () => {
    const xml = renderSitemap([frag("2026-01-15-a", 1)], `${ORIGIN}/`);
    expect(xml).toContain(`<loc>${ORIGIN}/fragments/2026-01-15-a</loc>`);
    expect(xml).not.toContain("//fragments");
  });
});
