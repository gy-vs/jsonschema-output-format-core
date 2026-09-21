import { LazyNode, leaf, type VResult } from './node.js';
import { pointerJoin, escapeToken } from './pointer.js';
import type { SchemaRegistry } from './registry.js';
import type { Schema } from './types.js';

const KNOWN_KEYWORDS = new Set([
  '$id', '$ref', '$defs', '$comment',
  'type', 'enum', 'required', 'properties', 'items',
  'allOf', 'anyOf', 'oneOf',
]);

export type CustomKeywordFn = (
  value: unknown,
  instanceLocation: string,
) => boolean | string | { valid: boolean; annotation?: string };

function checkType(type: Schema['type'], value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length &&
      ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Tracks which `(schema node, instance value)` pairs are already active on
 * the current descent. Identity (object reference) is used for instances,
 * not their pointer: a value that contains itself must be detected even
 * though every visit has a distinct instance location.
 */
class VisitState {
  private readonly active = new Set<string>();

  private constructor(private readonly parent?: VisitState) {}

  static root(): VisitState {
    return new VisitState();
  }

  private static instanceKey(value: unknown): string | null {
    if (value === null || typeof value !== 'object') return null;
    // Tag each object/array once with a hidden identity id.
    const tagged = value as { __visitId?: number };
    if (tagged.__visitId === undefined) {
      Object.defineProperty(tagged, '__visitId', {
        value: VisitState.nextId++, enumerable: false, configurable: true,
      });
    }
    return 'obj:' + tagged.__visitId;
  }

  private static nextId = 1;

  /** Key for an in-progress $ref descent into `value`. */
  keyFor(canonical: string, value: unknown): string | null {
    const ik = VisitState.instanceKey(value);
    return ik === null ? null : canonical + '|' + ik;
  }

  has(key: string): boolean {
    return this.active.has(key) || (this.parent?.has(key) ?? false);
  }

  /** Return a child state with `key` marked active. */
  extend(key: string): VisitState {
    const child = new VisitState(this);
    child.active.add(key);
    return child;
  }
}

/**
 * Validate `schema` against `value`, producing a lazy output tree.
 *
 * Nothing executes until the root node's `valid` (or a formatter) is read;
 * every node's thunk is memoized, so custom keyword functions and assertion
 * checks run at most once no matter how many formats are rendered.
 */
export function evaluate(
  registry: SchemaRegistry,
  schema: Schema,
  value: unknown,
): LazyNode {
  const rootAbs = registry.rootId ? registry.rootId + '#' : '#';
  return evalSchema(schema, value, '', '', rootAbs, registry, VisitState.root(), false);
}

function schemaNode(
  schema: Schema,
  value: unknown,
  inst: string,
  kwBase: string,
  absBase: string,
  registry: SchemaRegistry,
  visits: VisitState,
  transparent: boolean,
): LazyNode {
  return new LazyNode(() => {
    const children = buildKeywordNodes(
      schema, value, inst, kwBase, absBase, registry, visits,
    );
    const result: VResult = {
      valid: children.every((c) => c.valid),
      keyword: '',
      keywordLocation: kwBase,
      absoluteKeywordLocation: absBase,
      instanceLocation: inst,
      children,
    };
    if (transparent) result.transparent = true;
    return result;
  });
}

function evalSchema(
  schema: Schema,
  value: unknown,
  inst: string,
  kwBase: string,
  absBase: string,
  registry: SchemaRegistry,
  visits: VisitState,
  transparent: boolean,
): LazyNode {
  return schemaNode(schema, value, inst, kwBase, absBase, registry, visits, transparent);
}

function buildKeywordNodes(
  schema: Schema,
  value: unknown,
  inst: string,
  kwBase: string,
  absBase: string,
  registry: SchemaRegistry,
  visits: VisitState,
): LazyNode[] {
  const nodes: LazyNode[] = [];

  // --- $ref (resolved first; siblings still evaluated per 2019-09+) ---
  if (typeof schema.$ref === 'string') {
    nodes.push(makeRefNode(schema.$ref, value, inst, kwBase, registry, visits));
  }

  if (schema.type !== undefined) {
    nodes.push(leaf(
      'type', kwBase + '/type', absBase + '/type', inst,
      checkType(schema.type, value),
      checkType(schema.type, value) ? undefined : `expected ${schema.type}`,
    ));
  }

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((candidate) => deepEqual(candidate, value));
    nodes.push(leaf(
      'enum', kwBase + '/enum', absBase + '/enum', inst, ok,
      ok ? undefined : 'value is not one of the enum values',
    ));
  }

  if (Array.isArray(schema.required) && checkType('object', value)) {
    const row = value as Record<string, unknown>;
    for (const key of schema.required) {
      if (!(key in row)) {
        nodes.push(leaf(
          'required',
          kwBase + '/required',
          absBase + '/required',
          pointerJoin(inst, key),
          false,
          `required property ${JSON.stringify(key)} is missing`,
        ));
      }
    }
  }

  if (schema.properties && checkType('object', value)) {
    const row = value as Record<string, unknown>;
    const children: LazyNode[] = [];
    // Insertion order of the schema object is the deterministic traversal order.
    for (const key of Object.keys(schema.properties)) {
      if (!(key in row)) continue;
      const token = escapeToken(key);
      children.push(evalSchema(
        schema.properties[key],
        row[key],
        pointerJoin(inst, key),
        `${kwBase}/properties/${token}`,
        `${absBase}/properties/${token}`,
        registry, visits, true,
      ));
    }
    nodes.push(new LazyNode(() => ({
      valid: children.every((c) => c.valid),
      keyword: 'properties',
      keywordLocation: kwBase + '/properties',
      absoluteKeywordLocation: absBase + '/properties',
      instanceLocation: inst,
      children,
    })));
  }

  if (schema.items && checkType('array', value)) {
    const arr = value as unknown[];
    const children = arr.map((item, i) => evalSchema(
      schema.items as Schema,
      item,
      pointerJoin(inst, String(i)),
      kwBase + '/items/' + i,
      absBase + '/items/' + i,
      registry, visits, true,
    ));
    nodes.push(new LazyNode(() => ({
      valid: children.every((c) => c.valid),
      keyword: 'items',
      keywordLocation: kwBase + '/items',
      absoluteKeywordLocation: absBase + '/items',
      instanceLocation: inst,
      children,
    })));
  }

  for (const comb of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[comb];
    if (!Array.isArray(branches)) continue;
    nodes.push(makeCombinator(comb, branches, value, inst, kwBase, absBase, registry, visits));
  }

  // --- Custom keywords (object insertion order, evaluated once) ---
  for (const key of Object.keys(schema)) {
    if (KNOWN_KEYWORDS.has(key)) continue;
    const fn = (schema as Record<string, unknown>)[key];
    if (typeof fn !== 'function') continue;
    nodes.push(makeCustomNode(key, fn as CustomKeywordFn, value, inst, kwBase, absBase));
  }

  // Nodes are pushed in canonical keyword order ($ref, type, enum, required,
  // properties, items, combinators, then custom keywords in schema insertion
  // order), which is also the deterministic verbose expansion order. Sorting
  // here would force every node just to read its keyword and make custom
  // keyword execution order depend on the sort comparator.
  return nodes;
}

