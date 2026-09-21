import type { LazyNode } from './node.js';

/** Subset of JSON Schema understood by this validator, plus an `$id`/`$defs`/`$ref`. */
export interface Schema {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, Schema>;
  $comment?: string;
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  required?: string[];
  properties?: Record<string, Schema>;
  patternProperties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  /**
   * Custom keyword: returns `true`/an annotation when the instance is valid,
   * `false`/an error annotation otherwise. The function runs **at most once**
   * per validation node — formatting never re-executes it.
   */
  [custom: string]: unknown;
}

/** The four JSON Schema 2019-09/2020-12 output structures. */
export type OutputFormat = 'flag' | 'basic' | 'detailed' | 'verbose';

/**
 * Everything a formatter needs from one keyword/assertion location.
 * Child subtrees stay lazy: `children()` is only called when the chosen
 * output format actually needs them.
 */
export interface NodeView {
  /** Absolute keyword location, e.g. `https://x/schema#/properties/a/type`. */
  keywordLocation: string;
  /** Same as {@link keywordLocation}; kept under the spec name for clarity. */
  absoluteKeywordLocation: string;
  /** Instance location as a JSON Pointer from the validation root. */
  instanceLocation: string;
  valid: boolean;
  /** Error/annotation text attached to this node, if any. */
  annotation?: string;
  /** Name of the keyword this node represents (`type`, `$ref`, `x-foo`, …). */
  keyword: string;
  /** Schema-evaluation container; formatters splice its children upward. */
  transparent?: boolean;
  /** Lazily materialized child views (empty for leaf assertions). */
  children(): NodeView[];
}
