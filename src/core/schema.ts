// Tiny JSON Schema (draft-07 subset) validator. Zero dependencies, zero
// Cloudflare imports. Supports exactly the keywords used by
// spec/fragment.schema.json: type, required, properties, enum, pattern,
// minLength, minimum, items, additionalProperties (boolean only).
//
// This is deliberately not a full JSON Schema engine. It exists so the publish
// path can validate a fragment against the published contract without pulling a
// dependency, and so the node and any external tool agree on what "valid" means.

export interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  additionalProperties?: boolean;
  [key: string]: unknown;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "null") return value === null;
  return typeOf(value) === type;
}

/** Validate `value` against `schema`. Returns a list of human-readable errors (empty = valid). */
export function validate(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected type ${schema.type}, got ${typeOf(value)}`);
    return errors; // further checks assume the type held
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: value must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: string does not match pattern ${schema.pattern}`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
  }

  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path}: number below minimum ${schema.minimum}`);
  }

  if (matchesType(value, "object")) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) errors.push(...validate(obj[key], sub, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) errors.push(`${path}: additional property "${key}" is not allowed`);
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items as JsonSchema, `${path}[${i}]`)));
  }

  return errors;
}
