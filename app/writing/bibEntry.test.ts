import { describe, expect, it } from 'vitest';
import { PlacedRun, citedGlyphs, entryBox } from './bibEntry';

const run = (x: number, y: number, right: number, size = 9): PlacedRun => ({ x, y, right, size });

describe('entryBox', () => {
  // Two columns of hanging entries: the left column's second entry has three lines, the right column one.
  const runs = [
    run(70, 700, 200), run(205, 700, 290), // entry 1, first line (two runs)
    run(80, 689, 250), // entry 1, hanging line
    run(70, 676, 290), // entry 2, first line
    run(80, 665, 280), run(80, 654, 200), // entry 2, hanging lines
    run(70, 641, 260), // entry 3
    run(310, 676, 540), // right column, beside entry 2
    run(320, 665, 530),
  ];

  it('takes the line under the target and the hanging lines after it, within its column', () => {
    expect(entryBox(runs, 70, 684)).toEqual({ left: 68, right: 292, top: 676 + 0.85 * 9, bottom: 654 - 0.3 * 9 });
  });

  it('stops at the next entry and finds an entry of the right column', () => {
    expect(entryBox(runs, 70, 708)).toMatchObject({ top: 700 + 0.85 * 9, bottom: 689 - 0.3 * 9, right: 292 });
    expect(entryBox(runs, 310, 684)).toMatchObject({ left: 308, right: 542, bottom: 665 - 0.3 * 9 });
  });

  it('finds nothing where no line is under the target', () => {
    expect(entryBox(runs, 70, 600)).toBeNull();
  });
});

describe('citedGlyphs', () => {
  it('gives the glyphs under links to citations, not under other links', () => {
    const runs = [{ x: 100, y: 500, size: 10, glyphs: [{ x: 0, width: 5 }, { x: 5, width: 5 }, { x: 10, width: 5 }] }, { x: 200, y: 500, size: 10, glyphs: [{ x: 0, width: 5 }] }];
    const annotations = [
      { subtype: 'Link', dest: 'cite.smith2020', rect: [104, 498, 116, 508] },
      { subtype: 'Link', dest: 'figure.1', rect: [199, 498, 206, 508] },
      { subtype: 'Text', rect: [0, 0, 600, 800] },
    ];
    expect(citedGlyphs(runs, annotations)).toEqual(new Map([[0, new Set([1, 2])]]));
  });
});
