// Human-readable surface for the node — "Direction A, Editorial Paper".
//
// Pure functions: fragment/publisher data (plus, for a reading page, the content
// string) in, a complete HTML document out. No I/O and no Cloudflare imports —
// the platform layer loads the data and calls these.
//
// This renders the warm, reading-first design: Newsreader serif for headings and
// body, Spline Sans Mono for meta/labels/chips, a paper palette, and the glossy
// Sphere mark. The machine signals (status line, policy chips, machine-readable
// links) are kept quiet alongside the prose. The dormant payment seam is built
// from the design but only appears for paid/metered fragments; today everything
// is free, so it simply never renders. In v1 a gate is *shown*, never charged.

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
  /** Node default license, shown in the index meta line and footer. */
  defaultLicense?: string;
  /** Request host (e.g. "quietfield.org"), shown quietly in the status line. */
  host?: string;
  /** Publisher's canonical URL; the publisher name links to it when present. */
  publisherUrl?: string;
  /** URL to the publisher mark (defaults to the node's served mark). */
  publisherIcon?: string;
}

/** One row in the index list. */
export interface IndexFragmentView {
  id: string;
  title: string;
  summary?: string;
  policy: string;
  /** Word count of the fragment body, for the "NNN w · slug" meta line. */
  words: number;
  /** Last-updated timestamp (ms epoch), for the index "updated DATE" line. */
  updatedTs: number;
}

/** Reading-page body data: the markdown plus the counts the chrome needs. */
export interface FragmentBody {
  /** Full content (free) or the bounded preview slice (gated). */
  markdown: string;
  gated: boolean;
  /** Total words in the full content (drives "min read" and the gate counts). */
  words: number;
  /** Words shown in the preview (gated only). */
  previewWords?: number;
  /** Last-updated timestamp (ms epoch), for the dateline. */
  updatedTs: number;
}

// --- Design tokens -----------------------------------------------------------
// Direction A, Editorial Paper. Light ships first; the warm dark theme rides on
// the reader's OS preference (the seam the design leaves open). The accent is a
// single token — mauve is the shipped default; swap --accent to re-theme.

