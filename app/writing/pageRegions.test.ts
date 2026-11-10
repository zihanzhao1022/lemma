import { describe, expect, it } from 'vitest';
import type { Mark } from './document';
import { PageText, itemIndex, itemPage, regionForLine } from './pageRegions';

const text = (str: string, x: number, y: number, height = 10): PageText['items'][number] => ({ str, transform: [height, 0, 0, height, x, y], width: str.length * 5, height });
const mark = (kind: Mark['kind'], line: number, page: number, x: number, y: number, width = 240): Mark => ({ kind, line, page, x, y, width });

// A two-column page: line 1 of main.tex fills the left column's first two lines, line 2 starts the right column,
// and a table (lines 5 to 8) sits lower in the left column.
const pages: PageText[] = [
  {
    width: 612,
    height: 792,
    items: [
      text('Alpha beta', 72, 700),
      text('gamma', 72, 688),
      text('delta', 110, 688),
      text('Epsilon zeta', 320, 700),
      text('Ours', 80, 640),
      text('78.4', 140, 640),
      text('Caption here', 80, 620),
    ],
  },
];
const marks: Mark[] = [mark('L', 1, 1, 72, 700), mark('L', 2, 1, 320, 700), mark('B', 5, 1, 72, 650), mark('E', 8, 1, 72, 610)];

const shown = (pieces: { item: number; text: string }[]) => pieces.map((piece) => (piece.item < 0 ? (piece.text === '\n' ? '⏎' : '␣') : piece.text)).join('|');

describe('regionForLine', () => {
  it('reads a text line from its mark to the next mark, down its column only', () => {
    const region = regionForLine(marks, pages, 0, 1)!;
    expect(region).toMatchObject({ from: 1, until: 1, float: false });
    expect(shown(region.pieces)).toBe('Alpha beta|⏎|gamma|␣|delta');
  });

  it('goes on from a line to the end of its region', () => {
    expect(regionForLine(marks, pages, 0, 3)).toMatchObject({ from: 2, until: 4 });
  });

  it('reads a float from its box only', () => {
    const region = regionForLine(marks, pages, 0, 6)!;
    expect(region).toMatchObject({ from: 5, until: 8, float: true });
    expect(shown(region.pieces)).toBe('Ours|␣|78.4|⏎|Caption here');
  });

  it('numbers items by page and index', () => {
    const region = regionForLine(marks, pages, 0, 2)!;
    const piece = region.pieces[0];
    expect([itemPage(piece.item), itemIndex(piece.item)]).toEqual([1, 3]);
  });

  it('leaves out text that floats inside the region', () => {
    const spanning: Mark[] = [mark('L', 1, 1, 72, 700), mark('B', 5, 1, 72, 650), mark('E', 8, 1, 72, 610)];
    const region = regionForLine(spanning, pages, 0, 1)!;
    expect(region.pieces.some((piece) => piece.text === 'Ours')).toBe(false);
    expect(region.pieces.some((piece) => piece.text === 'Epsilon zeta')).toBe(true);
  });

  it('has nothing before the first mark', () => {
    expect(regionForLine([mark('L', 4, 1, 72, 700)], pages, 0, 2)).toBeNull();
  });
});
