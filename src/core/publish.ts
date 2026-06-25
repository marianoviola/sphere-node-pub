// Publish domain logic: validate a fragment against the contract and turn it
// into a stored record + content key. Consumes the fragment contract ONLY.
// No filesystem, no Cloudflare, no source/CMS knowledge. Pure functions; the
// CLI (scripts/publish.ts) supplies the files and the port adapters.

import { validate, type JsonSchema } from "./schema.ts";
import { contentKeyFor } from "./fragments.ts";
import type { FragmentManifest, StoredFragment } from "./types.ts";

/**
 * Business rules that the structural JSON Schema cannot express on its own:
 * gated policies require a payment block and a positive price.
 */
export function checkAccessRules(manifest: FragmentManifest): string[] {
  const errors: string[] = [];
  const { policy, payment, price_per_access } = manifest.access;
  if (policy === "paid" || policy === "metered") {
    if (!payment) errors.push(`access.payment is required for policy "${policy}"`);
    if (!(typeof price_per_access === "number" && price_per_access > 0)) {
      errors.push(`access.price_per_access must be a positive number for policy "${policy}"`);
    }
  }
  return errors;
}

/** Validate a parsed manifest against the schema and the access rules. */
export function validateManifest(manifest: unknown, schema: JsonSchema): string[] {
  const errors = validate(manifest, schema);
  // Only run the access-rule checks if the structure is sound enough.
  if (errors.length === 0) {
    errors.push(...checkAccessRules(manifest as FragmentManifest));
  }
  return errors;
}

/** Build the catalog record the FragmentStore will upsert. */
export function toStoredFragment(manifest: FragmentManifest, updatedTs: number): StoredFragment {
  return {
    manifest,
    contentKey: contentKeyFor(manifest.id),
    updatedTs,
  };
}