function makeRefNode(
  ref: string,
  value: unknown,
  inst: string,
  kwBase: string,
  registry: SchemaRegistry,
  visits: VisitState,
): LazyNode {
  const refKw = kwBase + '/$ref';
  const canonical = registry.canonicalRef(ref, registry.rootId);
  // Object/array instances are keyed by identity (a self-containing value
  // has a fresh pointer at every depth); primitives fall back to the
  // canonical+pointer key so schemas unbounded over primitives also cut.
  const identityKey = visits.keyFor(canonical, value) ?? canonical + '@' + inst;

  return new LazyNode(() => {
    // Same schema node already validating the same instance on this descent:
    // cut the cycle and record it as an annotation rather than looping.
    if (visits.has(identityKey)) {
      return {
        valid: true,
        keyword: '$ref',
        keywordLocation: refKw,
        absoluteKeywordLocation: canonical,
        instanceLocation: inst,
        annotation: `cyclic $ref ${JSON.stringify(ref)} skipped`,
        children: [],
      };
    }
    const target = registry.resolve(ref, registry.rootId);
    const nextVisits = visits.extend(identityKey);
    // The target schema is a transparent container: its keyword locations
    // continue under /$ref while absolute locations reset to the target.
    const child = evalSchema(
      target, value, inst, refKw, canonical, registry, nextVisits, true,
    );
    return {
      valid: child.valid,
      keyword: '$ref',
      keywordLocation: refKw,
      absoluteKeywordLocation: canonical,
      instanceLocation: inst,
      children: [child],
    };
  });
}

