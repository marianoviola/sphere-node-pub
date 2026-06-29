// Domain types for the fragment contract. Zero Cloudflare names or imports.

export type AccessPolicy = "free" | "metered" | "paid" | "sponsored";

export interface PaymentMetadata {
  profile: string;
  method: string;
  endpoint: string;
  [key: string]: unknown;
}

export interface AccessBlock {
  policy: AccessPolicy;
  preview_chars?: number;
  price_per_access?: number;
  currency?: string;
  payment?: PaymentMetadata;
  [key: string]: unknown;
}

/**
 * Compact publisher reference. This travels with the discovery document AND with
 * each fragment's machine output, so attribution (who published this, where, and
 * their mark) is visible to any agent that reads a fragment in isolation. On
 * Sphere the author IS the publisher and the brand: `name` is the author, `icon`
 * is the personal mark, `url` is their canonical home.
 */
export interface PublisherRef {
  name: string;
  url?: string;
  icon?: string;
}

/** External provenance kinds a fragment may draw on. */
export type SourceType = "book" | "article" | "paper" | "video" | "webpage" | "dataset" | "other";

/**
 * A typed EXTERNAL source: a book, article, paper, video, page, or dataset a
 * fragment draws on. Provenance is legitimacy, so this is part of the contract.
 * It is NOT the internal document a fragment was generated from (build lineage).
 */
export interface SourceRef {
  type: SourceType;
  title: string;
  author?: string;
  url?: string;
  date?: string;
  note?: string;
}

export interface FragmentManifest {
  id: string;
  title: string;
  summary?: string;
  license: string;
  access: AccessBlock;
  sources?: SourceRef[];
  relations?: unknown[];
  [key: string]: unknown;
}

/** A fragment as stored by the node: manifest plus where its content lives. */
export interface StoredFragment {
  manifest: FragmentManifest;
  contentKey: string;
  updatedTs: number;
}
