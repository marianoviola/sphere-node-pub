// Domain types for the fragment contract. Zero Cloudflare names or imports.

export type AccessPolicy = "free" | "metered" | "paid" | "sponsored";

export interface PaymentMetadata {
  profile: string;
  method: string;
  endpoint: string;
  /** x402 (github.com/coinbase/x402): CAIP-2 network id, e.g. "eip155:8453". */
  network?: string;
  /** x402: the asset (token contract or symbol) payment is accepted in. */
  asset?: string;
  /** x402: the recipient address `accepts[].payTo`. */
  pay_to?: string;
  /** x402: override for `accepts[].amount` when price_per_access isn't already in the asset's atomic units. */
  amount?: string;
  /** x402: `accepts[].maxTimeoutSeconds`. */
  max_timeout_seconds?: number;
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

/**
 * A typed edge to another fragment. `type` is a short, open relation kind
 * (related, continues, cites, responds-to, ...). `target` is a CANONICAL
 * fragment reference: a same-node id (yyyy-mm-dd-slug) or an absolute external
 * fragment URL ({node_base}/fragments/{id}). The reference scheme is documented
 * in spec/node-api.md and is used identically by relations, inline links, and
 * the machine views.
 */
export interface RelationEdge {
  type: string;
  target: string;
  [key: string]: unknown;
}

export interface FragmentManifest {
  id: string;
  title: string;
  summary?: string;
  license: string;
  access: AccessBlock;
  sources?: SourceRef[];
  relations?: RelationEdge[];
  [key: string]: unknown;
}

/** A fragment as stored by the node: manifest plus where its content lives. */
export interface StoredFragment {
  manifest: FragmentManifest;
  contentKey: string;
  updatedTs: number;
}
