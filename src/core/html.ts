// Human-readable surface for the node. Pure functions: fragment/publisher data
// (plus, for a reading page, the content string) in, a complete HTML document
// out. No I/O and no Cloudflare imports — the platform layer loads the data and
// calls these. This is the minimal reading template the future rich version
// will extend (relations, media, richer previews); none of that ships now.

import type { FragmentManifest } from "./types.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";

// The footer credits the Sphere project itself (the upstream software), the same
// for every deployer — this is attribution, not coupling to any one publisher.
export const SPHERE_PROJECT_URL = "https://sphere.pub";
export const SPHERE_GETTING_STARTED_URL = "https://sphere.pub/docs/getting-started";

/** Publisher chrome shared by every page, driven by node config + data. */
export interface SiteChrome {
  publisherName: string;
  publisherSummary?: string;
}

/** One row in the index list. */
export interface IndexFragmentView {
  id: string;
  title: string;
  summary?: string;
  policy: string;
}

const BASE_CSS = `
:root {
  --ink: #1b1b1a;
  --muted: #6b6b66;
  --line: #e6e4dd;
  --bg: #fbfaf7;
  --accent: #2f6f4f;
  --link: #1f5fa8;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
}
.wrap { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
a { color: var(--link); }
header.site { border-bottom: 1px solid var(--line); }
header.site .wrap { padding-bottom: 1.5rem; padding-top: 2rem; }
.pub-name { font-size: 1.05rem; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
.pub-name a { color: var(--ink); text-decoration: none; }
.pub-summary { color: var(--muted); margin: 0.35rem 0 0; font-size: 0.95rem; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 0.5rem; }
.frag-list { list-style: none; margin: 1.5rem 0 0; padding: 0; }
.frag-list li { padding: 1.1rem 0; border-bottom: 1px solid var(--line); }
.frag-list a.title { font-size: 1.15rem; font-weight: 600; text-decoration: none; color: var(--ink); }
.frag-list a.title:hover { color: var(--link); }
.frag-list .summary { color: var(--muted); margin: 0.3rem 0 0; font-size: 0.95rem; }
.badge {
  display: inline-block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; padding: 0.12rem 0.5rem; border-radius: 999px; vertical-align: middle;
  margin-left: 0.5rem; border: 1px solid var(--line);
}
.badge--free { color: var(--accent); border-color: #cfe6da; background: #f0f7f3; }
.badge--paid { color: #8a5a16; border-color: #ecd8b6; background: #fbf4e6; }
.badge--metered { color: #8a5a16; border-color: #ecd8b6; background: #fbf4e6; }
.badge--sponsored { color: #5a4a8a; border-color: #ddd6ee; background: #f4f1fb; }
article.fragment { font-family: Georgia, "Times New Roman", serif; }
article.fragment h1, article.fragment h2, article.fragment h3 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  line-height: 1.3;
}
article.fragment h2 { font-size: 1.35rem; margin-top: 2rem; }
article.fragment h3 { font-size: 1.1rem; margin-top: 1.5rem; }
article.fragment p { margin: 1rem 0; }
article.fragment pre {
  background: #f3f1ea; border: 1px solid var(--line); border-radius: 6px;
  padding: 0.9rem 1rem; overflow-x: auto; font-size: 0.9rem;
}
article.fragment code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
}
article.fragment :not(pre) > code { background: #f3f1ea; padding: 0.1rem 0.35rem; border-radius: 4px; }
article.fragment blockquote {
  margin: 1rem 0; padding: 0.2rem 1rem; border-left: 3px solid var(--line); color: var(--muted);
}
article.fragment img { max-width: 100%; height: auto; }
.meta { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.5rem; }
.meta a { color: var(--muted); }
.gate-note {
  margin: 2rem 0 0; padding: 1rem 1.25rem; border: 1px solid var(--line);
  border-radius: 8px; background: #fff; color: var(--muted); font-family: -apple-system, sans-serif;
  font-size: 0.95rem;
}
.gate-note strong { color: var(--ink); }
.back { display: inline-block; margin-bottom: 1.5rem; font-size: 0.9rem; text-decoration: none; }
footer.site { border-top: 1px solid var(--line); margin-top: 3rem; }
footer.site .wrap { padding-top: 1.5rem; padding-bottom: 2.5rem; color: var(--muted); font-size: 0.85rem; }
footer.site a { color: var(--muted); }
`;

