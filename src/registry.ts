import { resolvePointer, splitUri } from './pointer.js';
import type { Schema } from './types.js';

/**
 * Registry of schema documents, keyed by an absolute base URI.
 *
 * - The root schema is registered under its `$id` (or `''` as fallback).
 * - `$ref` is resolved per RFC 3986-ish rules: same-document fragment,
 *   absolute URI, and same-document bare fragment are all supported.
 * - Node identity is captured by canonical URI so cyclic schemas are the
 *   same canonical target on every pass through the cycle.
 */
export class SchemaRegistry {
  private readonly documents = new Map<string, Schema>();
  readonly rootId: string;

  constructor(root: Schema, rootId?: string) {
    this.rootId = rootId ?? root.$id ?? '';
    this.documents.set(this.rootId, root);
  }

  /** Register an additional document, e.g. the target of an external `$ref`. */
  addDocument(uri: string, schema: Schema): void {
    const [base] = splitUri(uri);
    this.documents.set(base || uri, schema);
  }

  /** Resolve a `$ref` appearing at `baseUri` to a schema node. */
  resolve(ref: string, baseUri: string): Schema {
    const [docPart, fragment] = this.resolveParts(ref, baseUri);
    const doc = this.documents.get(docPart);
    if (!doc) throw new Error(`unknown schema document: ${JSON.stringify(docPart)}`);
    const target = resolvePointer(doc, fragment);
    if (target === null || typeof target !== 'object') {
      throw new Error(`$ref ${JSON.stringify(ref)} does not point at a schema object`);
    }
    return target as Schema;
  }

  /**
   * Canonical URI of a `$ref` target. Two refs that denote the same node
   * produce the same string, which is what cycle detection keys off.
   */
  canonicalRef(ref: string, baseUri: string): string {
    const [docPart, fragment] = this.resolveParts(ref, baseUri);
    return docPart + '#' + fragment;
  }

  private resolveParts(ref: string, baseUri: string): [string, string] {
    // Absolute URI with its own document part.
    if (ref.includes('://') || ref.startsWith('urn:')) {
      const [doc, fragment] = splitUri(ref);
      return [doc, fragment];
    }
    // Same-document fragment pointer.
    if (ref.startsWith('#')) return [baseUri, ref.slice(1)];
    // Relative pointer inside the current document.
    return [baseUri, ref.startsWith('/') ? ref.slice(1) : ref];
  }
}