const BASE_CSS = `
:root {
  --bg: #f7f4ec;
  --panel: #efe9dc;
  --ink: #211d18;
  --muted: #6b6258;
  --hair: #e4ddcf;
  --accent: #8a5a7d;
  --accent-soft: color-mix(in srgb, var(--accent) 15%, transparent);
  --eyebrow: #b09f86;
  --meta: #a3987f;
  --quote: #3a342b;
  --chip: #fffdf7;
  --ok: #4f7a52;
  --ok-soft: #e8efe4;
  --warn: #9a7a2e;
  --warn-soft: #f1ebd8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1712;
    --panel: #16120e;
    --ink: #ece3d4;
    --muted: #a59a87;
    --hair: #352e25;
    --accent-soft: color-mix(in srgb, var(--accent) 24%, transparent);
    --eyebrow: #857a66;
    --meta: #8c8270;
    --quote: #ece3d4;
    --chip: #221c16;
    --ok: #86b083;
    --ok-soft: #27301f;
    --warn: #c9a559;
    --warn-soft: #332a17;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: Newsreader, Georgia, "Times New Roman", serif;
  -webkit-font-smoothing: antialiased;
}
.shell { max-width: 900px; margin: 0 auto; padding: 26px 26px 90px; }
.mono { font-family: "Spline Sans Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }

/* Masthead: the canonical mark, the wordmark, and a NODE micro-label. */
.masthead { display: flex; align-items: center; gap: 11px; padding-bottom: 26px; }
.orb { display: block; border-radius: 50%; flex: none; }
.wordmark { display: flex; flex-direction: column; line-height: 1; }
.wordmark .name { font-weight: 600; font-size: 21px; letter-spacing: -0.012em; }
.wordmark .node {
  font-family: "Spline Sans Mono", ui-monospace, monospace;
  font-size: 9px; letter-spacing: 0.36em; color: var(--meta); margin-top: 4px;
}

/* Page card. */
.card {
  background: var(--bg); border: 1px solid var(--hair); border-radius: 4px;
  box-shadow: 0 1px 4px rgba(20, 12, 4, 0.07); overflow: hidden;
}
.statusbar {
  display: flex; justify-content: space-between; align-items: center; gap: 8px 16px;
  flex-wrap: wrap; padding: 11px 24px; background: var(--panel); border-bottom: 1px solid var(--hair);
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 11px;
  letter-spacing: 0.02em; color: var(--meta);
}
.statusbar span { overflow-wrap: anywhere; min-width: 0; }
.status--paid { color: var(--accent); }
.status--metered { color: var(--warn); }
.status--sponsored { color: var(--accent); }

/* Status chip (policy). */
.chip {
  display: inline-block; font-family: "Spline Sans Mono", ui-monospace, monospace;
  font-size: 10px; letter-spacing: 0.04em; padding: 3px 8px; border-radius: 3px;
}
.chip--free, .dot--free { color: var(--ok); }
.chip--free { background: var(--ok-soft); }
.chip--paid, .chip--sponsored, .dot--paid, .dot--sponsored { color: var(--accent); }
.chip--paid, .chip--sponsored { background: var(--accent-soft); }
.chip--metered, .dot--metered { color: var(--warn); }
.chip--metered { background: var(--warn-soft); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.dot--free { background: var(--ok); }
.dot--paid, .dot--sponsored { background: var(--accent); }
.dot--metered { background: var(--warn); }

/* Index: publisher header + fragment rows + footer. */
.pub { padding: 40px 44px 30px; }
.eyebrow {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 10px;
  letter-spacing: 0.22em; color: var(--eyebrow); margin-bottom: 16px;
}
.pub h1 { margin: 0; font-weight: 500; font-size: clamp(2rem, 8vw, 48px); line-height: 1.04; letter-spacing: -0.012em; }
.pub-link { color: inherit; text-decoration: none; }
.pub-link:hover { color: var(--accent); }
.pub-summary {
  margin: 14px 0 0; font-size: 18px; line-height: 1.5; font-style: italic;
  color: var(--muted); max-width: 30em;
}
.pub-meta {
  margin-top: 20px; font-family: "Spline Sans Mono", ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.02em; color: var(--meta); overflow-wrap: anywhere;
}
.frag {
  border-top: 1px solid var(--hair); display: flex; justify-content: space-between;
  align-items: flex-start; gap: 24px; padding: 22px 44px; text-decoration: none; color: inherit;
}
a.frag:hover .frag-title { color: var(--accent); }
.frag-head { display: flex; align-items: center; gap: 9px; }
.frag-title { font-size: 22px; font-weight: 500; letter-spacing: -0.005em; transition: color 0.15s ease; }
.frag-desc { margin: 5px 0 0 15px; font-size: 15px; line-height: 1.45; color: var(--muted); }
.frag-right { text-align: right; flex: none; padding-top: 2px; }
.frag-right .wc {
  margin-top: 8px; font-family: "Spline Sans Mono", ui-monospace, monospace;
  font-size: 11px; color: var(--meta); overflow-wrap: anywhere;
}
.foot {
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding: 16px 44px; background: var(--panel); border-top: 1px solid var(--hair);
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 11px;
  letter-spacing: 0.02em; color: var(--meta);
}
.foot a { color: inherit; text-decoration: none; }
.foot a:hover { color: var(--accent); }
.foot .running { display: flex; align-items: center; gap: 8px; }

/* Reading page. */
.read-head { padding: 34px 64px 4px; }
.back {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 11px;
  letter-spacing: 0.04em; color: var(--accent); text-decoration: none;
}
.back:hover { text-decoration: underline; }
.read-head h1 {
  margin: 18px 0 0; font-weight: 500; font-size: clamp(1.75rem, 7vw, 40px); line-height: 1.1;
  letter-spacing: -0.014em; max-width: 14em; overflow-wrap: anywhere;
}
.dek { margin: 14px 0 0; font-size: 18px; font-style: italic; line-height: 1.4; color: var(--muted); }
.read-meta {
  display: flex; align-items: center; gap: 14px; margin-top: 18px;
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 11px;
  letter-spacing: 0.02em; color: var(--meta); flex-wrap: wrap;
}
.read-meta .chip { font-size: 11px; }
.rule { height: 1px; background: var(--hair); margin: 26px 64px 0; }

article.fragment { padding: 28px 64px 8px; font-size: 19px; line-height: 1.68; }
article.fragment.is-gated { position: relative; padding-bottom: 0; }
article.fragment p { margin: 0 0 1.1em; }
article.fragment.is-gated p:last-of-type { margin-bottom: 0; }
article.fragment h2 { font-weight: 600; font-size: 1.45em; line-height: 1.2; margin: 1.6em 0 0.5em; letter-spacing: -0.01em; }
article.fragment h3 { font-weight: 600; font-size: 1.2em; line-height: 1.25; margin: 1.4em 0 0.4em; }
article.fragment blockquote {
  margin: 1.4em 0; padding: 4px 0 4px 24px; border-left: 2px solid var(--accent);
  font-size: 25px; line-height: 1.32; font-style: italic; color: var(--quote);
}
article.fragment ul, article.fragment ol { margin: 1em 0; padding-left: 1.4em; }
article.fragment li { margin: 0.3em 0; }
article.fragment a { color: var(--accent); }
article.fragment img { max-width: 100%; height: auto; border-radius: 4px; }
article.fragment pre {
  background: var(--panel); border: 1px solid var(--hair); border-radius: 6px;
  padding: 0.9rem 1rem; overflow-x: auto; font-size: 0.78em;
}
article.fragment code {
  font-family: "Spline Sans Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82em;
}
article.fragment :not(pre) > code { background: var(--panel); padding: 0.1em 0.35em; border-radius: 4px; }
article.fragment table { width: 100%; border-collapse: collapse; margin: 1.4em 0; font-size: 0.8em; }
article.fragment th, article.fragment td {
  text-align: left; padding: 0.55em 0.85em; border-bottom: 1px solid var(--hair); vertical-align: top;
}
article.fragment thead th {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-weight: 500; font-size: 0.92em;
  letter-spacing: 0.02em; color: var(--meta); border-bottom: 1px solid var(--ink);
}
article.fragment tbody tr:last-child td { border-bottom: none; }
article.fragment pre.mermaid {
  background: none; border: 0; border-radius: 0; padding: 0; margin: 1.6em 0;
  text-align: center; overflow-x: auto; line-height: 1.2; color: var(--ink);
}
.fade {
  position: absolute; left: 0; right: 0; bottom: 0; height: 120px;
  background: linear-gradient(to bottom, transparent, var(--bg));
}

/* Sources: typed external provenance, shown for humans. */
.sources { margin: 14px 64px 0; padding: 20px 0 4px; border-top: 1px solid var(--hair); }
.sources-label {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 10px;
  letter-spacing: 0.22em; color: var(--eyebrow); margin-bottom: 14px;
}
.source-list { list-style: none; margin: 0; padding: 0; }
.source { display: flex; gap: 12px; padding: 7px 0; align-items: baseline; }
.source-type {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 9px; letter-spacing: 0.08em;
  color: var(--meta); background: var(--chip); border: 1px solid var(--hair); border-radius: 3px;
  padding: 3px 7px; flex: none; min-width: 66px; text-align: center; text-transform: uppercase;
}
.source-main { flex: 1; min-width: 0; font-size: 16px; line-height: 1.45; }
.source-title { color: var(--ink); text-decoration: none; }
a.source-title { color: var(--accent); }
a.source-title:hover { text-decoration: underline; }
.source-by { color: var(--muted); font-style: italic; }
.source-meta { color: var(--meta); font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 12px; }
.source-note { margin: 3px 0 0; font-size: 13.5px; line-height: 1.45; color: var(--muted); }

/* Related: typed edges to other fragments, shown for humans. */
.relations { margin: 14px 64px 0; padding: 20px 0 4px; border-top: 1px solid var(--hair); }
.relations-label {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 10px;
  letter-spacing: 0.22em; color: var(--eyebrow); margin-bottom: 14px;
}
.relation-list { list-style: none; margin: 0; padding: 0; }
.relation { display: flex; gap: 12px; padding: 7px 0; align-items: baseline; }
.relation-type {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 9px; letter-spacing: 0.08em;
  color: var(--meta); background: var(--chip); border: 1px solid var(--hair); border-radius: 3px;
  padding: 3px 7px; flex: none; min-width: 66px; text-align: center; text-transform: uppercase;
}
.relation-main { flex: 1; min-width: 0; font-size: 16px; line-height: 1.45; overflow-wrap: anywhere; }
.relation-target { color: var(--ink); text-decoration: none; }
a.relation-target { color: var(--accent); }
a.relation-target:hover { text-decoration: underline; }
.relation-ext {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 11px; color: var(--meta);
  margin-left: 6px; white-space: nowrap;
}

.license {
  margin: 14px 64px 0; padding: 18px 0; border-top: 1px solid var(--hair);
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 11px; color: var(--meta);
}
.license .code { color: var(--quote); }
.machine-row {
  display: flex; gap: 10px; padding: 0 64px 32px; flex-wrap: wrap;
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 11px;
}
.mchip {
  color: var(--accent); border: 1px solid var(--hair); background: var(--chip);
  padding: 6px 12px; border-radius: 4px; text-decoration: none;
}
.mchip:hover { border-color: var(--accent); }
.mchip--note { color: var(--meta); margin-left: auto; }

/* Gate panel (paid / metered). */
.gate { margin: 0 64px 36px; padding: 22px 24px; background: var(--panel); border: 1px solid var(--hair); border-radius: 5px; }
.gate-top { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.gate-title { font-size: 17px; font-weight: 500; color: var(--quote); }
.gate-price { font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 13px; color: var(--accent); white-space: nowrap; }
.gate p { margin: 8px 0 0; font-size: 15px; line-height: 1.5; color: var(--muted); max-width: 42em; }
.gate p .file { font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 12px; color: var(--meta); }
.gate-actions { display: flex; align-items: center; gap: 14px; margin-top: 16px; flex-wrap: wrap; }
.gate-unlock {
  font-family: "Spline Sans Mono", ui-monospace, monospace; font-size: 12px; color: var(--meta);
  background: var(--chip); border: 1px solid var(--hair); padding: 9px 18px; border-radius: 5px;
}
.gate-note { font-size: 13.5px; font-style: italic; color: var(--meta); }

/* Browser 404. */
.notfound { padding: 40px 44px; }
.notfound h1 { margin: 0 0 0.5rem; font-weight: 500; font-size: clamp(1.6rem, 6vw, 36px); letter-spacing: -0.012em; }
.notfound p { margin: 0 0 1.2rem; color: var(--muted); font-size: 17px; }

@media (max-width: 640px) {
  .shell { padding: 18px 14px 72px; }

  /* Tighter horizontal padding so the prose and rows use the full width. */
  .statusbar { padding: 11px 18px; }
  .pub { padding: 30px 22px 24px; }
  .foot { padding: 16px 22px; flex-wrap: wrap; gap: 6px 16px; }
  .read-head { padding: 28px 22px 4px; }
  .rule, .license, .sources, .relations { margin-left: 22px; margin-right: 22px; }
  .source, .relation { flex-wrap: wrap; gap: 8px 12px; }
  .machine-row { padding: 0 22px 28px; }
  .gate { margin: 0 22px 28px; }
  .notfound { padding: 30px 22px; }

  /* Index rows: stack the meta (chip + word-count/slug) below the title so the
     two columns never collide on a narrow screen. */
  .frag { flex-direction: column; gap: 10px; padding: 18px 22px; }
  .frag-head { align-items: flex-start; }
  .frag-head .dot { margin-top: 9px; }
  .frag-right { text-align: left; padding-top: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 10px 12px; }
  .frag-right .wc { margin-top: 0; }

  /* Comfortable reading size and a lighter blockquote on small screens. */
  article.fragment { padding: 24px 22px 8px; font-size: 17px; line-height: 1.62; }
  article.fragment blockquote { font-size: 20px; padding-left: 16px; }
  .gate-top { flex-wrap: wrap; }

  /* Tap targets: comfortably ~40px tall on touch. */
  .mchip, .gate-unlock { min-height: 40px; display: inline-flex; align-items: center; }
  .back { display: inline-flex; align-items: center; min-height: 36px; }
}
`;

