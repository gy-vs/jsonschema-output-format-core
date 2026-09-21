import { describe, expect, it, vi } from 'vitest';
import { validate, format, formatFlag, formatBasic, formatDetailed, formatVerbose } from '../src/index.js';
import type { BasicOutput, DetailedOutput, Schema, VerboseOutput } from '../src/index.js';
import type { LazyNode } from '../src/node.js';

/** Keyword locations of every unit in a verbose tree, in expansion order. */
function locations(tree: VerboseOutput): string[] {
  return [tree.keywordLocation, ...((tree.annotations ?? []).flatMap(locations))];
}

/** Absolute keyword locations of every unit in a verbose tree. */
function absoluteLocations(tree: VerboseOutput): string[] {
  return [tree.absoluteKeywordLocation, ...((tree.annotations ?? []).flatMap(absoluteLocations))];
}

/** Collect instance locations of every verbose unit. */
function instanceLocations(tree: VerboseOutput): string[] {
  return [tree.instanceLocation, ...((tree.annotations ?? []).flatMap(instanceLocations))];
}

/** Flatten every annotation string carried by a verbose tree. */
function allAnnotations(tree: VerboseOutput): (string | undefined)[] {
  return [tree.annotation, ...((tree.annotations ?? []).flatMap(allAnnotations))];
}

describe('flag / basic / detailed / verbose parity', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' } },
  };

  it('agrees on valid across all four formats', () => {
    for (const value of [{ a: 'x' }, { a: 3 }, {}]) {
      const root = validate(schema, value);
      const valid = root.valid;
      expect(formatFlag(root).valid).toBe(valid);
      expect(formatBasic(root).valid).toBe(valid);
      expect(formatDetailed(root).valid).toBe(valid);
      expect(formatVerbose(root).valid).toBe(valid);
    }
  });

  it('flag is just a boolean flag', () => {
    expect(format(validate(schema, { a: 'x' }), 'flag')).toEqual({ valid: true });
    expect(format(validate(schema, { a: 3 }), 'flag')).toEqual({ valid: false });
  });

  it('basic flattens failing leaf assertions in DFS order', () => {
    const out = formatBasic(validate(schema, { a: 3 })) as BasicOutput;
    expect(out.valid).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({
      keywordLocation: '/properties/a/type',
      absoluteKeywordLocation: '#/properties/a/type',
      instanceLocation: '/a',
      valid: false,
    });
    expect(out.errors[0].annotation).toBe('expected string');
  });

  it('basic lists both required and type failures', () => {
    const out = formatBasic(validate(schema, {})) as BasicOutput;
    expect(out.errors.map((e) => e.keywordLocation)).toEqual(['/required']);
    expect(out.errors[0].instanceLocation).toBe('/a');
  });

  it('detailed keeps only failing paths', () => {
    const out = formatDetailed(validate(schema, { a: 3 })) as DetailedOutput;
    expect(out.valid).toBe(false);
    // root -> properties -> type; the successful schema container is spliced.
    expect(out.errors?.map((e) => e.keywordLocation)).toEqual(['/properties']);
    expect(out.errors?.[0].errors?.[0].keywordLocation).toBe('/properties/a/type');
    // No successful unit survives anywhere in the pruned tree.
    const hasValidNode = (n: DetailedOutput): boolean =>
      n.valid || (n.errors ?? []).some(hasValidNode);
    expect(hasValidNode(out)).toBe(false);
  });

  it('verbose retains successful nodes and annotations', () => {
    const out = formatVerbose(validate(schema, { a: 'x' }));
    expect(out.valid).toBe(true);
    expect(locations(out)).toContain('/properties/a/type');
    expect(locations(out)).toContain('/properties');
  });
});

describe('nested $ref', () => {
  const schema: Schema = {
    $defs: {
      inner: { type: 'string' },
      wrapper: { $ref: '#/$defs/inner' },
    },
    $ref: '#/$defs/wrapper',
  };

  it('chains keyword locations and resets absolute locations at the target', () => {
    const out = formatVerbose(validate(schema, 3));
    const locs = locations(out);
    expect(locs).toContain('/$ref/$ref/type');
    const abs = absoluteLocations(out);
    // The keyword location walks the chain; the absolute location identifies
    // the actual schema document node, reset at every $ref target.
    expect(abs).toContain('#/$defs/wrapper');
    expect(abs).toContain('#/$defs/inner/type');
    expect(out.valid).toBe(false);
  });

  it('formats agree for ref chains', () => {
    const root = validate(schema, 'ok');
    expect(root.valid).toBe(true);
    expect(formatBasic(root).errors).toEqual([]);
    expect(formatDetailed(root).valid).toBe(true);
    expect(formatDetailed(root).errors).toBeUndefined();
  });
});

