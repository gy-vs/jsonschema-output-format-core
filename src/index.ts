import { format as render, type BasicOutput, type DetailedOutput, type FlagOutput, type VerboseOutput } from './format.js';
import { evaluate } from './validator.js';
import { SchemaRegistry } from './registry.js';
import type { LazyNode } from './node.js';
import type { OutputFormat, Schema } from './types.js';

export type { Schema, OutputFormat } from './types.js';
export type {
  OutputUnit, BasicOutput, BasicUnit, DetailedOutput, VerboseOutput, FlagOutput,
} from './format.js';
export { LazyNode } from './node.js';
export { formatFlag, formatBasic, formatDetailed, formatVerbose, format } from './format.js';

export interface ValidateOptions {
  /** Base URI of the root schema (used in absolute keyword locations). */
  baseUri?: string;
  /** Extra documents addressable by absolute-URI `$ref`s. */
  documents?: Record<string, Schema>;
}

/**
 * Validate and return a lazy result tree.
 *
 * Validation of each node runs on first access and is memoized; callers
 * expand the tree on demand with {@link format} (`'flag'` by default costs
 * only the root validity check). The full error tree is never constructed
 * unless a caller asks for `detailed`/`verbose`.
 */
export function validate(
  schema: Schema,
  value: unknown,
  options: ValidateOptions = {},
): LazyNode {
  const registry = new SchemaRegistry(schema, options.baseUri);
  for (const [uri, doc] of Object.entries(options.documents ?? {})) {
    registry.addDocument(uri, doc);
  }
  return evaluate(registry, schema, value);
}

/** Convenience: validate and render one output format in a single call. */
export function validateWithOutput(
  schema: Schema,
  value: unknown,
  output: OutputFormat,
  options?: ValidateOptions,
): FlagOutput | BasicOutput | DetailedOutput | VerboseOutput {
  return render(validate(schema, value, options), output);
}
