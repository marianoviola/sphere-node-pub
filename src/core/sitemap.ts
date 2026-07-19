// sitemap.xml builder. Pure: no I/O, no clock.
//
// Lists the human index and every fragment's canonical reading page. The root
// entry's <lastmod> is derived from the most recently updated fragment
// (omitted for an empty node), so this reflects only data the caller already
// has — no hidden dependency on the current time.

import type { StoredFragment } from "./types.ts";

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function urlEntry(loc: string, lastmod?: string): string {
  const lastmodLine = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : "";
  return `  <url>\n    <loc>${loc}</loc>${lastmodLine}\n  </url>`;
}

export function renderSitemap(fragments: StoredFragment[], origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const latest = fragments.reduce<number | undefined>(
    (max, f) => (max === undefined || f.updatedTs > max ? f.updatedTs : max),
    undefined,
  );
  const entries = [urlEntry(`${base}/`, latest !== undefined ? isoDate(latest) : undefined)];
  for (const f of fragments) {
    entries.push(urlEntry(`${base}/fragments/${f.manifest.id}`, isoDate(f.updatedTs)));
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`
  );
}