const POLICY_LABELS: Record<string, string> = {
  free: "Free",
  paid: "Paid",
  metered: "Metered",
  sponsored: "Sponsored",
};

function badge(policy: string): string {
  const label = POLICY_LABELS[policy] ?? policy;
  const cls = POLICY_LABELS[policy] ? policy : "free";
  return `<span class="badge badge--${cls}">${escapeHtml(label)}</span>`;
}

function header(chrome: SiteChrome): string {
  const summary = chrome.publisherSummary
    ? `<p class="pub-summary">${escapeHtml(chrome.publisherSummary)}</p>`
    : "";
  return `<header class="site"><div class="wrap">
    <p class="pub-name"><a href="/">${escapeHtml(chrome.publisherName)}</a></p>
    ${summary}
  </div></header>`;
}

function footer(): string {
  return `<footer class="site"><div class="wrap">
    Published with <a href="${SPHERE_PROJECT_URL}">Sphere</a> &middot;
    <a href="${SPHERE_GETTING_STARTED_URL}">Run your own node</a>
  </div></footer>`;
}

function layout(title: string, chrome: SiteChrome, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${header(chrome)}
<main class="wrap">
${main}
</main>
${footer()}
</body>
</html>`;
}

/** The publisher index: summary plus a list of fragments. */
export function renderIndexPage(chrome: SiteChrome, fragments: IndexFragmentView[]): string {
  const list = fragments.length
    ? `<ul class="frag-list">${fragments
        .map((f) => {
          const summary = f.summary
            ? `<p class="summary">${escapeHtml(f.summary)}</p>`
            : "";
          return `<li>
            <a class="title" href="/fragments/${encodeURIComponent(f.id)}">${escapeHtml(f.title)}</a>${badge(f.policy)}
            ${summary}
          </li>`;
        })
        .join("")}</ul>`
    : `<p class="meta">No fragments published yet.</p>`;

  const main = `<h1>Fragments</h1>${list}`;
  return layout(chrome.publisherName, chrome, main);
}

/** A single fragment reading page. `markdown` is full content (free) or the preview slice (gated). */
export function renderFragmentPage(
  chrome: SiteChrome,
  manifest: FragmentManifest,
  body: { markdown: string; gated: boolean },
): string {
  const meta = `<p class="meta">${escapeHtml(manifest.license)} ${badge(manifest.access.policy)}</p>`;
  const summary = manifest.summary ? `<p class="meta">${escapeHtml(manifest.summary)}</p>` : "";
  const content = `<article class="fragment">${renderMarkdown(body.markdown)}</article>`;
  const gate = body.gated
    ? `<p class="gate-note"><strong>This is a preview.</strong> The full fragment is
       available under a ${escapeHtml(manifest.access.policy)} access policy and is served
       to agents that complete the payment challenge at
       <code>/fragments/${escapeHtml(manifest.id)}/content.md</code>.</p>`
    : "";

  const main = `<a class="back" href="/">&larr; All fragments</a>
    <h1>${escapeHtml(manifest.title)}</h1>
    ${summary}${meta}${content}${gate}`;
  return layout(`${manifest.title} — ${chrome.publisherName}`, chrome, main);
}

/** A browser-friendly 404 so a human never sees a raw JSON error. */
export function renderNotFoundPage(chrome: SiteChrome, message: string): string {
  const main = `<h1>Not found</h1><p class="meta">${escapeHtml(message)}</p>
    <a class="back" href="/">&larr; All fragments</a>`;
  return layout(`Not found — ${chrome.publisherName}`, chrome, main);
}
