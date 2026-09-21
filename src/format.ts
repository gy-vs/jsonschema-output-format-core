import type { LazyNode } from './node.js';
import type { OutputFormat } from './types.js';

/** A single output unit as it appears in basic/detailed/verbose results. */
export interface OutputUnit {
  keywordLocation: string;
  absoluteKeywordLocation: string;
  instanceLocation: string;
  valid: boolean;
  annotation?: string;
}

export interface FlagOutput {
  valid: boolean;
}

export interface BasicOutput {
  valid: boolean;
  /** Flat, deterministically ordered list of failing assertion units. */
  errors: BasicUnit[];
}

export interface BasicUnit extends OutputUnit {}

export interface DetailedOutput extends OutputUnit {
  /** Only nodes on a failing path; absent on leaf errors. */
  errors?: DetailedOutput[];
}

export interface VerboseOutput extends OutputUnit {
  /** Every node, valid or not, annotations included; empty on leaves. */
  annotations?: VerboseOutput[];
}

/**
 * Expand one node's visible children: schema-evaluation containers reached
 * via `properties`/`items`/branch/`$ref` are transparent, so their keyword
 * children are spliced into the parent instead of introducing an empty unit.
 *
 * Reads only memoized validation results — it never invokes keyword code.
 */
function visibleChildren(node: LazyNode): LazyNode[] {
  // Splice transparent containers upward to a fixpoint (a transparent
  // branch can itself be reached through a transparent $ref).
  let frontier = node.childNodes();
  for (;;) {
    const next: LazyNode[] = [];
    let expanded = false;
    for (const child of frontier) {
      if (child.raw.transparent) {
        expanded = true;
        next.push(...child.childNodes());
      } else {
        next.push(child);
      }
    }
    frontier = next;
    if (!expanded) return frontier;
  }
}

function toUnit(node: LazyNode): OutputUnit {
  const v = node.view();
  const unit: OutputUnit = {
    keywordLocation: v.keywordLocation,
    absoluteKeywordLocation: v.absoluteKeywordLocation,
    instanceLocation: v.instanceLocation,
    valid: v.valid,
  };
  if (v.annotation !== undefined) unit.annotation = v.annotation;
  return unit;
}

/** flag: validity only; the tree is never walked, so nothing else evaluates. */
export function formatFlag(root: LazyNode): FlagOutput {
  return { valid: root.valid };
}

/** basic: flat DFS list of failing assertion units. */
export function formatBasic(root: LazyNode): BasicOutput {
  const errors: BasicUnit[] = [];
  const visit = (node: LazyNode) => {
    if (node.valid) return;
    // A failing node with failing children delegates to them; a failing node
    // whose children all pass (e.g. oneOf with two matching branches) is the
    // error unit itself.
    const failingKids = visibleChildren(node).filter((c) => !c.valid);
    if (failingKids.length === 0) {
      errors.push(toUnit(node));
    } else {
      for (const kid of failingKids) visit(kid);
    }
  };
  visit(root);
  return { valid: root.valid, errors };
}

/** detailed: tree pruned to failing paths; successful subtrees dropped. */
export function formatDetailed(node: LazyNode): DetailedOutput {
  const unit = toUnit(node);
  const failing = visibleChildren(node).filter((c) => !c.valid);
  if (failing.length > 0) {
    return { ...unit, errors: failing.map(formatDetailed) };
  }
  return unit;
}

/** verbose: the complete tree, success nodes and annotations retained. */
export function formatVerbose(node: LazyNode): VerboseOutput {
  const unit = toUnit(node);
  const kids = visibleChildren(node);
  if (kids.length > 0) return { ...unit, annotations: kids.map(formatVerbose) };
  return unit;
}

/**
 * Render a lazy validation result in one of the four JSON Schema output
 * formats. Formatting is a pure read of the already-built lazy tree: custom
 * keyword functions do **not** run again, regardless of how often this is
 * called or with which formats.
 */
export function format(
  root: LazyNode,
  output: OutputFormat,
): FlagOutput | BasicOutput | DetailedOutput | VerboseOutput {
  switch (output) {
    case 'flag': return formatFlag(root);
    case 'basic': return formatBasic(root);
    case 'detailed': return formatDetailed(root);
    case 'verbose': return formatVerbose(root);
  }
}
