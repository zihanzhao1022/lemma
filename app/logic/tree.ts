import { sectionsOf } from '../../lib/sections';
import { BlockSection, ResultBlock, ResultPaper } from '../../types';

/**
 * A paper's logic: its blocks as a tree. The headings give the tree the paper has (a subsection under its
 * section, a table under the part it is in); moving a block under another one (an experiment under the method
 * it tests) gives the tree the work has. Blocks under the same block keep the paper's order.
 */
export interface LogicNode {
  id: string;
  /** The block it belongs to; null at the top. */
  parent: string | null;
  children: string[];
  depth: number;
  /** Put under its parent by a move rather than by the paper's headings. */
  moved: boolean;
}

export interface LogicTree {
  nodes: Record<string, LogicNode>;
  roots: string[];
  /** Every block, each one before the blocks under it: the order a talk goes through them. */
  order: string[];
}

type Logic = Record<string, string>;
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

/** The blocks' parents once `logic` moves some: a move to a block that is gone, or under itself, counts for nothing. */
function movedParents(blocks: ResultBlock[], base: Parents, logic: Logic | undefined): Parents {
  const parents = { ...base };
  if (!logic) return parents;
  const ids = new Set(blocks.map((block) => block.id));
  for (const block of blocks) {
    const target = logic[block.id];
    if (!target || !ids.has(target)) continue;
    let under = false;
    const seen = new Set<string>();
    for (let at: string | null = target; at && !seen.has(at); at = parents[at] ?? null) {
      if (at === block.id) {
        under = true;
        break;
      }
      seen.add(at);
    }
    if (!under) parents[block.id] = target;
  }
  return parents;
}

/** The tree of `ids` (in the paper's order) under `parents`; `base` tells which parents were moves. */
export function buildTree(ids: string[], parents: Parents, base?: Parents): LogicTree {
  const nodes: Record<string, LogicNode> = {};
  for (const id of ids) {
    const parent = parents[id] ?? null;
    nodes[id] = { id, parent, children: [], depth: 0, moved: base !== undefined && parent !== (base[id] ?? null) };
  }
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
  // A loop of parents (which moves never make) would be out of reach: its blocks go to the top instead.
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

/** The paper's logic: its blocks where its headings put them, except those `logic` moves under another block. */
export function logicTree(paper: Pick<ResultPaper, 'blocks' | 'preamble' | 'logic'>): LogicTree {
  const base = paperParents(paper);
  return buildTree(
    paper.blocks.map((block) => block.id),
    movedParents(paper.blocks, base, paper.logic),
    base,
  );
}

/** Whether block `id` can go under `target`: not under itself, nor under a block that is under it. */
export function canMove(tree: LogicTree, id: string, target: string): boolean {
  if (!tree.nodes[id] || !tree.nodes[target]) return false;
  for (let at: string | null = target; at !== null; at = tree.nodes[at].parent) {
    if (at === id) return false;
  }
  return true;
}

/**
 * `logic` with block `id` under `target`, or back where the paper's headings put it (null). Only moves that
 * differ from the headings are kept, and none of blocks that are gone.
 */
export function withMove(paper: Pick<ResultPaper, 'blocks' | 'preamble'>, logic: Logic, id: string, target: string | null): Logic {
  const next = cleanLogic(paper.blocks, logic);
  delete next[id];
  if (target !== null && target !== paperParents(paper)[id]) next[id] = target;
  return next;
}

/** `logic` without moves of blocks that are gone, or to them. */
export function cleanLogic(blocks: ResultBlock[], logic: Logic | undefined): Logic {
  const ids = new Set(blocks.map((block) => block.id));
  const kept: Logic = {};
  for (const [id, target] of Object.entries(logic ?? {})) {
    if (ids.has(id) && ids.has(target) && id !== target) kept[id] = target;
  }
  return kept;
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
  const result = buildTree([...ids, ...extra], parents);
  for (const id of ids) result.nodes[id].moved = tree.nodes[id].moved;
  return result;
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
