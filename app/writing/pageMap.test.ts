import { describe, expect, it } from 'vitest';
import type { Mark } from './document';
import { atomRange, caretToSpot, clickToCaret, mapRegion } from './pageMap';
import type { PageText } from './pageRegions';

const source = ['%% galley-block b1 text', 'We route each step to the cheapest model~\\cite{a}.', 'It works.'].join('\n');
const line2 = source.indexOf('We');
const pages: PageText[] = [
  {
    width: 612,
    height: 792,
    items: [
      { str: 'We route each step to the', transform: [10, 0, 0, 10, 72, 700], width: 125, height: 10 },
      { str: 'cheapest model [3]. It works.', transform: [10, 0, 0, 10, 72, 688], width: 145, height: 10 },
    ],
  },
];
const marks: Mark[] = [
  { kind: 'L', line: 2, page: 1, x: 72, y: 700, width: 240 },
  { kind: 'L', line: 3, page: 1, x: 182, y: 688, width: 240 },
];
const item = (index: number) => 100000 + index;

describe('mapRegion', () => {
  const map = mapRegion(source, marks, pages, 0, 2)!;

  it('covers the source lines of the region', () => {
    expect(source.slice(map.from, map.to)).toBe('We route each step to the cheapest model~\\cite{a}.');
  });

  it('turns a click on a glyph into a source position', () => {
    expect(clickToCaret(map, item(0), 3, 'before')).toEqual({ offset: line2 + 3 });
    expect(clickToCaret(map, item(1), 2, 'after')).toEqual({ offset: source.indexOf('cheapest') + 3 });
  });

  it('turns a click on a citation number into the citation', () => {
    expect(clickToCaret(map, item(1), 16, 'before')).toEqual({ atom: { from: source.indexOf('\\cite'), to: source.indexOf('.\nIt') } });
  });

  it('finds the glyph to draw a source position against', () => {
    expect(caretToSpot(map, source.indexOf(' model'))).toEqual({ item: item(1), offset: 7, length: 1, side: 'after' });
    expect(caretToSpot(map, line2)).toEqual({ item: item(0), offset: 0, length: 1, side: 'before' });
  });

  it('gives the glyphs of an atom', () => {
    expect(atomRange(map, source.indexOf('\\cite'))).toEqual([
      { item: item(1), offset: 15, length: 1 },
      { item: item(1), offset: 17, length: 1 },
    ]);
  });

  it('knows nothing of a click outside the region', () => {
    expect(clickToCaret(map, item(7), 0, 'before')).toBeNull();
  });
});
