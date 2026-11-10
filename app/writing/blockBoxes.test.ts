import { describe, expect, it } from 'vitest';
import type { Mark } from './document';
import { blockBoxes } from './blockBoxes';
import type { PageText } from './pageRegions';

const item = (str: string, x: number, y: number, width = str.length * 5): PageText['items'][number] => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10 });
const mark = (kind: Mark['kind'], line: number, page: number, x: number, y: number, width = 400): Mark => ({ kind, line, page, x, y, width });

// One column: a title, block a (heading and two lines), block b (a figure), block c (a heading only), block d.
const page: PageText = {
  width: 612,
  height: 792,
  items: [
    item('A Paper Title', 200, 740),
    item('1 Introduction', 100, 700),
    item('First line of the intro text here.', 100, 680, 400),
    item('Second line of the intro.', 100, 668, 300),
    item('Fig. 1. A picture.', 150, 560),
    item('2 Method', 100, 520),
    item('3 Results', 100, 490),
    item('We report the results now.', 100, 470, 350),
    item('References', 100, 430),
    item('[1] A. Author, A book.', 100, 410, 250),
  ],
};
const blocks = [
  { id: 'a', from: 1, to: 4, heading: 'Introduction' },
  { id: 'b', from: 6, to: 11 },
  { id: 'c', from: 13, to: 14, heading: 'Method' },
  { id: 'd', from: 16, to: 18, heading: 'Results' },
];
const marks: Mark[] = [mark('L', 3, 1, 100, 680), mark('B', 7, 1, 100, 600), mark('E', 11, 1, 100, 558), mark('L', 18, 1, 100, 470), mark('R', 20, 1, 100, 450)];

describe('blockBoxes', () => {
  const boxes = blockBoxes(marks, blocks, [page]);

  it('boxes a text block from its heading to its last line', () => {
    expect(boxes.a).toEqual([{ page: 1, left: 100, right: 500, top: 700 + 10, bottom: 668 - 4 }]);
  });

  it('boxes a float by its own box', () => {
    expect(boxes.b).toEqual([{ page: 1, left: 100, right: 500, top: 600, bottom: 558 - 4 }]);
  });

  it('finds a block that is only a heading by its title', () => {
    expect(boxes.c).toEqual([{ page: 1, left: 100, right: 500, top: 520 + 10, bottom: 520 - 4 }]);
  });

  it('gives the heading before a block to that block, not to the one before', () => {
    expect(boxes.d).toEqual([{ page: 1, left: 100, right: 500, top: 490 + 10, bottom: 470 - 4 }]);
  });

  it('boxes the bibliography after the blocks', () => {
    expect(boxes.references).toEqual([{ page: 1, left: 100, right: 500, top: 430 + 10, bottom: 410 - 4 }]);
  });

  it('leaves a page number in the footer out of the last block', () => {
    const footer: PageText = { ...page, items: [...page.items.filter((one) => !one.str.startsWith('References') && !one.str.startsWith('[1]')), item('7', 300, 60, 5)] };
    const found = blockBoxes(marks.filter((one) => one.kind !== 'R'), blocks, [footer]);
    expect(found.d).toEqual([{ page: 1, left: 100, right: 500, top: 490 + 10, bottom: 470 - 4 }]);
  });

  it('leaves the title above the first block out', () => {
    expect(Object.values(boxes).flat().some((box) => box.top >= 740)).toBe(false);
  });
});
