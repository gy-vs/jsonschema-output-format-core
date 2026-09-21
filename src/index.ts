/**
 * JSON Schema style validator with the four 2020-12 output formats:
 *
 *   flag     - { valid } only, no tree is materialised
 *   basic    - flat list of error / annotation units
 *   detailed - nested tree of failed nodes only
 *   verbose  - full tree of every node with errors and annotations
 *
 * Validation builds lazy, memoised result nodes. A node's keyword logic runs
 * exactly once: touching `valid` forces evaluation, and every format only
 * reads the cached nodes, so converting between formats (repeatedly) never
 * re-executes custom keywords.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JsonTypeName =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export type Schema = boolean | SchemaObject;

export interface SchemaObject {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, Schema>;
  $comment?: unknown;
  type?: JsonTypeName | JsonTypeName[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema | Schema[];
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  [keyword: string]: unknown;
}

export interface Location {
  /** JSON Pointer of the keyword relative to the root schema. */
  keywordLocation: string;
  /** Absolute keyword location: document IRI + '#' + JSON Pointer. */
  absoluteKeywordLocation: string;
  /** JSON Pointer of the evaluated instance fragment. */
  instanceLocation: string;
}

export interface OutputUnit extends Location {
  valid: boolean;
  error?: string;
  annotationName?: string;
  annotation?: unknown;
}

export interface FlagOutput {
  valid: boolean;
}

export interface BasicOutput {
  valid: boolean;
  errors?: OutputUnit[];
  annotations?: OutputUnit[];
}

export interface DetailedUnit extends OutputUnit {
  errors?: DetailedUnit[];
}

export interface VerboseUnit extends OutputUnit {
  errors?: VerboseUnit[];
  annotations?: VerboseUnit[];
}

export type OutputFormat = 'flag' | 'basic' | 'detailed' | 'verbose';

export type OutputOf<F extends OutputFormat> = F extends 'flag'
  ? FlagOutput
  : F extends 'basic'
    ? BasicOutput
    : F extends 'detailed'
      ? DetailedUnit
      : VerboseUnit;

export interface AnnotationContext {
  readonly schema: SchemaObject;
  readonly instance: unknown;
  readonly instanceLocation: string;
  /** Attach an annotation to the current keyword node. */
  annotate(annotation: unknown, annotationName?: string): void;
}

export type CustomKeywordResult =
  | boolean
  | void
  | {
      valid?: boolean;
      error?: string;
      annotation?: unknown;
      annotationName?: string;
    };

export type CustomKeyword = (
  subschema: unknown,
  instance: unknown,
  ctx: AnnotationContext,
) => CustomKeywordResult;

export interface ValidateOptions {
  /** Base IRI of the root document (defaults to the schema's $id). */
  baseURI?: string;
  /** External schema documents, keyed by absolute IRI. */
  schemas?: Record<string, Schema>;
  /** Custom keyword implementations, keyed by keyword name. */
  keywords?: Record<string, CustomKeyword>;
}

export interface ValidationResult {
  readonly valid: boolean;
  /** Materialise the requested output format without re-running keywords. */
  toOutput<F extends OutputFormat>(format: F): OutputOf<F>;
}

/** @deprecated kept for backwards compatibility with the old flat validator. */
export interface Issue {
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Lazy result nodes
// ---------------------------------------------------------------------------

interface NodeData {
  valid: boolean;
  error?: string;
  annotationName?: string;
  annotation?: unknown;
  children: LazyNode[];
  /** Hide descendants in every format; the node itself is retained. */
  pruneChildren?: boolean;
  /** Cycle-break node inserted for a recursive $ref. */
  cyclic?: boolean;
}

interface LazyNode {
  readonly keywordLocation: string;
  readonly absoluteKeywordLocation: string;
  readonly instanceLocation: string;
  /** Force the node (once) and return the cached outcome. */
  eval(): NodeData;
  readonly valid: boolean;
}

class LazyNodeImpl implements LazyNode {
  private cached: NodeData | null = null;

