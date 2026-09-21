import { describe, expect, it } from 'vitest';
import { validate } from '../src/index.js';

describe('validate() core', () => {
  it('returns a lazy result with a valid flag', () => {
    const result = validate({ type: 'string' }, 3);
    expect(result.valid).toBe(false);
    expect(result.toOutput('flag')).toEqual({ valid: false });
  });

  it('accepts valid instances', () => {
    const result = validate({ type: 'object', required: ['name'] }, { name: 'x' });
    expect(result.valid).toBe(true);
  });

  it('supports boolean schemas', () => {
    expect(validate(false, 'anything').valid).toBe(false);
    expect(validate(true, 'anything').valid).toBe(true);
  });

  it('reports nested property failures', () => {
    const result = validate(
      {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      },
      { a: 3 },
    );
    const basic = result.toOutput('basic');
    expect(basic.valid).toBe(false);
    expect(basic.errors?.[0]).toMatchObject({
      instanceLocation: '/a',
      keywordLocation: '/properties/a/type',
    });
  });

  it('supports tuple and array items', () => {
    expect(
      validate({ type: 'array', items: { type: 'number' } }, [1, 2, 3]).valid,
    ).toBe(true);
    expect(
      validate({ type: 'array', items: [{ type: 'string' }] }, [1]).valid,
    ).toBe(false);
  });

  it('evaluates enum and const structurally', () => {
    expect(validate({ enum: [{ a: 1 }] }, { a: 1 }).valid).toBe(true);
    expect(validate({ const: { a: 1 } }, { a: 2 }).valid).toBe(false);
  });
});
