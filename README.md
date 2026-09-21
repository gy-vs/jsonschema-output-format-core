# JSON Schema core

TypeScript schema validator producing the JSON Schema 2020-12 output formats
(`flag`, `basic`, `detailed`, `verbose`) from lazy, memoised result nodes.

## Usage

```ts
import { validate } from './src/index.js';

const result = validate(
  { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  { name: 42 },
);

result.valid;                       // false — forces evaluation on demand
result.toOutput('flag');            // { valid: false } — no error tree built
result.toOutput('basic');           // flat errors[] / annotations[]
result.toOutput('detailed');        // nested failed nodes only
result.toOutput('verbose');         // full tree of every evaluated node
```

Keyword logic runs at most once per node; output formatting only reads cached
nodes, so converting between formats (repeatedly) never re-executes keyword or
custom-keyword code.

## Features

- Four output formats, all agreeing on `valid`; the tree formats carry
  `keywordLocation`, `absoluteKeywordLocation` and `instanceLocation`.
- Keywords: `type`, `enum`, `const`, `required`, `properties`, `items`
  (schema and tuple), `allOf` / `anyOf` / `oneOf`, `not`, boolean schemas,
  and annotation keywords (`title`, `description`, `default`, `examples`,
  `deprecated`, `readOnly`, `writeOnly`, `$comment`).
- `$ref` with nested/chained references, external documents (`schemas`
  option keyed by IRI), and RFC 6901 JSON Pointer escaping (`~0`, `~1`).
- Recursive schemas and cyclic instance data terminate safely.
- Custom keywords via the `keywords` option; they may return a boolean/result
  object or attach annotations through `ctx.annotate(value, name?)`.

Run `npm install`, then `npm test` and `npm run build`.
