import { describe, expect, it } from 'vitest';
import {
  validate,
  type DetailedUnit,
  type Schema,
  type VerboseUnit,
} from '../src/index.js';

const schema: Schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    age: { type: 'number' },
  },
  required: ['name'],
};

describe('output formats', () => {
  const invalidInstance = { name: 42, age: 'old' };

  it('flag only contains valid', () => {
    const result = validate(schema, invalidInstance);
    expect(result.toOutput('flag')).toEqual({ valid: false });
  });

  it('all four formats agree on valid for failing instances', () => {
    const result = validate(schema, invalidInstance);
    expect(result.toOutput('flag').valid).toBe(false);
    expect(result.toOutput('basic').valid).toBe(false);
    expect(result.toOutput('detailed').valid).toBe(false);
    expect(result.toOutput('verbose').valid).toBe(false);
  });

  it('all four formats agree on valid for passing instances', () => {
    const result = validate(schema, { name: 'Ada', age: 36 });
    expect(result.toOutput('flag').valid).toBe(true);
    expect(result.toOutput('basic').valid).toBe(true);
    expect(result.toOutput('detailed').valid).toBe(true);
    expect(result.toOutput('verbose').valid).toBe(true);
  });

  it('basic is a flat list of error units with locations', () => {
    const result = validate(schema, invalidInstance);
    const basic = result.toOutput('basic');
    expect(basic.errors).toHaveLength(2);
    expect(basic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          valid: false,
          keywordLocation: '/properties/name/type',
          instanceLocation: '/name',
          error: expect.stringContaining('string'),
        }),
        expect.objectContaining({
          valid: false,
          keywordLocation: '/properties/age/type',
          instanceLocation: '/age',
        }),
      ]),
    );
    for (const unit of basic.errors!) {
      expect(unit.absoluteKeywordLocation).toMatch(/^https:\/\/example.com\/schema#/);
      expect(unit).not.toHaveProperty('errors');
    }
  });

  it('detailed nests only failed nodes', () => {
    const result = validate(schema, invalidInstance);
    const detailed = result.toOutput('detailed');

    expect(detailed.instanceLocation).toBe('');
    expect(detailed.errors).toBeDefined();
    // The failure path is retained down to the keyword-level units.
    const locations = flattenDetailed(detailed).map((u) => u.keywordLocation);
    expect(locations).toContain('/properties/name/type');
    expect(locations).toContain('/properties/age/type');
    // Successful keyword nodes (title, required, valid root type) are gone.
    const json = JSON.stringify(detailed);
    expect(json).not.toContain('"title"');
    expect(json).not.toContain('/required');
  });

  it('detailed on a valid instance keeps the bare root only', () => {
    const detailed = validate(schema, { name: 'Ada' }).toOutput('detailed');
    expect(detailed).toEqual({
      valid: true,
      keywordLocation: '',
      absoluteKeywordLocation: 'https://example.com/schema#',
      instanceLocation: '',
    });
  });

  it('verbose keeps successful nodes and carries annotations', () => {
    const result = validate(schema, invalidInstance);
    const verbose = result.toOutput('verbose');

    // The successful `required` keyword is retained.
    const json = JSON.stringify(verbose);
    expect(json).toContain('/required');
    // The failing keyword carries its error; the tree is fully expanded.
    expect(json).toContain('expected string, got integer');

    // The title annotation on the (failing) name subschema is attached to
    // that keyword node regardless of sibling validity.
    const nameType = findByKeyword(verbose, '/properties/name/title');
    expect(nameType).toBeDefined();
    expect(nameType!.annotation).toBe('Name');
    expect(nameType!.annotationName).toBe('title');
  });

  it('basic lists annotations of valid branches', () => {
    const basic = validate(schema, { name: 'Ada' }).toOutput('basic');
    expect(basic.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          valid: true,
          keywordLocation: '/properties/name/title',
          annotationName: 'title',
          annotation: 'Name',
        }),
      ]),
    );
    expect(basic.errors).toBeUndefined();
  });
});

function flattenDetailed(unit: DetailedUnit): DetailedUnit[] {
  const out: DetailedUnit[] = [unit];
  if (unit.errors) for (const child of unit.errors) out.push(...flattenDetailed(child));
  return out;
}

function findByKeyword(
  unit: VerboseUnit,
  keywordLocation: string,
): VerboseUnit | undefined {
  if (unit.keywordLocation === keywordLocation) return unit;
  for (const list of [unit.errors, unit.annotations]) {
    if (list) {
      for (const child of list) {
        const hit = findByKeyword(child, keywordLocation);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}
