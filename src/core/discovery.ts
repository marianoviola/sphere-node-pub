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