  constructor(
    readonly keywordLocation: string,
    readonly absoluteKeywordLocation: string,
    readonly instanceLocation: string,
    private readonly thunk: () => NodeData,
  ) {}

  eval(): NodeData {
    if (this.cached === null) {
      this.cached = this.thunk();
    }
    return this.cached;
  }

  get valid(): boolean {
    return this.eval().valid;
  }
}

function makeNode(loc: Location, thunk: () => NodeData): LazyNode {
  return new LazyNodeImpl(
    loc.keywordLocation,
    loc.absoluteKeywordLocation,
    loc.instanceLocation,
    thunk,
  );
}

function readyNode(loc: Location, data: NodeData): LazyNode {
  const node = makeNode(loc, () => data);
  node.eval();
  return node;
}

// ---------------------------------------------------------------------------
// Evaluation context
// ---------------------------------------------------------------------------

interface Runtime {
  documents: Map<string, Schema>;
  keywords: Record<string, CustomKeyword>;
  /** Active (schema identity @ instance location[/instance identity]) keys. */
  active: Set<string>;
  ids: WeakMap<object, number>;
  nextId: { value: number };
}

const SKIP_KEYWORDS = new Set(['$schema', '$id', '$defs']);

const ANNOTATION_KEYWORDS = new Set([
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
]);

// ---------------------------------------------------------------------------
// JSON Pointer helpers (RFC 6901)
// ---------------------------------------------------------------------------

export function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function actualTypeName(value: unknown): JsonTypeName {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t as JsonTypeName;
}

function typeMatches(name: JsonTypeName, value: unknown): boolean {
  switch (name) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
  }
}

