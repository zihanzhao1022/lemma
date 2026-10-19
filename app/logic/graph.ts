import { ResultPaper } from '../../types';
import { LogicTree, headingTitles } from './tree';

/**
 * Headings that name a paper's introduction, in the languages people write papers in here: Introduction, and
 * 引言, 绪论, 緒論, 序论, 序論, はじめに, 導入, 研究背景 (escaped, as data rather than words of the interface).
 */
const INTRODUCTION = /^(introduction|intro|\u5f15\u8a00|\u7eea\u8bba|\u7dd2\u8ad6|\u5e8f\u8bba|\u5e8f\u8ad6|\u306f\u3058\u3081\u306b|\u5c0e\u5165|\u7814\u7a76\u80cc\u666f)$/i;

/**
 * Where the paper's logic starts: its introduction (the text block headed Introduction, 引言, はじめに…), else
 * the first block with a section heading, else the first block; null for a paper without blocks.
 */
export function startOf(paper: Pick<ResultPaper, 'blocks' | 'preamble'>): string | null {
  const titles = headingTitles(paper, false);
  const texts = paper.blocks.filter((block) => block.kind === 'text');
  return (
    texts.find((block) => INTRODUCTION.test((titles[block.id] ?? '').trim()))?.id ??
    texts.find((block) => titles[block.id])?.id ??
    paper.blocks[0]?.id ??
    null
  );
}

export interface GraphLink {
  /** The block above. */
  source: string;
  /** The block under it. */
  target: string;
}

/** The graph to draw: the blocks of the logic, the start among them even before anything hangs under it. */
export function graphOf(tree: LogicTree, start: string | null): { ids: string[]; links: GraphLink[] } {
  const ids = start && !tree.nodes[start] ? [start, ...tree.order] : [...tree.order];
  const links = tree.order.flatMap((id) => {
    const parent = tree.nodes[id].parent;
    return parent ? [{ source: parent, target: id }] : [];
  });
  return { ids, links };
}

export interface Placed {
  id: string;
  x: number;
  y: number;
  r: number;
}

/** The node at a point of the graph, if the point is on one or close to it; the nearest when several are. */
export function nodeAt(nodes: Placed[], x: number, y: number, skip: ReadonlySet<string> = new Set(), slack = 6): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const node of nodes) {
    if (skip.has(node.id)) continue;
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance <= node.r + slack && (!best || distance < best.distance)) best = { id: node.id, distance };
  }
  return best?.id ?? null;
}

/** A node's radius: the start larger, a block with more under it larger, as Obsidian sizes notes by links. */
export const radiusOf = (children: number, start: boolean): number => (start ? 15 : 7 + Math.min(7, 2.2 * Math.sqrt(children)));

/** The view that shows every node, with room for their labels; no closer than life. */
export function fitAll(nodes: Placed[], width: number, height: number, pad = 60): { x: number; y: number; k: number } {
  if (nodes.length === 0) return { x: width / 2, y: height / 2, k: 1 };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const left = Math.min(...xs) - 60;
  const right = Math.max(...xs) + 60;
  const top = Math.min(...ys) - 30;
  const bottom = Math.max(...ys) + 40;
  const k = Math.max(0.2, Math.min(1, (width - 2 * pad) / (right - left), (height - 2 * pad) / (bottom - top)));
  return { k, x: width / 2 - ((left + right) / 2) * k, y: height / 2 - ((top + bottom) / 2) * k };
}
