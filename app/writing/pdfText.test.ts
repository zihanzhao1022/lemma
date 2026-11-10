import { describe, expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { pdfClickWord, pdfTextAt, pdfWordAt, selectedPdfWord } from './pdfText';

const item = (str: string, x: number, y: number, width: number, transform = [10, 0, 0, 10, x, y]): TextItem => ({
  str, transform, width, height: 10, dir: 'ltr', fontName: 'test', hasEOL: false,
});

describe('PDF words', () => {
  it('normalizes ligatures without shifting the clicked character', () => {
    expect(pdfWordAt('An eﬃcient method', 5)).toBe('efficient');
    expect(pdfWordAt('co\u00adoperate', 4)).toBe('cooperate');
    expect(pdfWordAt('state\u2011of\u2011the\u2011art', 8)).toBe('state-of-the-art');
    expect(pdfWordAt('author’s', 6)).toBe("author's");
    expect(pdfWordAt('cafe\u0301', 4)).toBe('café');
  });

  it('keeps CJK clicks useful without selecting an entire unspaced sentence', () => {
    expect(pdfWordAt('学习中文。', 2)).toBe('中');
    expect(pdfWordAt('𠀀字', 0)).toBe('𠀀');
    expect(pdfWordAt('中文。', 2)).toBe('');
    expect(pdfWordAt('alpha beta', 5)).toBe('');
  });

  it('keeps decimal cells intact when clicking a digit, sign, separator or percent', () => {
    for (const token of ['74.8', '+74.8%', '\u221274.8', '-.5', '1,234.56', '1.2e-3', '+1.2E\u22123%']) {
      const text = `Score (${token}).`;
      for (let index = 0; index < Array.from(token).length; index += 1) {
        expect(pdfWordAt(text, 7 + index)).toBe(token.replace(/\u2212/g, '-'));
      }
    }
    expect(pdfWordAt('74.8 ± 0.2', 2)).toBe('74.8');
    expect(pdfWordAt('74.8 ± 0.2', 9)).toBe('0.2');
    expect(pdfWordAt('74.8 ± 0.2', 5)).toBe('');
    expect(pdfWordAt('GPT4 HarmBench2', 3)).toBe('GPT4');
    expect(pdfWordAt('GPT4 HarmBench2', 14)).toBe('HarmBench2');
    expect(pdfWordAt('word.', 4)).toBe('');
  });

  it('expands partial native numeric selections without replacing unrelated exact selections', () => {
    expect(pdfClickWord('74', '74.8')).toBe('74.8');
    expect(pdfClickWord('8', '74.8')).toBe('74.8');
    expect(pdfClickWord('.', '74.8')).toBe('74.8');
    expect(pdfClickWord('1.2', '-1.2e-3%')).toBe('-1.2e-3%');
    expect(pdfClickWord('', '74.8')).toBe('74.8');
    expect(pdfClickWord('69.9', '71.3')).toBe('69.9');
    expect(pdfClickWord('method', 'methods')).toBe('method');
    expect(pdfClickWord('74', '74.8 result')).toBe('74');
    expect(pdfClickWord('word', '')).toBe('word');
  });
});

describe('PDF text hit geometry and context', () => {
  it('keeps same-baseline text from different columns apart', () => {
    const items = [item('Left column', 40, 500, 80), item('Right column', 145, 500, 80)];
    expect(pdfTextAt(items, 160, 505)).toMatchObject({ index: 1, word: 'Right', context: 'Right column', baseline: 500 });
    expect(pdfTextAt(items, 55, 505)).toMatchObject({ index: 0, word: 'Left', context: 'Left column' });
  });

  it('preserves adjacent table-header cells as supplemental context across wide gaps', () => {
    const items = [item('Method', 40, 500, 35), item('HarmBench', 140, 500, 60), item('AdvBench', 260, 500, 50)];
    expect(pdfTextAt(items, 160, 505)).toMatchObject({ word: 'HarmBench', context: 'HarmBench', rowContext: 'Method HarmBench AdvBench' });
  });

  it('identifies the clicked occurrence of a repeated header in both its fragment and row', () => {
    const items = [item('Method', 40, 500, 35), item('Shift A', 140, 500, 35), item('Shift B', 260, 500, 35)];
    expect(pdfTextAt(items, 271, 505)).toMatchObject({
      word: 'Shift', context: 'Shift B', contextOffset: 2,
      rowContext: 'Method Shift A Shift B', rowContextOffset: 17,
    });
    expect(pdfTextAt([item('Shift A Shift B', 40, 500, 70)], 91, 505)).toMatchObject({
      word: 'Shift', context: 'Shift A Shift B', contextOffset: 10,
      rowContext: 'Shift A Shift B', rowContextOffset: 10,
    });
  });

  it('reports normalized UTF-16 offsets after ligatures, astral glyphs and trimmed whitespace', () => {
    const text = '  eﬃcient 𠀀 Shift B  ';
    const x = 40 + (Array.from(text).indexOf('S') + 2.2) * 5;
    expect(pdfTextAt([item(text, 40, 500, Array.from(text).length * 5)], x, 505)).toMatchObject({
      word: 'Shift', context: 'efficient 𠀀 Shift B', contextOffset: 15,
      rowContext: 'efficient 𠀀 Shift B', rowContextOffset: 15,
    });
  });

  it('joins split glyph runs and preserves spaces between actual words', () => {
    const items = [item('e', 40, 500, 5), item('ﬃ', 45, 500, 8), item('cient', 53, 500, 25), item('method', 81, 500, 30)];
    expect(pdfTextAt(items, 48, 505)).toMatchObject({ word: 'efficient', context: 'efficient method' });
    expect(pdfTextAt(items, 90, 505)).toMatchObject({ word: 'method', context: 'efficient method' });
  });

  it('joins split decimal glyph runs without shifting numeric-cell offsets', () => {
    const items = [item('eﬃcient', 40, 500, 35), item('74', 140, 500, 10), item('.', 150, 500, 5), item('8', 155, 500, 5)];
    for (const x of [142, 147, 152, 157]) {
      expect(pdfTextAt(items, x, 505)).toMatchObject({
        word: '74.8', context: '74.8', rowContext: 'efficient 74.8',
        contextOffset: Math.floor((x - 140) / 5), rowContextOffset: 10 + Math.floor((x - 140) / 5),
      });
    }
  });

  it('hits rotated text and follows its own baseline', () => {
    const items = [
      item('Rotated', 100, 200, 70, [0, 10, -10, 0, 100, 200]),
      item('text', 100, 274, 40, [0, 10, -10, 0, 100, 274]),
      item('Other', 120, 200, 50, [0, 10, -10, 0, 120, 200]),
    ];
    expect(pdfTextAt(items, 96, 225)).toMatchObject({ word: 'Rotated', context: 'Rotated text' });
    const clockwise = item('Clockwise', 100, 200, 90, [0, -10, 10, 0, 100, 200]);
    expect(pdfTextAt([clockwise], 104, 175)?.word).toBe('Clockwise');
  });

  it('uses vertical advances and right-to-left word positions', () => {
    const vertical = { ...item('中文测试', 100, 200, 10), dir: 'ttb', height: 40 };
    expect(pdfTextAt([vertical], 104, 175)?.word).toBe('测');
    const rtl = { ...item('אב גד', 50, 500, 50), dir: 'rtl' };
    expect(pdfTextAt([rtl], 94, 505)?.word).toBe('אב');
    expect(pdfTextAt([rtl], 55, 505)?.word).toBe('גד');
  });

  it('returns no text on blank areas and accepts the exact DOM span for font ascent differences', () => {
    const items = [item('Word', 40, 500, 30)];
    expect(pdfTextAt(items, 200, 200)).toBeNull();
    expect(pdfTextAt(items, 45, 512, 0)).toMatchObject({ word: 'Word' });
  });
});

describe('PDF browser selection', () => {
  const anchor = {} as Node;
  const focus = {} as Node;
  const clicked = {
    textContent: 'First eﬃcient second',
    contains: (node: Node) => node === anchor || node === focus,
  } as unknown as HTMLElement;
  const selection = (overrides: Partial<Selection> = {}): Selection => ({
    anchorNode: anchor, focusNode: focus, rangeCount: 1, isCollapsed: false,
    toString: () => 'eﬃcient',
    getRangeAt: () => ({ getClientRects: () => [{ left: 30, right: 75, top: 10, bottom: 20 }] }),
    ...overrides,
  } as unknown as Selection);

  it('uses only selections whose glyphs and both ends belong to the clicked span', () => {
    expect(selectedPdfWord(selection(), clicked, 45, 15)).toBe('efficient');
    expect(selectedPdfWord(selection(), clicked, 100, 15)).toBe('');
    expect(selectedPdfWord(selection({ focusNode: {} as Node }), clicked, 45, 15)).toBe('');
    expect(selectedPdfWord(selection({ anchorNode: {} as Node }), clicked, 45, 15)).toBe('');
    expect(selectedPdfWord(selection(), undefined, 45, 15)).toBe('');
    expect(selectedPdfWord(selection({ toString: () => 'elsewhere' }), clicked, 45, 15)).toBe('');
  });
});
