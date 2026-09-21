# JSON Schema output formats (core)

Lazy JSON-Schema-style validation with the four standard output formats.

Run `npm install`, then `npm test` and `npm run build`.

## Usage

```ts
import { validate, format } from './src/index.js';

const root = validate(schema, instance); // nothing runs yet

root.valid;                              // forces validation, memoized

format(root, 'flag');      // { valid }            — cheapest, no tree walk
format(root, 'basic');     // flat list of failing assertion units
format(root, 'detailed');  // tree pruned to failing paths
format(root, 'verbose');   // full tree incl. success nodes & annotations
```

`validate` returns a lazy result tree. Each node records its **keyword
location**, **absolute keyword location**, **instance location**, `valid`
flag, and any annotation. Nodes evaluate on first access and are memoized, so
custom keyword functions run exactly once — repeated formatting, or switching
between formats, never re-executes validation.

### Retention rules for combinator success subtrees

- `allOf` failure keeps only failing branches.
- `anyOf` success keeps only passing branches; failure keeps all.
- `oneOf` keeps all branches for both no-match and multi-match diagnosis.
- `flag`/`basic`/`detailed` drop successful subtrees; `verbose` retains them.

Features covered: nested `$ref`, cyclic schemas (detected by schema node plus
instance identity), custom annotation keywords, escaped JSON Pointer tokens,
and deterministic verbose expansion order.