// Loaded only on reading pages that actually contain a ```mermaid block. Module
// scripts are deferred, so the DOM is ready by the time mermaid auto-renders the
// <pre class="mermaid"> elements; the theme follows the reader's OS preference.
const MERMAID_SCRIPT = `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: true, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
</script>`;

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?" +
  "family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400" +
  "&family=Spline+Sans+Mono:wght@400;500&display=swap";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Jun 24, 2026" in UTC, so output is stable regardless of server timezone. */
function formatDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Thousands separators: 2980 -> "2,980". */
function commas(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Reading estimate at ~200 wpm, at least one minute. */
function minutes(words: number): number {
  return Math.max(1, Math.round(words / 200));
}

// Human glosses for the standard licenses we expect. Anything unknown renders as
// just the license code — we never invent a description for a license we can't name.
const LICENSE_GLOSS: Record<string, string> = {
  "CC-BY": "share & adapt with attribution",
  "CC-BY-4.0": "share & adapt with attribution",
  "CC BY 4.0": "share & adapt with attribution",
  "CC-BY-NC": "share & adapt, non-commercial, with attribution",
  "CC-BY-NC-4.0": "share & adapt, non-commercial, with attribution",
  "CC-BY-SA": "share & adapt, share-alike, with attribution",
  "CC-BY-ND": "share with attribution, no derivatives",
  "CC0": "no rights reserved",
  "CC0-1.0": "no rights reserved",
};

const POLICY_LABELS: Record<string, string> = {
  free: "FREE",
  paid: "PAID",
  metered: "METERED",
  sponsored: "SPONSORED",
};

/** CSS modifier suffix for a policy's colors (unknown policies read as free). */
function policyClass(policy: string): string {
  return policy in POLICY_LABELS ? policy : "free";
}

/** Whole-dollar when round ("$2"), else two decimals ("$0.05"). */
function priceCompact(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

/** A policy chip: "FREE", "PAID · $2", "METERED". Price shown for paid only. */
function policyChip(policy: string, price?: number): string {
  const cls = policyClass(policy);
  let label = POLICY_LABELS[cls] ?? "FREE";
  if (policy === "paid" && typeof price === "number" && price > 0) {
    label = `${label} · ${priceCompact(price)}`;
  }
  return `<span class="chip chip--${cls}">${escapeHtml(label)}</span>`;
}

// The node's own served mark. Same-origin, so a relative path is enough on the
// human surface; the machine output uses the absolute form.
const MARK_SRC = "/assets/sphere-mark.svg";

/** The glossy Sphere mark, rendered from a served SVG asset at the given size. */
function markImg(src: string, px: number): string {
  return `<img class="orb" src="${escapeHtml(src)}" width="${px}" height="${px}" alt="" aria-hidden="true">`;
}

function masthead(chrome: SiteChrome): string {
  return `<div class="masthead">
    ${markImg(chrome.publisherIcon ?? MARK_SRC, 30)}
    <div class="wordmark"><span class="name">Sphere</span><span class="node">NODE</span></div>
  </div>`;
}

function footer(license: string): string {
  return `<div class="foot">
    <span class="running">${markImg(MARK_SRC, 13)}<a href="${SPHERE_PROJECT_URL}">running on Sphere</a></span>
    <span>Apache-2.0 node · ${escapeHtml(license)} content</span>
  </div>`;
}

// Favicon links + Open Graph / Twitter card tags for a page. og:image is the
// shared brand banner served at /og.png (absolute when we know the host, so
// social scrapers can fetch it); the title/description stay page-specific.
function headMeta(chrome: SiteChrome, opts: { title: string; description?: string; path: string }): string {
  const origin = chrome.host ? `https://${chrome.host}` : "";
  const url = origin + opts.path;
  const image = origin + "/og.png";
  const desc = opts.description;
  const tags = [
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
    `<link rel="icon" type="image/png" sizes="256x256" href="/icon.png">`,
    `<link rel="apple-touch-icon" href="/icon.png">`,
    desc ? `<meta name="description" content="${escapeHtml(desc)}">` : "",
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeHtml(chrome.publisherName)}">`,
    `<meta property="og:title" content="${escapeHtml(opts.title)}">`,
    desc ? `<meta property="og:description" content="${escapeHtml(desc)}">` : "",
    origin ? `<meta property="og:url" content="${escapeHtml(url)}">` : "",
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(opts.title)}">`,
    desc ? `<meta name="twitter:description" content="${escapeHtml(desc)}">` : "",
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
  ];
  return tags.filter(Boolean).join("\n");
}

