import { sectionsOf } from '../../lib/sections';
import { BlockSection, ResultBlock, ResultPaper } from '../../types';

/**
 * Trees of a paper's blocks. The paper's own (paperTree) follows its headings: a subsection under its section, a
 * table under the part it is in. Its logic (logicTree) is the tree its author builds by hand, block by block: an
 * experiment under the method it tests, a follow-up under the experiment before it. Blocks under the same block
 * keep the paper's order.
 */
export interface LogicNode {
  id: string;
  /** The block it is under; null at the top. */
  parent: string | null;
  children: string[];
  depth: number;
}

export interface LogicTree {
  nodes: Record<string, LogicNode>;
  roots: string[];
  /** Every block of the tree, each one before the blocks under it: the order a talk goes through them. */
  order: string[];
}

/**
 * The paper's logic as stored (ResultPaper.logic): each block placed in the tree, by ID → the block it is under,
 * or TOP. A block that others are under is in the tree too, at the top unless placed itself.
 */
export type Logic = Record<string, string>;
export const TOP = '';

type Parents = Record<string, string | null>;

/** How deep a heading opens a part: sections (and the appendix) at the top; \paragraph opens none. */
const LEVEL: Partial<Record<BlockSection['level'], number>> = { appendix: 0, section: 0, subsection: 1, subsubsection: 2 };

/** A text block's headings: from its source, or as the public view carries them. */
function headingsOf(paper: Pick<ResultPaper, 'blocks' | 'preamble'>): Record<string, BlockSection[]> {
  const fromSources = sectionsOf(paper.blocks, paper.preamble);
  const found: Record<string, BlockSection[]> = {};
  for (const block of paper.blocks) {
    if (block.kind === 'text') found[block.id] = block.output?.sections ?? fromSources[block.id] ?? [];
  }
  return found;
}

/**
 * Where the paper's headings put each block: under the block holding the heading of the part it is in (a
 * subsection under its section, text and floats under the heading above them), or at the top.
 */
export function paperParents(paper: Pick<ResultPaper, 'blocks' | 'preamble'>): Parents {
  const headings = headingsOf(paper);
  // The parts open at this point of the paper, outermost first, with the block whose heading opened each.
  const open: { level: number; id: string }[] = [];
  const close = (level: number) => {
    while (open.length > 0 && open[open.length - 1].level >= level) open.pop();
  };
  const parents: Parents = {};
  for (const block of paper.blocks) {
    const levels = (headings[block.id] ?? []).flatMap((heading) => {
      const level = LEVEL[heading.level];
      return level === undefined ? [] : [level];
    });
    if (levels.length > 0) close(levels[0]);
    parents[block.id] = open.length > 0 ? open[open.length - 1].id : null;
    for (const level of levels) {
      close(level);
      open.push({ level, id: block.id });
    }
  }
  return parents;
}

/** The tree of `ids` (in the paper's order) under `parents`. */
export function buildTree(ids: string[], parents: Parents): LogicTree {
  const nodes: Record<string, LogicNode> = {};
  for (const id of ids) nodes[id] = { id, parent: parents[id] ?? null, children: [], depth: 0 };
  const roots: string[] = [];
  for (const id of ids) {
    const parent = nodes[id].parent;
    if (parent !== null && nodes[parent]) nodes[parent].children.push(id);
    else {
      nodes[id].parent = null;
      roots.push(id);
    }
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    seen.add(id);
    nodes[id].depth = depth;
    order.push(id);
    for (const child of nodes[id].children) visit(child, depth + 1);
  };
  roots.forEach((id) => visit(id, 0));
  // A loop of parents (which placing never makes) would be out of reach: its blocks go to the top instead.
  for (const id of ids) {
    if (seen.has(id)) continue;
    const parent = nodes[id].parent;
    if (parent !== null) nodes[parent].children = nodes[parent].children.filter((child) => child !== id);
    nodes[id].parent = null;
    roots.push(id);
    visit(id, 0);
  }
  return { nodes, roots, order };
}

/** The paper's own tree, as its headings have it. */
export const paperTree = (paper: Pick<ResultPaper, 'blocks' | 'preamble'>): LogicTree =>
  buildTree(
    paper.blocks.map((block) => block.id),
    paperParents(paper),
  );

/** The blocks in the paper's logic: those placed in it, and those placed blocks are under. */
export function placedIn(blocks: ResultBlock[], logic: Logic | undefined): Set<string> {
  const ids = new Set(blocks.map((block) => block.id));
  const found = new Set<string>();
  for (const [id, parent] of Object.entries(logic ?? {})) {
    if (!ids.has(id)) continue;
    found.add(id);
    if (parent !== TOP && ids.has(parent)) found.add(parent);
  }
  return found;
}

/** The paper's logic as a tree: only the blocks placed in it; one under a block that is gone is at the top. */
export function logicTree(paper: Pick<ResultPaper, 'blocks' | 'logic'>): LogicTree {
  const logic = paper.logic ?? {};
  const inTree = placedIn(paper.blocks, logic);
  const ids = paper.blocks.map((block) => block.id).filter((id) => inTree.has(id));
  const parents: Parents = {};
  for (const id of ids) {
    const parent = logic[id];
    parents[id] = parent !== undefined && parent !== id && inTree.has(parent) ? parent : null;
  }
  return buildTree(ids, parents);
}

