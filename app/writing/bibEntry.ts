/**
 * Where a bibliography entry is on its page, from the place a citation's link leads to: the line under that place,
 * and the lines after it that are indented (an entry's first line starts at the column's edge, the rest hang).
 */

/** A run of text on the page: where its baseline starts and ends, in PDF points from the page's bottom left. */
export interface PlacedRun {
  x: number;
  y: number;
  right: number;
  size: number;
}

export interface EntryBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Line {
  y: number;
  left: number;
  right: number;
  size: number;
}

/** The line a run starts, as far as the runs beside it on its baseline go: a gap wider than a word space is a column's. */
function lineFrom(runs: PlacedRun[], first: PlacedRun): Line {
  const beside = runs.filter((run) => Math.abs(run.y - first.y) <= 0.3 * first.size && run.x >= first.x - 0.5).sort((a, b) => a.x - b.x);
  let right = first.right;
  for (const run of beside) {
    if (run.x - right > 1.2 * first.size) break;
    right = Math.max(right, run.right);
  }
  return { y: first.y, left: first.x, right, size: first.size };
}

/** The leftmost run of the line at baseline `y` that starts at or right of `left` and before `limit`. */
const startOf = (runs: PlacedRun[], y: number, size: number, left: number, limit: number): PlacedRun | null =>
  runs.filter((run) => Math.abs(run.y - y) <= 0.3 * size && run.x >= left - 1 && run.x < limit).sort((a, b) => a.x - b.x)[0] ?? null;

/** The entry whose link target is at (`x`, `top`): the box around its lines, or null when no line is there. */
export function entryBox(runs: PlacedRun[], x: number, top: number): EntryBox | null {
  // Its first line: the highest baseline just under the target, starting at it or a label's width right of it (not
  // in the other column, nor a line number in the margin).
  const below = runs.filter((run) => run.x >= x - 1 && run.x <= x + 2.5 * run.size && run.y <= top + 1 && run.y >= top - 3 * run.size).sort((a, b) => b.y - a.y || a.x - b.x);
  if (below.length === 0) return null;
  const first = startOf(runs, below[0].y, below[0].size, x, Infinity) ?? below[0];
  const lines = [lineFrom(runs, first)];
  const edge = first.x;
  const limit = lines[0].right + 2;
  // The lines after it while they hang: indented past the first line's start, within its column.
  for (;;) {
    const last = lines[lines.length - 1];
    const next = runs.filter((run) => run.y < last.y - 0.3 * last.size && run.y >= last.y - 2 * last.size && run.x >= edge - 1 && run.x < limit).sort((a, b) => b.y - a.y || a.x - b.x)[0];
    if (!next) break;
    const start = startOf(runs, next.y, next.size, edge, limit) ?? next;
    if (start.x <= edge + 1) break;
    lines.push(lineFrom(runs, start));
  }
  const size = Math.max(...lines.map((line) => line.size));
  return {
    left: edge - 2,
    right: Math.max(...lines.map((line) => line.right)) + 2,
    top: lines[0].y + 0.85 * size,
    bottom: lines[lines.length - 1].y - 0.3 * size,
  };
}

/**
 * The glyphs a page's citation links cover (hyperref's links to `cite.<key>`), by run: what the page colours as a
 * citation. A glyph is covered when its middle is inside a link's box.
 */
export function citedGlyphs(runs: { x: number; y: number; size: number; glyphs: { x: number; width: number }[] }[], annotations: unknown[]): Map<number, Set<number>> {
  const boxes: number[][] = [];
  for (const value of annotations) {
    const annotation = value as { subtype?: unknown; dest?: unknown; rect?: unknown };
    if (annotation?.subtype !== 'Link' || typeof annotation.dest !== 'string' || !annotation.dest.startsWith('cite.')) continue;
    const rect = annotation.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) continue;
    boxes.push([Math.min(rect[0], rect[2]) - 0.5, Math.min(rect[1], rect[3]) - 0.5, Math.max(rect[0], rect[2]) + 0.5, Math.max(rect[1], rect[3]) + 0.5]);
  }
  const cited = new Map<number, Set<number>>();
  if (boxes.length === 0) return cited;
  runs.forEach((run, index) => {
    const y = run.y + 0.3 * run.size;
    run.glyphs.forEach((glyph, at) => {
      const x = run.x + glyph.x + glyph.width / 2;
      if (!boxes.some(([left, bottom, right, top]) => x >= left && x <= right && y >= bottom && y <= top)) return;
      if (!cited.has(index)) cited.set(index, new Set());
      cited.get(index)!.add(at);
    });
  });
  return cited;
}
