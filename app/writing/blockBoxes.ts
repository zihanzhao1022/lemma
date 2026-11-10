/**
 * Where each block of a paper is on its article's pages: boxes in PDF points, one for each column a block's text
 * runs through, and a float's own box. A text line belongs to the block whose first mark comes last before it in
 * reading order; the heading that opens a block sits above its first mark, so it is found by its title; the
 * bibliography follows the "R" mark (document.ts). Lines before the first block (the title) belong to none.
 */
import type { Mark } from './document';
import type { PageText } from './pageRegions';

export interface BlockBox {
  page: number;
  /** PDF points from the page's bottom left. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A block's lines in the article's main.tex, and the title of the heading it opens with, if any. */
export interface BlockLines {
  id: string;
  from: number;
  to: number;
  heading?: string;
}

/** The id of the bibliography's box. */
export const REFERENCES = 'references';

interface Line {
  page: number;
  column: number;
  y: number;
  height: number;
  left: number;
  right: number;
  text: string;
}

const fileOf = (mark: Mark) => mark.file ?? 0;
const letters = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Whether a line is a heading with this title: the title, maybe after its number ("2", "II.", "A"). */
function isHeading(line: Line, title: string): boolean {
  const want = letters(title);
  const have = letters(line.text);
  if (!want || !have.endsWith(want)) return false;
  const number = have.slice(0, have.length - want.length);
  return number.length <= 6 && /^[0-9a-z]*$/.test(number);
}

function floatsOf(marks: Mark[]): { begin: Mark; end: Mark }[] {
  const floats: { begin: Mark; end: Mark }[] = [];
  marks.forEach((begin, index) => {
    if (begin.kind !== 'B') return;
    const end = marks.slice(index + 1).find((mark) => fileOf(mark) === fileOf(begin) && (mark.kind === 'E' || mark.kind === 'B'));
    if (end?.kind === 'E') floats.push({ begin, end });
  });
  return floats;
}

export function blockBoxes(marks: Mark[], blocks: BlockLines[], pages: (PageText | undefined)[]): Record<string, BlockBox[]> {
  const floats = floatsOf(marks);
  const inFloat = (page: number, x: number, y: number) =>
    floats.some(({ begin, end }) => begin.page === page && x >= begin.x - 2 && x <= begin.x + begin.width + 2 && y <= begin.y + 2 && y >= end.y - 2);
  const half = (page: number) => (pages[page - 1]?.width ?? Infinity) / 2;
  const twoColumns = (page: number) => marks.some((mark) => mark.page === page && mark.kind === 'L' && mark.width < half(page) * 0.9 && mark.x > half(page));
  const columnOf = (page: number, x: number) => (twoColumns(page) && x >= half(page) ? 1 : 0);

  // A page number above or below everything the marks place: the page's, not a block's.
  const folio = (page: number, y: number, str: string) => {
    if (!/^[\divxlcdm\s–-]{1,8}$/i.test(str.trim())) return false;
    const placed = marks.filter((mark) => mark.page === page).map((mark) => mark.y);
    return placed.length > 0 && (y < Math.min(...placed) - 12 || y > Math.max(...placed) + 24);
  };

  // The text lines of every page outside floats, in reading order.
  const lines: Line[] = [];
  pages.forEach((text, index) => {
    if (!text) return;
    const page = index + 1;
    const placed = text.items
      .filter((item) => item.str.trim())
      .map((item) => ({ x: item.transform[4], y: item.transform[5], right: item.transform[4] + item.width, height: item.height || 10, str: item.str }))
      .filter((item) => !inFloat(page, item.x, item.y) && !folio(page, item.y, item.str))
      .map((item) => ({ ...item, column: columnOf(page, item.x) }))
      .sort((a, b) => a.column - b.column || b.y - a.y || a.x - b.x);
    const pageLines: Line[] = [];
    for (const item of placed) {
      const line = pageLines[pageLines.length - 1];
      if (line && line.column === item.column && line.y - item.y <= 0.6 * Math.max(line.height, item.height)) {
        line.left = Math.min(line.left, item.x);
        line.right = Math.max(line.right, item.right);
        line.text += ` ${item.str}`;
      } else pageLines.push({ page, column: item.column, y: item.y, height: item.height, left: item.x, right: item.right, text: item.str });
    }
    lines.push(...pageLines);
  });

  // Where each block's text starts: its first text mark in main.tex, in reading order.
  const position = (page: number, column: number, y: number) => page * 1e7 + column * 1e6 + (1e5 - y);
  const starts: { id: string; at: number }[] = [];
  for (const block of blocks) {
    const first = marks.filter((mark) => mark.kind === 'L' && fileOf(mark) === 0 && mark.line >= block.from && mark.line <= block.to).sort((a, b) => a.line - b.line)[0];
    if (first) starts.push({ id: block.id, at: position(first.page, columnOf(first.page, first.x), first.y + 0.5) });
  }
  const bibliography = marks.find((mark) => mark.kind === 'R' && fileOf(mark) === 0);
  if (bibliography) starts.push({ id: REFERENCES, at: position(bibliography.page, columnOf(bibliography.page, bibliography.x), bibliography.y) });
  starts.sort((a, b) => a.at - b.at);

  const at = (line: Line) => position(line.page, line.column, line.y);
  const owner: (string | null)[] = lines.map((line) => {
    let found: string | null = null;
    for (const start of starts) if (start.at <= at(line)) found = start.id;
    return found;
  });

  // Headings: the line with a block's title right before its first mark, or, for a block that is only a
  // heading, anywhere between the blocks around it.
  blocks.forEach((block, index) => {
    if (!block.heading) return;
    const start = starts.find((item) => item.id === block.id);
    if (start) {
      const before = lines.map((line, row) => ({ line, row })).filter(({ line }) => at(line) < start.at).slice(-3);
      const heading = before.reverse().find(({ line }) => isHeading(line, block.heading!));
      if (heading) for (let row = heading.row; row < lines.length && at(lines[row]) < start.at; row += 1) owner[row] = block.id;
      return;
    }
    const previous = blocks.slice(0, index).reverse().map((item) => starts.find((candidate) => candidate.id === item.id)).find(Boolean);
    const next = starts.find((candidate) => candidate.at > (previous?.at ?? -Infinity) && blocks.findIndex((item) => item.id === candidate.id) > index);
    const row = lines.findIndex((line) => at(line) > (previous?.at ?? -Infinity) && (!next || at(line) < next.at) && isHeading(line, block.heading!));
    if (row >= 0) owner[row] = block.id;
  });

  // Each column's text spans the same width in every block's box.
  const bounds = new Map<string, { left: number; right: number }>();
  lines.forEach((line, row) => {
    if (!owner[row]) return;
    const key = `${line.page}:${line.column}`;
    const current = bounds.get(key);
    bounds.set(key, current ? { left: Math.min(current.left, line.left), right: Math.max(current.right, line.right) } : { left: line.left, right: line.right });
  });

  const boxes: Record<string, BlockBox[]> = {};
  lines.forEach((line, row) => {
    const id = owner[row];
    if (!id) return;
    const list = (boxes[id] ??= []);
    const last = list[list.length - 1] as (BlockBox & { column?: number; run?: number }) | undefined;
    const top = line.y + line.height;
    const bottom = line.y - 0.4 * line.height;
    const previousRow = row - 1;
    const continues = last && last.page === line.page && last.column === line.column && last.run === previousRow;
    if (continues) {
      last.bottom = Math.min(last.bottom, bottom);
      last.run = row;
    } else {
      const { left, right } = bounds.get(`${line.page}:${line.column}`)!;
      list.push({ page: line.page, left, right, top, bottom, column: line.column, run: row } as BlockBox);
    }
  });
  for (const list of Object.values(boxes)) for (const box of list as (BlockBox & { column?: number; run?: number })[]) {
    delete box.column;
    delete box.run;
  }

  // Floats: each in the box its marks give, in the block whose lines it sits in.
  for (const { begin, end } of floats) {
    if (fileOf(begin) !== 0) continue;
    const block = blocks.find((item) => begin.line >= item.from && begin.line <= item.to);
    if (block) (boxes[block.id] ??= []).push({ page: begin.page, left: begin.x, right: begin.x + begin.width, top: begin.y, bottom: end.y - 4 });
  }
  return boxes;
}
