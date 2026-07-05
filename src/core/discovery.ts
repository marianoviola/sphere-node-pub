// Publisher discovery document builder. Pure: given config and the fragment
// list, produce the .well-known/sphere.json payload. Always valid, even empty.

import type { StoredFragment } from "./types.ts";

export const SPHERE_VERSION = "1.0";

export interface DiscoveryFragmentEntry {
  id: string;
  title: string;
  policy: string;
  manifest: string;
  content: string;
}

/** The publisher block in the discovery document: a compact ref plus a summary. */
export interface DiscoveryPublisher {
  name: string;
  summary?: string;
  url?: string;
  icon?: string;
}

export interface DiscoveryDocument {
  sphere_version: string;
  publisher: DiscoveryPublisher;
  default_license: string;
  fragment_count: number;
  fragments: DiscoveryFragmentEntry[];
}

export function buildDiscovery(
  config: { publisher: DiscoveryPublisher; defaultLicense: string },
  fragments: StoredFragment[],
): DiscoveryDocument {
  const entries: DiscoveryFragmentEntry[] = fragments.map((f) => ({
    id: f.manifest.id,
    title: f.manifest.title,
    policy: f.manifest.access.policy,
    manifest: `/fragments/${f.manifest.id}/sphere.json`,
    content: `/fragments/${f.manifest.id}/content.md`,
  }));

  return {
    sphere_version: SPHERE_VERSION,
    publisher: config.publisher,
    default_license: config.defaultLicense,
    fragment_count: entries.length,
    fragments: entries,
  };
}

/**
 * Render an `/llms.txt` discovery aid from a discovery document. Follows the
 * llms.txt convention: an H1 title, an optional blockquote summary, a pointer to
 * the authoritative machine discovery, and a flat list of the fragments as
 * Markdown links to their content.md. Built from the SAME document buildDiscovery
 * produces, so it can never drift from `/.well-known/sphere.json`. An empty node
 * yields a valid aid with no fragment lines.
 *
 * `origin` is the node's own origin (e.g. "https://sphere.pub"); links are made
 * absolute so a crawler that reads llms.txt standalone can follow them.
 */
export function renderLlmsTxt(doc: DiscoveryDocument, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const lines: string[] = [`# ${doc.publisher.name}`];

  if (doc.publisher.summary) {
    lines.push("", `> ${doc.publisher.summary}`);
  }

  lines.push(
    "",
    `Machine-readable discovery for AI agents: ${base}/.well-known/sphere.json`,
    "",
    "## Fragments",
    "",
  );

  if (doc.fragments.length === 0) {
    lines.push("No fragments published yet.");
  } else {
    for (const f of doc.fragments) {
      lines.push(`- [${f.title}](${base}${f.content}) (${f.policy})`);
    }
  }

  return lines.join("\n") + "\n";
}
