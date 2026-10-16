import { LogicTree } from './tree';

/** A box's size, and the room between boxes: beside each other, between levels, and between top-level trees. */
export interface Spacing {
  w: number;
  h: number;
  across: number;
  down: number;
  between: number;
}

/** The logic view's boxes. */
export const BOXES: Spacing = { w: 184, h: 70, across: 20, down: 60, between: 48 };

export interface Layout {
  /** Each shown block's box, top left corner. */
  at: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/**
 * The tree drawn from the top down: each block centred over the blocks under it, the levels one under another,
 * the top-level trees side by side in the paper's order. The blocks under a folded block are left out.
 */
export function layoutTree(tree: LogicTree, folded: ReadonlySet<string> = new Set(), spacing: Spacing = BOXES): Layout {
  const under = (id: string): string[] => (folded.has(id) ? [] : tree.nodes[id].children);
  const widths: Record<string, number> = {};
  const span = (ids: string[]): number => ids.reduce((sum, id, index) => sum + widths[id] + (index > 0 ? spacing.across : 0), 0);
  const measure = (id: string): number => {
    under(id).forEach(measure);
    widths[id] = Math.max(spacing.w, span(under(id)));
    return widths[id];
  };
  const at: Layout['at'] = {};
  let depth = 0;
  const place = (id: string, left: number, level: number) => {
    depth = Math.max(depth, level);
    const y = level * (spacing.h + spacing.down);
    const children = under(id);
    if (children.length === 0) {
      at[id] = { x: left + (widths[id] - spacing.w) / 2, y };
      return;
    }
    let x = left + (widths[id] - span(children)) / 2;
    for (const child of children) {
      place(child, x, level + 1);
      x += widths[child] + spacing.across;
    }
    at[id] = { x: (at[children[0]].x + at[children[children.length - 1]].x) / 2, y };
  };
  let width = 0;
  tree.roots.forEach((id, index) => {
    if (index > 0) width += spacing.between;
    measure(id);
    place(id, width, 0);
    width += widths[id];
  });
  return { at, width, height: tree.roots.length > 0 ? (depth + 1) * spacing.h + depth * spacing.down : 0 };
}

/** The line from a block down to one under it, as an SVG path: out of the bottom middle, into the top middle. */
export function link(from: { x: number; y: number }, to: { x: number; y: number }, spacing: Spacing = BOXES): string {
  const x1 = from.x + spacing.w / 2;
  const y1 = from.y + spacing.h;
  const x2 = to.x + spacing.w / 2;
  const y2 = to.y;
  const bend = (y2 - y1) / 2;
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}