function makeCombinator(
  keyword: 'allOf' | 'anyOf' | 'oneOf',
  branches: Schema[],
  value: unknown,
  inst: string,
  kwBase: string,
  absBase: string,
  registry: SchemaRegistry,
  visits: VisitState,
): LazyNode {
  const kwLoc = `${kwBase}/${keyword}`;
  const absLoc = `${absBase}/${keyword}`;
  // Branch schemas are transparent containers; their own keyword children
  // carry locations like /anyOf/0/type.
  const children = branches.map((branch, i) => evalSchema(
    branch, value, inst,
    `${kwLoc}/${i}`, `${absLoc}/${i}`,
    registry, visits, true,
  ));

  return new LazyNode(() => {
    // Force every branch first: anyOf/oneOf validity needs the full picture.
    const branchValid = children.map((c) => c.valid);
    let valid: boolean;
    if (keyword === 'allOf') valid = branchValid.every(Boolean);
    else if (keyword === 'anyOf') valid = branchValid.some(Boolean);
    else valid = branchValid.filter(Boolean).length === 1;

    // Semantic subtree retention (JSON Schema output appendix):
    //  - allOf failure: only failing branches can carry errors
    //  - anyOf success: only passing branches remain meaningful
    //  - oneOf: keep everything — no-match and multi-match both need
    //    every branch to diagnose the mismatch.
    // Formatters prune the survivors further (flag/basic/detailed drop
    // successful subtrees; verbose keeps them).
    let kept = children;
    if (keyword === 'allOf' && !valid) kept = children.filter((c) => !c.valid);
    else if (keyword === 'anyOf' && valid) kept = children.filter((c) => c.valid);

    // The combinator itself fails even though every branch passes only for
    // oneOf-with-too-many-matches; that is the combinator's own error unit.
    let annotation: string | undefined;
    if (!valid) {
      if (keyword === 'allOf') annotation = 'allOf failed: one or more subschemas failed';
      else if (keyword === 'anyOf') annotation = 'anyOf failed: no subschema matched';
      else annotation = `oneOf failed: ${branchValid.filter(Boolean).length} subschemas matched`;
    }

    return {
      valid,
      keyword,
      keywordLocation: kwLoc,
      absoluteKeywordLocation: absLoc,
      instanceLocation: inst,
      annotation,
      children: kept,
    };
  });
}

function makeCustomNode(
  keyword: string,
  fn: CustomKeywordFn,
  value: unknown,
  inst: string,
  kwBase: string,
  absBase: string,
): LazyNode {
  return new LazyNode(() => {
    let outcome: ReturnType<CustomKeywordFn>;
    try {
      outcome = fn(value, inst);
    } catch (err) {
      outcome = `custom keyword threw: ${(err as Error).message}`;
    }
    let valid = false;
    let annotation: string | undefined;
    if (typeof outcome === 'boolean') {
      valid = outcome;
      annotation = valid ? `custom keyword ${JSON.stringify(keyword)} passed`
                         : `custom keyword ${JSON.stringify(keyword)} failed`;
    } else if (typeof outcome === 'string') {
      // A returned string signals failure carrying that error annotation.
      valid = false;
      annotation = outcome;
    } else {
      valid = outcome.valid;
      annotation = outcome.annotation ?? (valid
        ? `custom keyword ${JSON.stringify(keyword)} passed`
        : `custom keyword ${JSON.stringify(keyword)} failed`);
    }
    return {
      valid,
      keyword,
      keywordLocation: kwBase + '/' + keyword,
      absoluteKeywordLocation: absBase + '/' + keyword,
      instanceLocation: inst,
      annotation,
      children: [],
    };
  });
}
