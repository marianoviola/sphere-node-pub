// Fragment lookup and manifest assembly via ports. No Cloudflare imports.

import type { BlobStore, FragmentStore } from "./ports.ts";
import type { FragmentManifest, StoredFragment } from "./types.ts";

/** Canonical R2/blob key for a fragment's content. */
export function contentKeyFor(id: string): string {
  return `fragments/${id}/content.md`;
}

/** Canonical R2/blob key for a fragment media file. */
export function mediaKeyFor(id: string, filename: string): string {
  return `fragments/${id}/media/${filename}`;
}

export async function getFragment(
  store: FragmentStore,
  id: string,
): Promise<StoredFragment | null> {
  return store.get(id);
}

/** The manifest served at /fragments/{id}/sphere.json. */
export function manifestOf(fragment: StoredFragment): FragmentManifest {
  return fragment.manifest;
}

/** Load the content body for a fragment, or null when absent. */
export async function getContent(
  blobs: BlobStore,
  fragment: StoredFragment,
): Promise<string | null> {
  return blobs.get(fragment.contentKey);
}
