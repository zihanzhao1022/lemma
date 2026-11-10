/**
 * Where a source line's text is in the PDF: the stretch from its position mark (document.ts) to the next mark in
 * reading order, as pdf.js text in reading order (pageAlign.ts pairs it with the source). A line inside a float
 * reads the float's box instead, and text regions leave floats out.
 */
import type { Mark } from './document';
import type { PdfPiece } from './pageAlign';

/** The text pdf.js read from one page: its items as in its text content (`str`, `transform`, `width`, `height`). */
export interface PageText {
  width: number;
  height: number;
  items: { str: string; transform: number[]; width: number; height: number }[];
}

export interface Region {
  /** The file the region's marks belong to (0 for main.tex). */
  file: number;
  /** Its first and last source lines. */
  from: number;
  until: number;
  float: boolean;
  /** Its text in reading order; items are numbered by page and index (see itemPage, itemIndex). */
  pieces: PdfPiece[];
}

const PER_PAGE = 100000;
export const itemPage = (item: number): number => Math.floor(item / PER_PAGE);
export const itemIndex = (item: number): number => item % PER_PAGE;
const itemId = (page: number, index: number): number => page * PER_PAGE + index;

interface Placed {
  id: number;
  str: string;
  x: number;
  y: number;
  right: number;
  height: number;
  column: number;
}

interface Line {
  column: number;
  y: number;
  items: Placed[];
}

const fileOf = (mark: Mark) => mark.file ?? 0;

/** Two columns when a text mark on the page starts in its right half with a column's width. */
function twoColumns(marks: Mark[], page: number, width: number): boolean {
  const half = width / 2;
  return marks.some((mark) => mark.page === page && mark.kind === 'L' && mark.width < half * 0.9 && mark.x > half);
}

/** A page's lines in reading order: column by column, top to bottom, each line's items left to right. */
function linesOf(text: PageText, page: number, columns: boolean): Line[] {
  const placed: Placed[] = [];
  text.items.forEach((item, index) => {
    if (!item.str) return;
    const [, , c, d, x, y] = item.transform;
    const height = item.height || Math.hypot(c, d) || 10;
    placed.push({ id: itemId(page, index), str: item.str, x, y, right: x + item.width, height, column: columns && x >= text.width / 2 ? 1 : 0 });
  });
  placed.sort((a, b) => a.column - b.column || b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const item of placed) {
    const line = lines[lines.length - 1];
    // Sub- and superscripts sit a little off their line's baseline; the next line is a whole line below.
    if (line && line.column === item.column && line.y - item.y <= 0.6 * Math.max(line.items[0].height, item.height)) line.items.push(item);
    else lines.push({ column: item.column, y: item.y, items: [item] });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

interface Box {
  page: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Float boxes: each begin mark with the end mark after it, on its page. */
function floatsOf(marks: Mark[]): { begin: Mark; end: Mark; box: Box }[] {
  const floats: { begin: Mark; end: Mark; box: Box }[] = [];
  marks.forEach((begin, index) => {
    if (begin.kind !== 'B') return;
    for (const end of marks.slice(index + 1)) {
      if (fileOf(end) !== fileOf(begin)) continue;
      if (end.kind === 'B') break;
      if (end.kind === 'E' && end.line >= begin.line) {
        floats.push({ begin, end, box: { page: begin.page, left: begin.x - 2, right: begin.x + begin.width + 2, top: begin.y + 2, bottom: end.y - 2 } });
        break;
      }
    }
  });
  return floats;
}

const inside = (box: Box, page: number, item: Placed) => box.page === page && item.x >= box.left && item.x <= box.right && item.y <= box.top && item.y >= box.bottom;

function piecesOf(lines: Line[]): PdfPiece[] {
  const pieces: PdfPiece[] = [];
  lines.forEach((line, row) => {
    if (row > 0 && line.items.length > 0) pieces.push({ item: -1, text: '\n' });
    line.items.forEach((item, index) => {
      const previous = line.items[index - 1];
      if (previous && item.x - previous.right > 0.15 * Math.min(previous.height, item.height) && !/\s$/.test(previous.str) && !/^\s/.test(item.str)) {
        pieces.push({ item: -1, text: ' ' });
      }
      pieces.push({ item: item.id, text: item.str });
    });
  });
  return pieces;
}

/**
 * The region a source line belongs to, with its PDF text: the float it is in, or the text from the nearest mark
 * at or before it. `pages` holds the text of the pages read so far (index 0 is page 1); null before the first mark.
 */
export function regionForLine(marks: Mark[], pages: (PageText | undefined)[], file: number, line: number): Region | null {
  const floats = floatsOf(marks);
  const float = floats.find(({ begin, end }) => fileOf(begin) === file && begin.line <= line && end.line >= line);
  if (float) {
    const text = pages[float.box.page - 1];
    if (!text) return null;
    const lines = linesOf(text, float.box.page, false)
      .map((row) => ({ ...row, items: row.items.filter((item) => inside(float.box, float.box.page, item)) }))
      .filter((row) => row.items.length > 0);
    return { file, from: float.begin.line, until: float.end.line, float: true, pieces: piecesOf(lines) };
  }

  const own = marks.filter((mark) => fileOf(mark) === file);
  const start = own.filter((mark) => mark.kind === 'L' && mark.line <= line).sort((a, b) => b.line - a.line)[0];
  if (!start) return null;
  const following = own.filter((mark) => mark.kind !== 'E' && mark.line > start.line).map((mark) => mark.line);
  const until = following.length > 0 ? Math.min(...following) - 1 : Number.MAX_SAFE_INTEGER;
  if (line > until) return null;

  // The next text mark in reading order, of any file, ends the region.
  const columnsOn = (page: number) => twoColumns(marks, page, pages[page - 1]?.width ?? Infinity);
  const columnOf = (mark: Mark) => (columnsOn(mark.page) && mark.x >= (pages[mark.page - 1]?.width ?? Infinity) / 2 ? 1 : 0);
  const order = (a: Mark, b: Mark) => a.page - b.page || columnOf(a) - columnOf(b) || b.y - a.y || a.x - b.x;
  const reading = marks.filter((mark) => mark.kind === 'L').sort(order);
  const next = reading[reading.indexOf(start) + 1];
  const lastPage = next ? next.page : Math.min(pages.length, start.page + 1);

  const chosen: Line[] = [];
  for (let page = start.page; page <= lastPage; page += 1) {
    const text = pages[page - 1];
    if (!text) continue;
    const boxes = floats.filter(({ box }) => box.page === page).map(({ box }) => box);
    for (const row of linesOf(text, page, columnsOn(page))) {
      const sameLine = (mark: Mark) => mark.page === page && columnOf(mark) === row.column && Math.abs(row.y - mark.y) <= 0.6 * row.items[0].height;
      const after = (mark: Mark, item: Placed) =>
        page !== mark.page ? page > mark.page : row.column !== columnOf(mark) ? row.column > columnOf(mark) : sameLine(mark) ? item.right > mark.x + 0.5 : row.y < mark.y;
      const before = (mark: Mark, item: Placed) =>
        page !== mark.page ? page < mark.page : row.column !== columnOf(mark) ? row.column < columnOf(mark) : sameLine(mark) ? item.x < mark.x - 0.5 : row.y > mark.y;
      const items = row.items.filter((item) => after(start, item) && (!next || before(next, item)) && !boxes.some((box) => inside(box, page, item)));
      if (items.length > 0) chosen.push({ ...row, items });
    }
  }
  return { file, from: start.line, until, float: false, pieces: piecesOf(chosen) };
}
