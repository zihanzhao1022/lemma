import { describe, expect, it } from 'vitest';
import { graphicsOf, imageBoxes, replaceGraphic } from './pageImages';

// The pdf.js operator codes these tests use.
const OPS = { save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83 };

describe('imageBoxes', () => {
  it('places a picture drawn in the unit square by the current transform', () => {
    const fn = [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore];
    const args = [[], [200, 0, 0, 100, 72, 500], ['img1', 10, 10], []];
    expect(imageBoxes(fn, args, OPS)).toEqual([{ left: 72, bottom: 500, right: 272, top: 600 }]);
  });

  it('places an included PDF by its form box, not by what is inside it', () => {
    const fn = [OPS.save, OPS.transform, OPS.paintFormXObjectBegin, OPS.paintImageXObject, OPS.paintFormXObjectEnd, OPS.restore];
    const args = [[], [0.5, 0, 0, 0.5, 100, 400], [[1, 0, 0, 1, 0, 0], [0, 0, 400, 200]], ['inner', 1, 1], [], []];
    expect(imageBoxes(fn, args, OPS)).toEqual([{ left: 100, bottom: 400, right: 300, top: 500 }]);
  });

  it('forgets a transform once its state is restored', () => {
    const fn = [OPS.save, OPS.transform, OPS.restore, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore];
    const args = [[], [10, 0, 0, 10, 0, 0], [], [], [50, 0, 0, 20, 5, 5], ['img', 1, 1], []];
    expect(imageBoxes(fn, args, OPS)).toEqual([{ left: 5, bottom: 5, right: 55, top: 25 }]);
  });
});

describe('graphicsOf', () => {
  it('finds each included graphic and the range of its file name', () => {
    const source = '\\centering\n\\includegraphics[width=\\linewidth]{figs/a.pdf}\\hfill\n\\includegraphics{b}';
    expect(graphicsOf(source, 0, source.length)).toEqual([
      { path: 'figs/a.pdf', from: source.indexOf('figs/a.pdf'), to: source.indexOf('figs/a.pdf') + 10 },
      { path: 'b', from: source.lastIndexOf('{b}') + 1, to: source.lastIndexOf('{b}') + 2 },
    ]);
  });

  it('leaves out graphics in comments and outside the range', () => {
    const source = '% \\includegraphics{old}\n\\includegraphics{new}\n\\includegraphics{after}';
    expect(graphicsOf(source, 0, source.indexOf('\n\\includegraphics{after}')).map((graphic) => graphic.path)).toEqual(['new']);
  });
});

describe('replaceGraphic', () => {
  it('keeps the extension style of the file name it replaces', () => {
    expect(replaceGraphic('figs/a.pdf', 'figs/b.png')).toBe('figs/b.png');
    expect(replaceGraphic('figs/a', 'figs/b.png')).toBe('figs/b');
  });
});