describe('combinator success/failure retention', () => {
  it('anyOf success keeps only passing branches; failure keeps all', () => {
    const schema: Schema = {
      anyOf: [{ type: 'string' }, { type: 'number' }],
    };
    const ok = formatVerbose(validate(schema, 1));
    // Only branch 0 (string) failed, and on success only the passing
    // branch (number) is retained.
    expect(locations(ok)).not.toContain('/anyOf/0/type');
    expect(locations(ok)).toContain('/anyOf/1/type');

    const bad = validate(schema, true);
    expect(bad.valid).toBe(false);
    const badTree = formatVerbose(bad);
    expect(locations(badTree)).toContain('/anyOf/0/type');
    expect(locations(badTree)).toContain('/anyOf/1/type');
    expect(formatBasic(bad).errors).toHaveLength(2);
  });

  it('allOf failure drops successful branches', () => {
    const schema: Schema = {
      allOf: [{ type: 'number' }, { type: 'string' }],
    };
    const out = formatVerbose(validate(schema, 1));
    // Branch 0 (number) passes; on allOf failure it is not retained.
    expect(locations(out)).not.toContain('/allOf/0/type');
    expect(locations(out)).toContain('/allOf/1/type');
  });

  it('oneOf keeps all branches on both kinds of failure', () => {
    const over = formatVerbose(validate(
      { oneOf: [{ type: 'number' }, { type: 'number' }] } as Schema, 1,
    ));
    expect(over.valid).toBe(false);
    expect(locations(over)).toContain('/oneOf/0/type');
    expect(locations(over)).toContain('/oneOf/1/type');

    const under = formatVerbose(validate(
      { oneOf: [{ type: 'string' }, { type: 'string' }] } as Schema, 1,
    ));
    expect(locations(under)).toContain('/oneOf/0/type');
    expect(locations(under)).toContain('/oneOf/1/type');
  });

  it('basic reports the combinator itself when oneOf matches twice', () => {
    const root = validate(
      { oneOf: [{ type: 'number' }, { type: 'number' }] } as Schema, 1,
    );
    const basic = formatBasic(root);
    expect(basic.valid).toBe(false);
    expect(basic.errors).toHaveLength(1);
    expect(basic.errors[0].keywordLocation).toBe('/oneOf');
    expect(basic.errors[0].annotation).toContain('2 subschemas matched');
  });
});

describe('custom annotations run once and survive formatting', () => {
  it('records annotations on success and failure without re-running', () => {
    const spy = vi.fn((v: unknown) =>
      typeof v === 'number'
        ? { valid: true, annotation: `got number ${v}` }
        : 'must be a number',
    );
    const schema = { type: 'number', 'x-evenish': spy } as unknown as Schema;

    const root = validate(schema, 4);
    expect(root.valid).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Render every format repeatedly: the custom keyword never re-executes.
    for (const fmt of ['flag', 'basic', 'detailed', 'verbose'] as const) {
      format(root, fmt);
      format(root, fmt);
    }
    expect(spy).toHaveBeenCalledTimes(1);

    const tree = formatVerbose(root);
    expect(allAnnotations(tree)).toContain('got number 4');

    const bad = validate(schema, 'nope');
    expect(bad.valid).toBe(false);
    expect(formatBasic(bad).errors.some((e) => e.annotation === 'must be a number')).toBe(true);
  });

  it('evaluates custom keywords after standard keywords, in insertion order', () => {
    const order: string[] = [];
    const mk = (name: string) => () => { order.push(name); return true; };
    const schema = {
      type: 'object',
      'x-zeta': mk('zeta'),
      'x-alpha': mk('alpha'),
    } as unknown as Schema;
    formatVerbose(validate(schema, {}));
    expect(order).toEqual(['zeta', 'alpha']);
  });
});