function schemaId(runtime: Runtime, schema: object): number {
  let id = runtime.ids.get(schema);
  if (id === undefined) {
    id = runtime.nextId.value++;
    runtime.ids.set(schema, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

interface ResolvedRef {
  schema: Schema;
  base: string;
  absPtr: string;
}

function resolveRef(
  ref: string,
  currentBase: string,
  runtime: Runtime,
): ResolvedRef | undefined {
  const hash = ref.indexOf('#');
  const iri = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);
  const base = iri === '' ? currentBase : iri;

  const doc = runtime.documents.get(base);
  if (doc === undefined) return undefined;
  if (fragment === '') return { schema: doc, base, absPtr: '' };
  if (!fragment.startsWith('/')) return undefined; // only JSON Pointer fragments

  let current: unknown = doc;
  const absPtr = fragment;
  for (const rawToken of fragment.slice(1).split('/')) {
    const token = unescapePointer(rawToken);
    if (!isPlainObject(current) || !(token in current)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return { schema: current as Schema, base, absPtr };
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

function loc(base: string, rel: string, absPtr: string, inst: string): Location {
  return {
    keywordLocation: rel,
    absoluteKeywordLocation: `${base}#${absPtr}`,
    instanceLocation: inst,
  };
}

/** Build (lazily) the result node for applying one schema to an instance. */
function schemaNode(
  schema: Schema,
  instance: unknown,
  rel: string,
  inst: string,
  base: string,
  absPtr: string,
  runtime: Runtime,
): LazyNode {
  const location = loc(base, rel, absPtr, inst);

  if (typeof schema === 'boolean') {
    return readyNode(location, {
      valid: schema,
      error: schema ? undefined : 'schema is false',
      children: [],
    });
  }

  // A recursive revisit terminates (as valid) when the same schema is
  // encountered again at the same instance *location*, or at a different
  // location holding the same instance *value* (genuinely cyclic data,
  // e.g. node.next === node). Depth-first evaluation means a value identity
  // still on the active stack can only be a recursive ancestor.
  const keys = [`${schemaId(runtime, schema)}@${inst}`];
  if (typeof instance === 'object' && instance !== null) {
    keys.push(`${schemaId(runtime, schema)}#${schemaId(runtime, instance as object)}`);
  }
  if (keys.some((key) => runtime.active.has(key))) {
    return readyNode(location, { valid: true, children: [], cyclic: true });
  }

  return makeNode(location, () => {
    for (const key of keys) runtime.active.add(key);
    try {
      const children: LazyNode[] = [];

      // Schema object key order is the deterministic evaluation order.
      for (const keyword of Object.keys(schema)) {
        if (SKIP_KEYWORDS.has(keyword)) continue;
        const subschema = schema[keyword];
        const kwRel = `${rel}/${escapePointer(keyword)}`;
        const kwAbs = `${absPtr}/${escapePointer(keyword)}`;

        if (keyword === '$ref' && typeof subschema === 'string') {
          children.push(
            refNode(subschema, instance, kwRel, kwAbs, inst, base, runtime),
          );
        } else if (keyword === 'type' && subschema !== undefined) {
          children.push(typeNode(subschema, instance, base, inst, kwRel, kwAbs));
        } else if (keyword === 'enum' && Array.isArray(subschema)) {
          children.push(
            leafNode(base, inst, kwRel, kwAbs, () => {
              const ok = subschema.some((candidate) =>
                deepEqual(candidate, instance),
              );
              return ok
                ? { valid: true }
                : { valid: false, error: 'value is not one of enum values' };
            }),
          );
        } else if (keyword === 'const') {
          children.push(
            leafNode(base, inst, kwRel, kwAbs, () =>
              deepEqual(subschema, instance)
                ? { valid: true }
                : { valid: false, error: 'value is not the const value' },
            ),
          );
        } else if (keyword === 'required' && Array.isArray(subschema)) {
          children.push(requiredNode(subschema, instance, base, inst, kwRel, kwAbs));
        } else if (keyword === 'properties' && isPlainObject(subschema)) {
          children.push(
            propertiesNode(
              subschema as Record<string, Schema>,
              instance,
              inst,
              base,
              kwRel,
              kwAbs,
              runtime,
            ),
          );
        } else if (keyword === 'items' && subschema !== undefined) {
          children.push(
            itemsNode(subschema as Schema | Schema[], instance, inst, base, kwRel, kwAbs, runtime),
          );
        } else if (
          keyword === 'allOf' ||
          keyword === 'anyOf' ||
          keyword === 'oneOf'
        ) {
          if (Array.isArray(subschema)) {
            children.push(
              combinatorNode(
                keyword,
                subschema as Schema[],
                instance,
                inst,
                base,
                kwRel,
                kwAbs,
                runtime,
              ),
            );
          }
        } else if (keyword === 'not') {
          children.push(
            notNode(subschema as Schema, instance, inst, base, kwRel, kwAbs, runtime),
          );
        } else if (ANNOTATION_KEYWORDS.has(keyword)) {
          children.push(
            readyNode(loc(base, kwRel, kwAbs, inst), {
              valid: true,
              annotationName: keyword,
              annotation: subschema,
              children: [],
            }),
          );
        } else if (runtime.keywords[keyword]) {
          children.push(
            customNode(
              keyword,
              runtime.keywords[keyword],
              schema,
              subschema,
              instance,
              inst,
              base,
              kwRel,
              kwAbs,
            ),
          );
        }
        // Unknown keywords are ignored, as in a dialect-independent core.
      }

      // Force every child without short-circuiting: all assertions are
      // evaluated and every custom keyword runs exactly once.
      let valid = true;
      for (const child of children) {
        if (!child.eval().valid) valid = false;
      }
      return { valid, children };
    } finally {
      for (const key of keys) runtime.active.delete(key);
    }
  });
}

function leafNode(
  base: string,
  inst: string,
  rel: string,
  absPtr: string,
  compute: () => {
    valid: boolean;
    error?: string;
    annotationName?: string;
    annotation?: unknown;
  },
): LazyNode {
  return makeNode(loc(base, rel, absPtr, inst), () => ({
    children: [],
    ...compute(),
  }));
}

function typeNode(
  spec: unknown,
  instance: unknown,
  base: string,
  inst: string,
  rel: string,
  absPtr: string,
): LazyNode {
  const names = Array.isArray(spec)
    ? (spec as JsonTypeName[])
    : [spec as JsonTypeName];
  return leafNode(base, inst, rel, absPtr, () => {
    const ok = names.some((name) => typeMatches(name, instance));
    return ok
      ? { valid: true }
      : {
          valid: false,
          error: `expected ${names.join(' or ')}, got ${actualTypeName(instance)}`,
        };
  });
}

function requiredNode(
  required: string[],
  instance: unknown,
  base: string,
  inst: string,
  rel: string,
  absPtr: string,
): LazyNode {
  return leafNode(base, inst, rel, absPtr, () => {
    if (!isPlainObject(instance)) return { valid: true };
    const missing = required.filter((key) => !(key in instance));
    return missing.length === 0
      ? { valid: true }
      : {
          valid: false,
          error: `missing required ${missing.length === 1 ? 'property' : 'properties'}: ${missing.join(', ')}`,
        };
  });
}

function propertiesNode(
  properties: Record<string, Schema>,
  instance: unknown,
  inst: string,
  base: string,
  kwRel: string,
  kwAbs: string,
  runtime: Runtime,
): LazyNode {
  return makeNode(loc(base, kwRel, kwAbs, inst), () => {
    if (!isPlainObject(instance)) return { valid: true, children: [] };

    const children: LazyNode[] = [];
    const evaluated: string[] = [];
    for (const name of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(instance, name)) {
        evaluated.push(name);
        const token = escapePointer(name);
        // Each entry is a schema application unit at
        // /properties/<name> (instance /<name>); its keyword assertions
        // nest below at /properties/<name>/<keyword>.
        children.push(
          schemaNode(
            properties[name],
            instance[name],
            `${kwRel}/${token}`,
            `${inst}/${token}`,
            base,
            `${kwAbs}/${token}`,
            runtime,
          ),
        );
      }
    }

    let valid = true;
    for (const child of children) {
      if (!child.eval().valid) valid = false;
    }
    return {
      valid,
      children,
      // Aggregating keyword: the child property units carry the messages.
      annotationName: 'properties',
      annotation: evaluated,
    };
  });
}

function itemsNode(
  spec: Schema | Schema[],
  instance: unknown,
  inst: string,
  base: string,
  kwRel: string,
  kwAbs: string,
  runtime: Runtime,
): LazyNode {
  const tuple = Array.isArray(spec);
  return makeNode(loc(base, kwRel, kwAbs, inst), () => {
    if (!Array.isArray(instance)) return { valid: true, children: [] };

    const children: LazyNode[] = [];
    const evaluated: number[] = [];
    instance.forEach((item, i) => {
      const childSchema = tuple ? (spec as Schema[])[i] : (spec as Schema);
      if (childSchema === undefined) return;
      evaluated.push(i);
      children.push(
        schemaNode(
          childSchema,
          item,
          tuple ? `${kwRel}/${i}` : kwRel,
          `${inst}/${i}`,
          base,
          tuple ? `${kwAbs}/${i}` : kwAbs,
          runtime,
        ),
      );
    });

    let valid = true;
    for (const child of children) {
      if (!child.eval().valid) valid = false;
    }
    return {
      valid,
      children,
      // Aggregating keyword: the child item units carry the messages.
      annotationName: 'items',
      annotation: tuple ? evaluated : true,
    };
  });
}

function combinatorNode(
  kind: 'allOf' | 'anyOf' | 'oneOf',
  branches: Schema[],
  instance: unknown,
  inst: string,
  base: string,
  kwRel: string,
  kwAbs: string,
  runtime: Runtime,
): LazyNode {
  // Children exist before the thunk runs, but evaluate nothing yet.
  const children = branches.map((branch, i) =>
    schemaNode(
      branch,
      instance,
      `${kwRel}/${i}`,
      inst,
      base,
      `${kwAbs}/${i}`,
      runtime,
    ),
  );

  return makeNode(loc(base, kwRel, kwAbs, inst), () => {
    let matches = 0;
    for (const child of children) {
      if (child.eval().valid) matches++;
    }

    let valid: boolean;
    let error: string | undefined;
    if (kind === 'allOf') {
      valid = matches === children.length;
      error = 'allOf requires all subschemas to be valid';
    } else if (kind === 'anyOf') {
      valid = matches >= 1;
      error = 'anyOf requires at least one subschema to be valid';
    } else {
      valid = matches === 1;
      error = 'oneOf requires exactly one subschema to be valid';
    }
    return { valid: valid, error: valid ? undefined : error, children };
  });
}

function notNode(
  branch: Schema,
  instance: unknown,
  inst: string,
  base: string,
  kwRel: string,
  kwAbs: string,
  runtime: Runtime,
): LazyNode {
  const child = schemaNode(branch, instance, kwRel, inst, base, kwAbs, runtime);
  return makeNode(loc(base, kwRel, kwAbs, inst), () => {
    const data = child.eval();
    if (!data.valid) {
      // The inner failure is the *reason `not` succeeds*: report `not` as a
      // valid unit, but hide its failing subschema in every format.
      return { valid: true, children: [child], pruneChildren: true };
    }
    return {
      valid: false,
      error: 'not requires the subschema to be invalid',
      children: [child],
    };
  });
}

function refNode(
  ref: string,
  instance: unknown,
  kwRel: string,
  kwAbs: string,
  inst: string,
  currentBase: string,
  runtime: Runtime,
): LazyNode {
  const resolved = resolveRef(ref, currentBase, runtime);
  if (resolved === undefined) {
    return makeNode(loc(currentBase, kwRel, kwAbs, inst), () => ({
      valid: false,
      error: `unresolved $ref: ${ref}`,
      children: [],
    }));
  }

  // Resolution is pure lookup (no custom keyword execution). The node's
  // keywordLocation stays on "/$ref", while its absolute location jumps to
  // the referenced schema; nested $refs chain through here.
  const inner = schemaNode(
    resolved.schema,
    instance,
    kwRel,
    inst,
    resolved.base,
    resolved.absPtr,
    runtime,
  );

  return makeNode(
    {
      keywordLocation: kwRel,
      absoluteKeywordLocation: inner.absoluteKeywordLocation,
      instanceLocation: inst,
    },
    () => {
      const data = inner.eval();
      return {
        valid: data.valid,
        error: data.error,
        annotationName: data.annotationName,
        annotation: data.annotation,
        children: data.children,
        pruneChildren: data.pruneChildren,
        cyclic: data.cyclic,
      };
    },
  );
}

function customNode(
  keywordName: string,
  handler: CustomKeyword,
  schema: SchemaObject,
  subschema: unknown,
  instance: unknown,
  inst: string,
  base: string,
  kwRel: string,
  kwAbs: string,
): LazyNode {
  return makeNode(loc(base, kwRel, kwAbs, inst), () => {
    let annotation: unknown;
    let annotationName: string | undefined;

    try {
      const result = handler(subschema, instance, {
        schema,
        instance,
        instanceLocation: inst,
        annotate(value, name) {
          annotation = value;
          annotationName = name ?? keywordName;
        },
      });

      if (typeof result === 'boolean') {
        return {
          valid: result,
          error: result ? undefined : 'custom keyword failed',
          children: [],
          annotation: result ? annotation : undefined,
          annotationName: result ? annotationName : undefined,
        };
      }
      if (result === undefined) {
        return {
          valid: true,
          children: [],
          annotation,
          annotationName: annotationName ?? (annotation !== undefined ? keywordName : undefined),
        };
      }
      const valid = result.valid ?? true;
      if (result.annotation !== undefined) annotation = result.annotation;
      if (result.annotationName !== undefined) annotationName = result.annotationName;
      return {
        valid,
        error: result.error ?? (valid ? undefined : 'custom keyword failed'),
        children: [],
        annotation: valid ? annotation : undefined,
        annotationName: valid ? (annotationName ?? (annotation !== undefined ? keywordName : undefined)) : undefined,
      };
    } catch (error) {
      return {
        valid: false,
        error: `custom keyword threw: ${(error as Error).message}`,
        children: [],
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Output formatters (read cached nodes only; nothing re-executes)
// ---------------------------------------------------------------------------

function baseUnit(node: LazyNode): OutputUnit {
  return {
    valid: node.valid,
    keywordLocation: node.keywordLocation,
    absoluteKeywordLocation: node.absoluteKeywordLocation,
    instanceLocation: node.instanceLocation,
  };
}

function formatBasic(root: LazyNode): BasicOutput {
  const errors: OutputUnit[] = [];
  const annotations: OutputUnit[] = [];

  // basic: flatten to a list. An error unit is emitted for every failed node
  // carrying a message (aggregating schema nodes stay silent). Annotations
  // are emitted from valid nodes that produced them.
  const walk = (node: LazyNode): void => {
    const data = node.eval();

    if (!data.valid) {
      if (data.error !== undefined) {
        errors.push({ ...baseUnit(node), error: data.error });
      }
    } else if (data.annotationName !== undefined) {
      annotations.push({
        ...baseUnit(node),
        annotationName: data.annotationName,
        annotation: data.annotation,
      });
    }

    if (!data.pruneChildren) {
      for (const child of data.children) walk(child);
    }
  };

  walk(root);

  const output: BasicOutput = { valid: root.valid };
  if (errors.length) output.errors = errors;
  if (annotations.length) output.annotations = annotations;
  return output;
}

function formatDetailed(node: LazyNode, isRoot = true): DetailedUnit | undefined {
  const data = node.eval();
  if (data.pruneChildren) return unit(data, node); // successful `not`
  if (!isRoot && data.valid) return undefined; // success subtrees are dropped

  // Retain the full failure path even through nodes that are themselves
  // valid (e.g. /properties is valid, but /properties/x/type failed):
  // recurse into every child, keep only the ones that lead to a failure.
  const nested = data.children
    .map((child) => formatDetailed(child, false))
    .filter((u): u is DetailedUnit => u !== undefined);

  const output = unit(data, node);
  if (nested.length) output.errors = nested;
  return output;
}

function unit(data: NodeData, node: LazyNode): DetailedUnit {
  const output: DetailedUnit = { ...baseUnit(node) };
  if (data.error !== undefined && !data.valid) output.error = data.error;
  return output;
}

function formatVerbose(node: LazyNode): VerboseUnit {
  const data = node.eval();
  const unit: VerboseUnit = { ...baseUnit(node) };
  if (data.error !== undefined && !data.valid) unit.error = data.error;
  if (data.valid && data.annotationName !== undefined) {
    unit.annotationName = data.annotationName;
    unit.annotation = data.annotation;
  }

  if (!data.pruneChildren) {
    for (const child of data.children) {
      const childUnit = formatVerbose(child);
      const bucket = childUnit.valid ? 'annotations' : 'errors';
      (unit[bucket] ??= []).push(childUnit);
    }
  }
  return unit;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

class ValidationResultImpl implements ValidationResult {
  constructor(private readonly root: LazyNode) {}

  get valid(): boolean {
    return this.root.eval().valid;
  }

  toOutput<F extends OutputFormat>(format: F): OutputOf<F> {
    switch (format) {
      case 'flag':
        return { valid: this.valid } as OutputOf<F>;
      case 'basic':
        return formatBasic(this.root) as OutputOf<F>;
      case 'detailed':
        return formatDetailed(this.root) as OutputOf<F>;
      case 'verbose':
        return formatVerbose(this.root) as OutputOf<F>;
    }
  }
}

export function validate(
  schema: Schema,
  value: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  const rootBase =
    options.baseURI ??
    (isPlainObject(schema) && typeof schema.$id === 'string'
      ? schema.$id
      : 'https://example.com/schema');

  const documents = new Map<string, Schema>();
  documents.set(rootBase, schema);
  for (const [iri, doc] of Object.entries(options.schemas ?? {})) {
    documents.set(iri, doc);
  }

  const runtime: Runtime = {
    documents,
    keywords: options.keywords ?? {},
    active: new Set(),
    ids: new WeakMap(),
    nextId: { value: 0 },
  };

  const root = schemaNode(schema, value, '', '', rootBase, '', runtime);
  return new ValidationResultImpl(root);
}
