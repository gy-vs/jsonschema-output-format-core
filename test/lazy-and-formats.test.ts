import { describe, expect, it, vi } from 'vitest';
import { validate, type Schema } from '../src/index.js';

describe('combinators: success subtree retention rules', () => {
  it('anyOf keeps only failing branches in detailed, all in verbose', () => {
    const schema: Schema = {
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    };
    const result = validate(schema, 4);

    const detailed = result.toOutput('detailed');
    expect(detailed.valid).toBe(true);
    // Root survives; the two failing branch subtrees are dropped.
    expect(detailed.errors).toBeUndefined();

    const verbose = result.toOutput('verbose');
    // Per-spec bucketing: each unit carries its own errors/annotations
    // lists. Failing branches keep schema-index order...
    const anyOf = collect(verbose).find(
      (u) => u.keywordLocation === '/anyOf',
    )!;
    expect(anyOf.errors.map((u: any) => u.keywordLocation)).toEqual([
      '/anyOf/0',
      '/anyOf/2',
    ]);
    // ...and the single successful branch is in the annotations bucket.
    expect(anyOf.annotations.map((u: any) => u.keywordLocation)).toEqual([
      '/anyOf/1',
    ]);
  });

  it('oneOf fails when multiple branches match', () => {
    const schema: Schema = {
      oneOf: [
        { type: 'integer' },
        { type: 'number' },
      ],
    };
    const result = validate(schema, 4);
    expect(result.valid).toBe(false);
    const basic = result.toOutput('basic');
    expect(basic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keywordLocation: '/oneOf',
          error: expect.stringContaining('exactly one'),
        }),
      ]),
    );
  });

  it('allOf reports every failing branch', () => {
    const schema: Schema = {
      allOf: [{ type: 'string', minLength: 3 } as any, { const: 'abc' }],
    };
    const result = validate(schema, 'x');
    // allOf branch 1 here only has type (valid string); const branch fails.
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.toOutput('detailed'))).toContain('/allOf/1/const');
  });

  it('a successful `not` hides its failing subschema in every format', () => {
    const schema: Schema = { not: { type: 'string' } };
    const result = validate(schema, 4);
    expect(result.valid).toBe(true);
    for (const format of ['flag', 'basic', 'detailed', 'verbose'] as const) {
      const text = JSON.stringify(result.toOutput(format));
      expect(text).not.toContain('expected string');
      expect(text).not.toContain('/not/type');
    }
  });

  it('a failing `not` exposes its own error in detailed and subtree in verbose', () => {
    const schema: Schema = { not: { type: 'string' } };
    const result = validate(schema, 'x');
    expect(result.valid).toBe(false);
    const detailed = JSON.stringify(result.toOutput('detailed'));
    expect(detailed).toContain('/not');
    expect(detailed).toContain('not requires');
    // The valid subschema is a successful subtree, dropped from detailed.
    expect(detailed).not.toContain('/not/type');
    expect(JSON.stringify(result.toOutput('verbose'))).toContain('/not/type');
  });
});

describe('custom keywords and annotations', () => {
  const keywords = {
    xMultipleOf: (sub: any, value: unknown) =>
      typeof value === 'number' && value % sub !== 0
        ? { valid: false, error: `not a multiple of ${sub}` }
        : true,
    xRecorded: (_sub: unknown, value: unknown, ctx: any) => {
      ctx.annotate({ saw: typeof value });
      return true;
    },
    xThrowing: () => {
      throw new Error('boom');
    },
  };

  it('participates in validation and custom messages appear in basic', () => {
    const result = validate({ xMultipleOf: 3 }, 7, { keywords });
    expect(result.valid).toBe(false);
    expect(result.toOutput('basic').errors![0]).toMatchObject({
      keywordLocation: '/xMultipleOf',
      error: 'not a multiple of 3',
    });
    expect(validate({ xMultipleOf: 3 }, 9, { keywords }).valid).toBe(true);
  });

  it('surfaces custom annotations in basic and verbose', () => {
    const result = validate({ type: 'number', xRecorded: true }, 1, {
      keywords,
    });
    const basic = result.toOutput('basic');
    expect(basic.annotations).toEqual([
      expect.objectContaining({
        keywordLocation: '/xRecorded',
        annotationName: 'xRecorded',
        annotation: { saw: 'number' },
      }),
    ]);
    const verbose = JSON.stringify(result.toOutput('verbose'));
    expect(verbose).toContain('"saw":"number"');
  });

  it('turns thrown errors into failed nodes', () => {
    const result = validate({ xThrowing: true }, 1, { keywords });
    expect(result.valid).toBe(false);
    expect(result.toOutput('basic').errors![0].error).toContain('boom');
  });
});

