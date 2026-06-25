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

export interface FragmentManifest {
  id: string;
  title: string;
  summary?: string;
  license: string;
  access: AccessBlock;
  sources?: unknown[];
  relations?: unknown[];
  [key: string]: unknown;
}

/** A fragment as stored by the node: manifest plus where its content lives. */
export interface StoredFragment {
  manifest: FragmentManifest;
  contentKey: string;
  updatedTs: number;
}