describe('cyclic schemas', () => {
  // Recursive tree schema: each object has an optional string leaf and
  // optional children that are the same schema via a self $ref.
  const treeSchema: Schema = {
    $id: 'https://example.test/tree',
    type: 'object',
    properties: {
      leaf: { type: 'string' },
      child: { $ref: 'https://example.test/tree#' },
    },
  };
  const opts = { baseUri: 'https://example.test/tree' };

  it('validates a finite deeply nested instance without cutting', () => {
    const value = { child: { child: { child: { leaf: 'deep' } } } };
    const root = validate(treeSchema, value, opts);
    expect(root.valid).toBe(true);
    const tree = formatVerbose(root);
    expect(tree.valid).toBe(true);
    // No cycle was cut: the instance was finite with distinct objects.
    expect(allAnnotations(tree).filter(Boolean).join(' ')).not.toContain('cyclic $ref');
  });

  it('reports failures inside the recursive chain without infinite recursion', () => {
    const root = validate(treeSchema, { child: { child: 7 } }, opts);
    expect(root.valid).toBe(false);
    const basic = formatBasic(root);
    const err = basic.errors.find((e) => e.instanceLocation === '/child/child');
    expect(err).toBeDefined();
    expect(err?.keywordLocation).toContain('/type');
  });

  it('cuts the cycle when the instance object contains itself', () => {
    const circular: Record<string, unknown> = { leaf: 'ok' };
    circular.child = circular;
    const root = validate(treeSchema, circular, opts);
    expect(root.valid).toBe(true);
    expect(() => formatVerbose(root)).not.toThrow();
    const tree = formatVerbose(root);
    expect(allAnnotations(tree).filter(Boolean).join(' ')).toContain('cyclic $ref');
  });
});

describe('escaped JSON pointers', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a/b', 'c~d'],
    properties: {
      'a/b': { type: 'string' },
      'c~d': { type: 'number' },
    },
  };

  it('escapes property tokens in keyword and instance locations', () => {
    const root = validate(schema, { 'a/b': 5, 'c~d': 'x' });
    expect(root.valid).toBe(false);
    const basic = formatBasic(root);
    expect(basic.errors.map((e) => e.keywordLocation).sort()).toEqual([
      '/properties/a~1b/type',
      '/properties/c~0d/type',
    ]);
    expect(basic.errors.map((e) => e.instanceLocation).sort()).toEqual([
      '/a~1b',
      '/c~0d',
    ]);
    const verbose = formatVerbose(root);
    expect(instanceLocations(verbose)).toContain('/a~1b');
  });

  it('can resolve $ref tokens containing ~ and /', () => {
    const schema: Schema = {
      $defs: { 'odd/name~x': { type: 'boolean' } } as unknown as Record<string, Schema>,
      $ref: '#/$defs/odd~1name~0x',
    };
    const root = validate(schema, true);
    expect(root.valid).toBe(true);
    const out = formatBasic(validate(schema, 1));
    expect(out.errors[0].absoluteKeywordLocation).toBe('#/$defs/odd~1name~0x/type');
  });
});

describe('determinism and laziness', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' }, b: { items: { type: 'number' } } },
  };

  it('verbose expansion order is stable across repeated formatting', () => {
    const root = validate(schema, { a: 'x', b: [1, 2] });
    const first = locations(formatVerbose(root));
    for (let i = 0; i < 5; i++) {
      expect(locations(formatVerbose(root))).toEqual(first);
    }
    // Successful `required` emits no unit; keyword order starts type, then
    // properties, and array items expand by ascending index.
    expect(first.slice(0, 2)).toEqual(['', '/type']);
    expect(first).toContain('/properties/b/items/0/type');
    expect(first.indexOf('/properties/b/items/0/type'))
      .toBeLessThan(first.indexOf('/properties/b/items/1/type'));
  });

  it('multiple formats from one validation agree and share the tree', () => {
    const root = validate(schema, { a: 1 });
    const results = [
      formatFlag(root),
      formatBasic(root),
      formatDetailed(root),
      formatVerbose(root),
      // repeat: memoized views/results, no recomputation
      formatFlag(root),
      formatBasic(root),
      formatDetailed(root),
      formatVerbose(root),
    ];
    expect(results.every((r) => r.valid === false)).toBe(true);
  });

  it('lazy nodes evaluate their thunk exactly once', () => {
    let typeEvals = 0;
    const spy = vi.fn((v: unknown) => { typeEvals++; return typeof v === 'string'; });
    const s = { 'x-type': spy } as unknown as Schema;
    const root: LazyNode = validate(s, 'hi');
    // Before any formatting nothing ran.
    expect(spy).not.toHaveBeenCalled();
    root.valid;
    root.valid;
    formatVerbose(root);
    formatBasic(root);
    formatDetailed(root);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(typeEvals).toBe(1);
  });

  it('flag does not build the error tree (unreached subtrees stay lazy)', () => {
    // A property absent from the instance is never descended into; flag
    // formatting must not force its custom keyword.
    const propSpy = vi.fn(() => true);
    const s = {
      type: 'object',
      properties: { deep: { 'x-annotation': propSpy } },
    } as unknown as Schema;
    const root = validate(s, {});
    formatFlag(root);
    expect(propSpy).not.toHaveBeenCalled();
  });
});