/** Whether block `id` can go under `target`: not under itself, nor under a block that is under it. */
export function canMove(tree: LogicTree, id: string, target: string): boolean {
  if (!tree.nodes[target] || id === target) return false;
  for (let at: string | null = target; at !== null; at = tree.nodes[at].parent) {
    if (at === id) return false;
  }
  return true;
}

/** `logic` without blocks that are gone; a block under one that is gone goes to the top. */
export function cleanLogic(blocks: ResultBlock[], logic: Logic | undefined): Logic {
  const ids = new Set(blocks.map((block) => block.id));
  const kept: Logic = {};
  for (const [id, parent] of Object.entries(logic ?? {})) {
    if (ids.has(id)) kept[id] = parent !== TOP && parent !== id && ids.has(parent) ? parent : TOP;
  }
  return kept;
}

/** `logic` with block `id` under `target`, or at the top (null); placed in the tree if it was not. */
export function withPlacement(blocks: ResultBlock[], logic: Logic, id: string, target: string | null): Logic {
  return { ...cleanLogic(blocks, logic), [id]: target ?? TOP };
}

/** `logic` without block `id`: the blocks that were under it go up to where it was. */
export function withoutBlock(blocks: ResultBlock[], logic: Logic, id: string): Logic {
  const next = cleanLogic(blocks, logic);
  const up = next[id] ?? TOP;
  delete next[id];
  for (const [child, parent] of Object.entries(next)) if (parent === id) next[child] = up;
  return next;
}

/**
 * The tree with only the blocks `keep` accepts (say, those a reader sees), each under the nearest kept block
 * above it; `extra` go at the end, at the top (the bibliography).
 */
export function pruned(tree: LogicTree, keep: (id: string) => boolean, extra: string[] = []): LogicTree {
  const ids = tree.order.filter(keep);
  const parents: Parents = {};
  for (const id of ids) {
    let at = tree.nodes[id].parent;
    while (at !== null && !keep(at)) at = tree.nodes[at].parent;
    parents[id] = at;
  }
  return buildTree([...ids, ...extra], parents);
}

/** Where to go from a block: its parent, its first child, the blocks beside it on its level, and the talk's order. */
export interface Moves {
  up: string | null;
  down: string | null;
  /** The previous and next block on the same level, across branches, as the tree is drawn. */
  left: string | null;
  right: string | null;
  previous: string | null;
  next: string | null;
}

export function movesFrom(tree: LogicTree, id: string): Moves {
  const node = tree.nodes[id];
  const row = tree.order.filter((other) => tree.nodes[other].depth === node.depth);
  const across = row.indexOf(id);
  const along = tree.order.indexOf(id);
  return {
    up: node.parent,
    down: node.children[0] ?? null,
    left: row[across - 1] ?? null,
    right: row[across + 1] ?? null,
    previous: tree.order[along - 1] ?? null,
    next: tree.order[along + 1] ?? null,
  };
}

/** The blocks above `id`, outermost first. */
export function ancestorsOf(tree: LogicTree, id: string): string[] {
  const path: string[] = [];
  for (let at = tree.nodes[id]?.parent ?? null; at !== null; at = tree.nodes[at].parent) path.unshift(at);
  return path;
}

/** `id` and every block under it. */
export function subtreeOf(tree: LogicTree, id: string): Set<string> {
  const found = new Set<string>();
  const visit = (at: string) => {
    found.add(at);
    tree.nodes[at]?.children.forEach(visit);
  };
  if (tree.nodes[id]) visit(id);
  return found;
}

/**
 * The block a new branch of `id` follows in the paper: the end of the part of the paper (by its headings) that
 * holds the last block already under `id`, or `id` itself. Next to its siblings, then, and never inside the
 * section of another block.
 */
export function branchEnd(paper: Pick<ResultPaper, 'blocks' | 'preamble'>, tree: LogicTree, id: string): string {
  const children = tree.nodes[id]?.children ?? [];
  const last = children.length > 0 ? children[children.length - 1] : id;
  const part = subtreeOf(paperTree(paper), last);
  return [...paper.blocks].reverse().find((block) => part.has(block.id))?.id ?? last;
}

/** A text block's first heading as the page numbers it ("3.1 Method"), or without the number. */
export function headingTitle(sections: BlockSection[] | undefined, numbered = true): string | undefined {
  const heading = sections?.find((section) => section.level !== 'appendix' && section.level !== 'paragraph' && section.title) ?? sections?.find((section) => section.title);
  if (!heading) return undefined;
  return heading.number && numbered ? `${heading.number} ${heading.title}` : heading.title;
}

/** Each text block's first heading, numbered as the page shows it unless `numbered` is false. */
export function headingTitles(paper: Pick<ResultPaper, 'blocks' | 'preamble'>, numbered = true): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const [id, sections] of Object.entries(headingsOf(paper))) {
    const title = headingTitle(sections, numbered);
    if (title) titles[id] = title;
  }
  return titles;
}
