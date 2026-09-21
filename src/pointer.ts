// RFC 6901 JSON Pointer helpers.

/** Escape one reference token: `~` -> `~0`, `/` -> `~1`. */
export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Unescape one reference token: `~1` -> `/`, `~0` -> `~`. */
export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append a token to a JSON Pointer (`'' + '/x'` -> `'/x'`). */
export function pointerJoin(pointer: string, token: string): string {
  return pointer + '/' + escapeToken(token);
}

/** Resolve a `#/...` (or empty) fragment pointer against a document. */
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '#') return root;
  let fragment = pointer;
  if (fragment.startsWith('#')) fragment = fragment.slice(1);
  if (fragment.startsWith('/')) fragment = fragment.slice(1);
  if (fragment === '') return root;
  let current: unknown = root;
  for (const rawToken of fragment.split('/')) {
    const token = unescapeToken(rawToken);
    if (current === null || typeof current !== 'object') {
      throw new Error(`cannot resolve pointer ${JSON.stringify(pointer)}`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/** Strip the fragment off a URI, returning `[documentUri, fragment]`. */
export function splitUri(uri: string): [string, string] {
  const hash = uri.indexOf('#');
  if (hash === -1) return [uri, ''];
  return [uri.slice(0, hash), uri.slice(hash + 1)];
}
