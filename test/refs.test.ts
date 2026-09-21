import { describe, expect, it } from 'vitest';
import { validate, type Schema } from '../src/index.js';

describe('$ref resolution', () => {
  it('follows a nested $ref through $defs', () => {
    const schema: Schema = {
      $defs: {
        positive: { $ref: '#/$defs/nonNegative' },
        nonNegative: { type: 'number' },
      },
      allOf: [{ $ref: '#/$defs/positive' }],
    };
    const result = validate(schema, 'nope');
    expect(result.valid).toBe(false);
    const basic = result.toOutput('basic');
    expect(basic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          // Relative location keeps traversing through each $ref...
          keywordLocation: '/allOf/0/$ref/$ref/type',
          // ...while the absolute location jumps to the referenced schema.
          absoluteKeywordLocation:
            'https://example.com/schema#/$defs/nonNegative/type',
          instanceLocation: '',
        }),
      ]),
    );
  });

  it('resolves chained refs across external documents', () => {
    const remote: Schema = {
      $defs: { string: { type: 'string' } },
    };
    const main: Schema = {
      $ref: 'https://other.example/types#/$defs/string',
    };
    const result = validate(main, 5, {
      schemas: { 'https://other.example/types': remote },
    });
    expect(result.valid).toBe(false);
    expect(result.toOutput('basic').errors![0].absoluteKeywordLocation).toBe(
      'https://other.example/types#/$defs/string/type',
    );
  });

  it('reports unresolved refs', () => {
    const result = validate({ $ref: 'https://missing.example/x#' }, 1);
    expect(result.valid).toBe(false);
    expect(result.toOutput('basic').errors![0].error).toMatch(/unresolved \$ref/);
  });

  it('validates recursive schemas against finite data (tree)', () => {
    const schema: Schema = {
      $defs: {
        node: {
          type: 'object',
          required: ['value'],
          properties: {
            value: { type: 'number' },
            children: {
              type: 'array',
              items: { $ref: '#/$defs/node' },
            },
          },
        },
      },
      $ref: '#/$defs/node',
    };

    expect(
      validate(schema, {
        value: 1,
        children: [{ value: 2 }, { value: 3, children: [{ value: 4 }] }],
      }).valid,
    ).toBe(true);

    const bad = validate(schema, {
      value: 1,
      children: [{ value: 'no' }, { value: 3, children: [{ value: true }] }],
    });
    expect(bad.valid).toBe(false);
    const locations = (bad.toOutput('basic').errors ?? []).map(
      (e) => e.instanceLocation,
    );
    expect(locations).toContain('/children/0/value');
    expect(locations).toContain('/children/1/children/0/value');
  });

  it('terminates on self-referential (cyclic) schema data', () => {
    const schema: Schema = {
      $defs: {
        node: {
          type: 'object',
          properties: {
            next: { $ref: '#/$defs/node' },
          },
        },
      },
      $ref: '#/$defs/node',
    };
    const cyclic: any = {};
    cyclic.next = cyclic;

    const result = validate(schema, cyclic);
    // Finite evaluation: returns a result instead of overflowing the stack.
    expect(() => result.toOutput('verbose')).not.toThrow();
    expect(result.valid).toBe(true);
  });

  it('un-escapes JSON Pointer tokens when resolving refs', () => {
    const schema: Schema = {
      $defs: {
        'a/b': { $defs: { 'c~d': { type: 'string' } } },
      },
      $ref: '#/$defs/a~1b/$defs/c~0d',
    };
    const result = validate(schema, 9);
    expect(result.valid).toBe(false);
    const error = result.toOutput('basic').errors![0];
    expect(error.keywordLocation).toBe('/$ref/type');
    expect(error.absoluteKeywordLocation).toBe(
      'https://example.com/schema#/$defs/a~1b/$defs/c~0d/type',
    );
  });
});

describe('instance location JSON Pointer escaping', () => {
  it('escapes property names containing ~ and /', () => {
    const schema: Schema = {
      type: 'object',
      properties: { 'a/b': { type: 'string' }, 'm~n': { type: 'number' } },
    };
    const result = validate(schema, { 'a/b': 1, 'm~n': 'x' });
    const locations = (result.toOutput('basic').errors ?? []).map(
      (e) => e.instanceLocation,
    );
    expect(locations).toEqual(expect.arrayContaining(['/a~1b', '/m~0n']));
  });
});