function layout(chrome: SiteChrome, title: string, head: string, shell: string, scripts = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_HREF}">
<style>${BASE_CSS}</style>
${head}
</head>
<body>
<div class="shell">
${masthead(chrome)}
${shell}
</div>
${scripts}
</body>
</html>`;
}

/** The publisher index: header, fragment list, footer. */
export function renderIndexPage(chrome: SiteChrome, fragments: IndexFragmentView[]): string {
  const license = chrome.defaultLicense ?? "CC-BY";
  const host = chrome.host ? escapeHtml(chrome.host) : "/";

  const summary = chrome.publisherSummary
    ? `<p class="pub-summary">${escapeHtml(chrome.publisherSummary)}</p>`
    : "";

  const latest = fragments.reduce((m, f) => Math.max(m, f.updatedTs || 0), 0);
  const count = `${fragments.length} ${fragments.length === 1 ? "fragment" : "fragments"}`;
  const updated = latest ? `&nbsp;&nbsp;·&nbsp;&nbsp;updated ${escapeHtml(formatDate(latest))}` : "";
  const pubMeta = `${count}&nbsp;&nbsp;·&nbsp;&nbsp;${escapeHtml(license)}${updated}`;

  const rows = fragments.length
    ? fragments
        .map((f) => {
          const cls = policyClass(f.policy);
          const price = undefined; // index has no per-fragment price wired today
          const desc = f.summary
            ? `<div class="frag-desc">${escapeHtml(f.summary)}</div>`
            : "";
          return `<a class="frag" href="/fragments/${encodeURIComponent(f.id)}">
        <div style="flex:1">
          <div class="frag-head"><span class="dot dot--${cls}"></span><span class="frag-title">${escapeHtml(f.title)}</span></div>
          ${desc}
        </div>
        <div class="frag-right">
          ${policyChip(f.policy, price)}
          <div class="wc">${commas(f.words)}&nbsp;w&nbsp;·&nbsp;${escapeHtml(f.id)}</div>
        </div>
      </a>`;
        })
        .join("")
    : `<div class="frag"><div class="frag-desc" style="margin-left:0">No fragments published yet.</div></div>`;

  const name = escapeHtml(chrome.publisherName);
  const nameHtml = chrome.publisherUrl
    ? `<a class="pub-link" href="${escapeHtml(chrome.publisherUrl)}">${name}</a>`
    : name;

  const card = `<div class="card">
    <div class="statusbar"><span>${host}</span><span>GET /&nbsp;&nbsp;·&nbsp;&nbsp;200 text/html</span></div>
    <div class="pub">
      <div class="eyebrow">PUBLISHER</div>
      <h1>${nameHtml}</h1>
      ${summary}
      <div class="pub-meta">${pubMeta}</div>
    </div>
    ${rows}
    ${footer(license)}
  </div>`;

  const head = headMeta(chrome, { title: chrome.publisherName, description: chrome.publisherSummary, path: "/" });
  return layout(chrome, chrome.publisherName, head, card);
}

/**
 * Render the typed external "Sources" section. Defensive about shape: a typed
 * entry has { type, title, author?, url?, date?, note? }, but legacy/odd entries
 * never throw — we fall back to whatever label and link we can find. Only http(s)
 * urls become links. Returns "" when there are no sources.
 */
function sourcesSection(sources: unknown): string {
  if (!Array.isArray(sources)) return "";
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const items = sources
    // A typed external source requires a title. This also filters out the old
    // internal-lineage shape ({ kind, url, label }) so build lineage never
    // surfaces as provenance on a fragment that hasn't been re-published yet.
    .filter((raw) => raw && typeof raw === "object" && str((raw as Record<string, unknown>).title).trim() !== "")
    .map((raw) => {
      const e = raw as Record<string, unknown>;
      const title = str(e.title);
      const type = (str(e.type) || "other").toLowerCase();
      const url = str(e.url);
      const author = str(e.author);
      const date = str(e.date);
      const note = str(e.note);
      const isHttp = /^https?:\/\//i.test(url.trim());
      const titleHtml = isHttp
        ? `<a class="source-title" href="${escapeHtml(url)}" rel="noopener nofollow">${escapeHtml(title)}</a>`
        : `<span class="source-title">${escapeHtml(title)}</span>`;
      const by = author ? `<span class="source-by"> — ${escapeHtml(author)}</span>` : "";
      const when = date ? `<span class="source-meta"> · ${escapeHtml(date)}</span>` : "";
      const noteHtml = note ? `<div class="source-note">${escapeHtml(note)}</div>` : "";
      return `<li class="source"><span class="source-type">${escapeHtml(type)}</span><span class="source-main">${titleHtml}${by}${when}${noteHtml}</span></li>`;
    })
    .join("");
  if (!items) return "";
  return `<section class="sources"><div class="sources-label">SOURCES</div><ul class="source-list">${items}</ul></section>`;
}

/**
 * The "Related" section: typed edges to other fragments. Each edge is
 * { type, target } where `target` is a canonical fragment reference:
 *  - same-node — a bare id (yyyy-mm-dd-slug), resolved to its title via `titles`
 *    and linked to /fragments/{id}. An id missing from the map degrades to plain
 *    text (the target still exists as a reference, we just can't name it here).
 *  - external — an absolute http(s) URL, linked out and marked external with
 *    rel="noopener".
 * The `type` shows as a quiet mono label. Defensive about shape: never throws,
 * skips edges without a usable target. Returns "" when there are no relations.
 */
function relationsSection(relations: unknown, titles: Map<string, string>): string {
  if (!Array.isArray(relations)) return "";
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const items = relations
    .filter((raw) => raw && typeof raw === "object" && str((raw as Record<string, unknown>).target).trim() !== "")
    .map((raw) => {
      const e = raw as Record<string, unknown>;
      const type = str(e.type).trim() || "related";
      const target = str(e.target).trim();
      const isExternal = /^https?:\/\//i.test(target);
      let mainHtml: string;
      if (isExternal) {
        // Another node's canonical fragment URL: link out, marked external.
        mainHtml = `<a class="relation-target" href="${escapeHtml(target)}" rel="noopener">${escapeHtml(target)}<span class="relation-ext">↗</span></a>`;
      } else {
        const title = titles.get(target);
        mainHtml = title
          ? `<a class="relation-target" href="/fragments/${encodeURIComponent(target)}">${escapeHtml(title)}</a>`
          : `<span class="relation-target">${escapeHtml(target)}</span>`;
      }
      return `<li class="relation"><span class="relation-type">${escapeHtml(type)}</span><span class="relation-main">${mainHtml}</span></li>`;
    })
    .join("");
  if (!items) return "";
  return `<section class="relations"><div class="relations-label">RELATED</div><ul class="relation-list">${items}</ul></section>`;
}

/** A single fragment reading page. */
export function renderFragmentPage(
  chrome: SiteChrome,
  manifest: FragmentManifest,
  body: FragmentBody,
  /** id -> title for same-node relation targets; empty when none apply. */
  relationTitles: Map<string, string> = new Map(),
): string {
  const policy = manifest.access.policy;
  const cls = policyClass(policy);
  const gated = body.gated;
  const license = manifest.license;
  const price = manifest.access.price_per_access;
  const path = `/fragments/${manifest.id}`;
  const url = chrome.host ? `${escapeHtml(chrome.host)}${escapeHtml(path)}` : escapeHtml(path);

  const machineCode = policy === "free" || policy === "sponsored" ? 200 : 402;
  const statusClass = gated || policy === "sponsored" ? ` status--${cls}` : "";
  const statusBar = `<div class="statusbar"><span>${url}</span><span class="${statusClass.trim()}">${machineCode} · ${escapeHtml(policy)}</span></div>`;

  const dek = manifest.summary ? `<p class="dek">${escapeHtml(manifest.summary)}</p>` : "";
  const date = body.updatedTs ? `<span>${escapeHtml(formatDate(body.updatedTs))}</span><span>·</span>` : "";
  const readMeta = `<div class="read-meta">
      ${policyChip(policy, price)}
      ${date}<span>${minutes(body.words)} min read</span><span>·</span><span>${escapeHtml(license)}</span>
    </div>`;

  const head = `<div class="read-head">
    <a class="back" href="/">← ${escapeHtml(chrome.publisherName)}</a>
    <h1>${escapeHtml(manifest.title)}</h1>
    ${dek}
    ${readMeta}
  </div>
  <div class="rule"></div>`;

  const articleClass = gated ? "fragment is-gated" : "fragment";
  const fade = gated ? `<div class="fade"></div>` : "";
  const rendered = renderMarkdown(body.markdown);
  const article = `<article class="${articleClass}">${rendered}${fade}</article>`;
  const scripts = rendered.includes(`class="mermaid"`) ? MERMAID_SCRIPT : "";

  const sources = sourcesSection(manifest.sources);
  const relations = relationsSection(manifest.relations, relationTitles);

  let tail: string;
  if (gated) {
    // Provenance and relations still belong to a gated fragment; show them below the gate.
    tail = gatePanel(policy, price, body.previewWords ?? 0, body.words) + sources + relations;
  } else {
    const gloss = LICENSE_GLOSS[license];
    const glossPart = gloss ? ` — ${escapeHtml(gloss)}` : "";
    const licenseLine = `<div class="license"><span class="code">${escapeHtml(license)}</span>${glossPart}</div>`;
    const machineRow = `<div class="machine-row">
      <a class="mchip" href="${escapeHtml(path)}/sphere.json">sphere.json</a>
      <a class="mchip" href="${escapeHtml(path)}/content.md">content.md</a>
      <span class="mchip mchip--note">↑ machine-readable</span>
    </div>`;
    tail = sources + relations + licenseLine + machineRow;
  }

  const card = `<div class="card">
    ${statusBar}
    ${head}
    ${article}
    ${tail}
  </div>`;

  const pageHead = headMeta(chrome, {
    title: manifest.title,
    description: manifest.summary,
    path,
  });
  return layout(chrome, `${manifest.title} — ${chrome.publisherName}`, pageHead, card, scripts);
}

/** The paid/metered gate. Honest by construction: shown, never charged in v1. */
function gatePanel(policy: string, price: number | undefined, previewWords: number, totalWords: number): string {
  const metered = policy === "metered";
  const title = metered ? "The rest of this fragment is metered." : "The rest of this fragment is paid.";
  const hasPrice = typeof price === "number" && price > 0;

  const priceTag = hasPrice
    ? `<div class="gate-price">$${price.toFixed(2)} / read</div>`
    : metered
      ? `<div class="gate-price">metered</div>`
      : "";

  const counts = totalWords
    ? `roughly the first ${commas(previewWords)} of ${commas(totalWords)} words`
    : "the free preview";

  const unlock = hasPrice
    ? `Unlock — $${price.toFixed(2)}&nbsp;&nbsp;·&nbsp;&nbsp;coming soon`
    : `Unlock&nbsp;&nbsp;·&nbsp;&nbsp;coming soon`;

  return `<div class="gate">
    <div class="gate-top">
      <div class="gate-title">${escapeHtml(title)}</div>
      ${priceTag}
    </div>
    <p>You've read ${counts}. Unlocking returns the full <span class="file">content.md</span> and lifts the gate for agents acting on your behalf.</p>
    <div class="gate-actions">
      <span class="gate-unlock">${unlock}</span>
      <span class="gate-note">Payment isn't wired up yet — in v1 the 402 is returned, not charged.</span>
    </div>
  </div>`;
}

/** A browser-friendly 404 so a human never sees a raw JSON error. */
export function renderNotFoundPage(chrome: SiteChrome, message: string): string {
  const license = chrome.defaultLicense ?? "CC-BY";
  const card = `<div class="card">
    <div class="statusbar"><span>${chrome.host ? escapeHtml(chrome.host) : "/"}</span><span>404 not found</span></div>
    <div class="notfound">
      <h1>Not found</h1>
      <p>${escapeHtml(message)}</p>
      <a class="back" href="/">← ${escapeHtml(chrome.publisherName)}</a>
    </div>
    ${footer(license)}
  </div>`;
  const head = headMeta(chrome, { title: `Not found — ${chrome.publisherName}`, description: chrome.publisherSummary, path: "/" });
  return layout(chrome, `Not found — ${chrome.publisherName}`, head, card);
}
