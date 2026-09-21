import type { NodeView } from './types.js';

/** Result of running one node's validation. Children stay `LazyNode`s. */
export interface VResult {
  valid: boolean;
  keyword: string;
  keywordLocation: string;
  absoluteKeywordLocation: string;
  instanceLocation: string;
  /** Present for assertion failures (`error`) and custom annotations. */
  annotation?: string;
  children: LazyNode[];
  /**
   * Schema-evaluation containers (the schema reached via a property/items/
   * branch/$ref) don't appear as output units themselves; their keyword
   * children are spliced into the parent when a tree is rendered.
   */
  transparent?: boolean;
}

/**
 * A lazily evaluated output node.
 *
 * Two layers are memoized independently:
 *  - `valid` / `raw` run the validation thunk **once** (this is where custom
 *    keyword functions execute);
 *  - `view()` materializes the formatter-facing {@link NodeView} **once**.
 *
 * Pruning a subtree in `flag`/`basic`/`detailed` means its `view()` is never
 * built, and calling a formatter twice never re-runs either layer.
 */
export class LazyNode {
  private evaluated = false;
  private cached: VResult | undefined;
  private materialized = false;
  private cachedView: NodeView | undefined;

  constructor(private readonly thunk: () => VResult) {}

  /** Force validation of this node (and the descendants its validity needs). */
  private force(): VResult {
    if (!this.evaluated) {
      this.cached = this.thunk();
      this.evaluated = true;
    }
    return this.cached as VResult;
  }

  get valid(): boolean {
    return this.force().valid;
  }

  /** Raw validation result; forces validation, never materializes views. */
  get raw(): VResult {
    return this.force();
  }

  /** Raw child nodes (used by formatters to prune before materializing). */
  childNodes(): LazyNode[] {
    return this.force().children;
  }

  /** Materialized view, built at most once and never running keyword code. */
  view(): NodeView {
    if (!this.materialized) {
      const r = this.force();
      this.cachedView = {
        keyword: r.keyword,
        keywordLocation: r.keywordLocation,
        absoluteKeywordLocation: r.absoluteKeywordLocation,
        instanceLocation: r.instanceLocation,
        valid: r.valid,
        annotation: r.annotation,
        transparent: r.transparent,
        // Child views are created on demand by the caller; each child itself
        // memoizes, so traversing twice is still a single evaluation.
        children: () => r.children.map((c) => c.view()),
      };
      this.materialized = true;
    }
    return this.cachedView as NodeView;
  }
}

export function leaf(
  keyword: string,
  keywordLocation: string,
  absoluteKeywordLocation: string,
  instanceLocation: string,
  valid: boolean,
  annotation?: string,
): LazyNode {
  return new LazyNode(() => ({
    valid,
    keyword,
    keywordLocation,
    absoluteKeywordLocation,
    instanceLocation,
    annotation,
    children: [],
  }));
}
