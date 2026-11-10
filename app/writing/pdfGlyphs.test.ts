import { describe, expect, it } from 'vitest';
import { GlyphOps, glyphRuns } from './pdfGlyphs';

const OPS: GlyphOps = {
  save: 10, restore: 11, transform: 12, beginText: 31, endText: 32, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35, setLeading: 36,
  setFont: 37, setTextRenderingMode: 38, setTextRise: 39, moveText: 40, setLeadingMoveText: 41, setTextMatrix: 42, nextLine: 43,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47, setFillRGBColor: 59,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
};
const glyph = (unicode: string, width = 500) => ({ fontChar: `${unicode}`, unicode, width, isSpace: false });
const fonts = (name: string) => (name === 'g3' ? { fontMatrix: [0.001, 0, 0, 0.001, 0, 0], isType3Font: true } : { fontMatrix: [0.001, 0, 0, 0.001, 0, 0] });

describe('glyphRuns', () => {
  it('places each glyph of a line, split where TeX moved the next one', () => {
    const fn = [OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.endText];
    const args = [null, ['g1', 10], [72, 700], [[glyph('W', 900), glyph('e', 400), -333, glyph('g', 500)]], null];
    const { runs, drawn } = glyphRuns(fn, args, OPS, fonts);
    expect(runs).toEqual([
      { op: 3, font: 'g1', color: '#000000', x: 72, y: 700, size: 10, scaleX: 1, str: 'We', glyphs: [
        { char: 'W', text: 'W', offset: 0, x: 0, width: 9 },
        { char: 'e', text: 'e', offset: 1, x: 9, width: 4 },
      ] },
      { op: 3, font: 'g1', color: '#000000', x: 72 + 13 + 3.33, y: 700, size: 10, scaleX: 1, str: 'g', glyphs: [{ char: 'g', text: 'g', offset: 0, x: 0, width: 5 }] },
    ]);
    expect([...drawn]).toEqual([3]);
  });

  it('follows moves, the current transform and the fill colour', () => {
    const fn = [OPS.save, OPS.transform, OPS.setFillRGBColor, OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.moveText, OPS.showText, OPS.endText, OPS.restore];
    const args = [null, [2, 0, 0, 2, 10, 20], ['#ff0000'], null, ['g1', 5], [1, 2], [[glyph('a')]], [0, -3], [[glyph('b')]], null, null];
    const { runs } = glyphRuns(fn, args, OPS, fonts);
    expect(runs.map(({ x, y, size, color, str }) => ({ x, y, size, color, str }))).toEqual([
      { x: 12, y: 24, size: 10, color: '#ff0000', str: 'a' },
      { x: 12, y: 18, size: 10, color: '#ff0000', str: 'b' },
    ]);
  });

  it('keeps a text matrix and the words after a line break on the next line', () => {
    const fn = [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.setLeading, OPS.showText, OPS.nextLine, OPS.showText];
    const args = [null, ['g1', 10], [[1, 0, 0, 1, 50, 500]], [12], [[glyph('x')]], null, [[glyph('y')]]];
    const { runs } = glyphRuns(fn, args, OPS, fonts);
    expect(runs.map(({ x, y }) => [x, y])).toEqual([
      [50, 500],
      [50, 488],
    ]);
  });

  it('leaves to the canvas a Type 3 font, invisible text and rotated text', () => {
    const fn = [OPS.beginText, OPS.setFont, OPS.showText, OPS.setFont, OPS.setTextRenderingMode, OPS.showText, OPS.setTextRenderingMode, OPS.setTextMatrix, OPS.showText];
    const args = [null, ['g3', 10], [[glyph('a')]], ['g1', 10], [3], [[glyph('b')]], [0], [[0, 1, -1, 0, 100, 100]], [[glyph('c')]]];
    const { runs, drawn } = glyphRuns(fn, args, OPS, fonts);
    expect(runs).toEqual([]);
    expect([...drawn]).toEqual([]);
  });

  it('stretches a run set with a horizontal scale', () => {
    const fn = [OPS.beginText, OPS.setFont, OPS.setHScale, OPS.showText];
    const args = [null, ['g1', 10], [50], [[glyph('a', 1000), glyph('b', 1000)]]];
    const { runs } = glyphRuns(fn, args, OPS, fonts);
    expect(runs[0]).toMatchObject({ scaleX: 0.5, glyphs: [{ x: 0, width: 5 }, { x: 5, width: 5 }] });
  });
});