describe('lazy evaluation and memoisation', () => {
  it('does not run keyword logic before valid or output is requested', () => {
    const handler = vi.fn(() => true);
    // Constructing the result performs no evaluation.
    const result = validate({ xLazy: true }, 1, { keywords: { xLazy: handler } });
    expect(handler).not.toHaveBeenCalled();
    result.valid;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('evaluates each lazy node exactly once across all formats', () => {
    const handler = vi.fn((_sub: unknown, value: unknown) =>
      typeof value === 'number' ? true : { valid: false, error: 'nope' },
    );
    const schema: Schema = {
      allOf: [{ xCheck: 1 }, { xCheck: 2 }],
      properties: { a: { xCheck: 3 } },
    } as any;
    const result = validate(schema, { a: 'x' }, { keywords: { xCheck: handler } });
    expect(handler).not.toHaveBeenCalled(); // purely lazy construction

    // Forcing the root evaluates every keyword node without short-circuiting.
    result.toOutput('flag');
    expect(handler).toHaveBeenCalledTimes(3);

    // Repeated formatting, in any order, only reads cached nodes.
    result.toOutput('basic');
    result.toOutput('detailed');
    result.toOutput('verbose');
    result.toOutput('basic');
    result.toOutput('verbose');
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('never re-executes custom keywords when converting between formats', () => {
    const handler = vi.fn((_sub: unknown, value: unknown, ctx: any) => {
      ctx.annotate(String(value));
      return true;
    });
    const result = validate({ xOnce: true }, 42, { keywords: { xOnce: handler } });
    for (const format of ['basic', 'detailed', 'verbose', 'flag'] as const) {
      result.toOutput(format);
    }
    result.toOutput('verbose');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('multiple formatting and deterministic verbose order', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a', 'b'],
    properties: {
      a: { type: 'string' },
      b: { type: 'number' },
    },
  };

  it('repeated formatting yields identical results', () => {
    const result = validate(schema, { a: 1, b: 'two' });
    const first = JSON.stringify(result.toOutput('verbose'));
    result.toOutput('basic');
    result.toOutput('detailed');
    result.toOutput('flag');
    expect(JSON.stringify(result.toOutput('verbose'))).toBe(first);
  });

  it('expands verbose nodes in a deterministic, document-based order', () => {
    const result = validate(schema, { a: 1, b: 'two' });
    const verbose = result.toOutput('verbose');

    // Errors subtree, pre-order document order (schema keyword, then
    // property/item); the failed root itself is reported at top level.
    const flat = collect(verbose);
    expect(
      flat.filter((u) => !u.valid).map((u) => u.keywordLocation),
    ).toEqual([
      '',
      '/properties',
      '/properties/a',
      '/properties/a/type',
      '/properties/b',
      '/properties/b/type',
    ]);
    // Successful keyword units appear in the annotations lists.
    expect(
      flat
        .filter((u) => u.valid)
        .map((u) => u.keywordLocation)
        .sort(),
    ).toEqual(['/required', '/type']);
  });

  it('annotations of failed branches are omitted in basic but kept in verbose', () => {
    const result = validate(schema, { a: 1, b: 2 });
    const basic = result.toOutput('basic');
    // /properties is not invalid itself, but the failing /a branch means
    // annotations from under it are not reported in basic.
    const names = (basic.annotations ?? []).map((a) => a.keywordLocation);
    expect(names).not.toContain('/properties/a/type');
    const verbose = result.toOutput('verbose');
    expect(
      collect(verbose).some((u) => u.keywordLocation === '/properties/a/type'),
    ).toBe(true);
  });
});

function collect(unit: any): any[] {
  const out = [unit];
  for (const list of [unit.errors, unit.annotations]) {
    if (Array.isArray(list)) for (const child of list) out.push(...collect(child));
  }
  return out;
}

function preOrder(unit: any, bucket: 'errors' | 'annotations'): any[] {
  const out = [unit];
  if (Array.isArray(unit[bucket])) {
    for (const child of unit[bucket]) out.push(...preOrder(child, bucket));
  }
  return out;
}
