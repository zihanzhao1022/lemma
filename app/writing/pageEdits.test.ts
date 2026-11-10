import { describe, expect, it } from 'vitest';
import { deleteAfter, deleteBefore, escapeTyped, moveCaret, typedSince, typedSinceText } from './pageEdits';
import { printedUnits } from './printed';

describe('escapeTyped', () => {
  it('escapes the characters LaTeX treats specially', () => {
    expect(escapeTyped('50% & $5_x {a} #1 ~ ^ \\')).toBe('50\\% \\& \\$5\\_x \\{a\\} \\#1 \\~{} \\^{} \\textbackslash{}');
  });

  it('turns straight double quotes into opening and closing TeX quotes', () => {
    expect(escapeTyped('say "yes" now', ' ')).toBe("say ``yes'' now");
    expect(escapeTyped('"', 'x')).toBe("''");
    expect(escapeTyped('"', '')).toBe('``');
  });

  it('keeps other text as it is', () => {
    expect(escapeTyped('naïve 中文 x-y')).toBe('naïve 中文 x-y');
  });
});

describe('deleteBefore', () => {
  const at = (source: string, caret: number) => deleteBefore(printedUnits(source), caret);

  it('removes the character before the caret', () => {
    expect(at('ab cd', 4)).toEqual({ from: 3, to: 4 });
  });

  it('removes an escaped character whole', () => {
    expect(at('5\\% x', 3)).toEqual({ from: 1, to: 3 });
  });

  it('removes a whole run of spaces', () => {
    expect(at('a  b', 3)).toEqual({ from: 1, to: 3 });
  });

  it('removes a math or citation atom whole', () => {
    expect(at('x \\cite{a} y', 10)).toEqual({ from: 2, to: 10 });
    expect(at('x $y$ z', 5)).toEqual({ from: 2, to: 5 });
  });

  it('never removes a table cell separator', () => {
    expect(at('a & b', 3)).toBeNull();
  });

  it('reaches the character before closing markup', () => {
    expect(at('\\emph{ab}c', 9)).toEqual({ from: 7, to: 8 });
  });

  it('has nothing to remove at the start', () => {
    expect(at('ab', 0)).toBeNull();
  });
});

describe('deleteAfter', () => {
  it('removes the character after the caret', () => {
    expect(deleteAfter(printedUnits('ab'), 0)).toEqual({ from: 0, to: 1 });
  });

  it('removes an atom after the caret whole', () => {
    expect(deleteAfter(printedUnits('x $y$ z'), 2)).toEqual({ from: 2, to: 5 });
  });
});

describe('moveCaret', () => {
  it('steps over markup to the next printed character', () => {
    const units = printedUnits('\\emph{ab}c');
    expect(moveCaret(units, 9, -1)).toBe(7);
    expect(moveCaret(units, 9, 1)).toBe(10);
  });

  it('crosses an atom in one step', () => {
    expect(moveCaret(printedUnits('x $y$ z'), 2, 1)).toBe(5);
  });

  it('stays at either end', () => {
    const units = printedUnits('ab');
    expect(moveCaret(units, 0, -1)).toBe(0);
    expect(moveCaret(units, 2, 1)).toBe(2);
  });
});

describe('typedSince', () => {
  it('gives the text typed since the caret on screen, as it prints', () => {
    expect(typedSince('a 50\\% gain', 2, 6)).toBe('50%');
  });
  it('gives nothing for no typing, a new paragraph or a long stretch', () => {
    expect(typedSince('abc', 2, 2)).toBe('');
    expect(typedSince('ab\n\ncd', 2, 4)).toBe('');
    expect(typedSince('x'.repeat(300), 0, 200)).toBe('');
    expect(typedSince('abc', null, 2)).toBe('');
  });
});

describe('typedSinceText', () => {
  it('gives what was inserted right before the caret, as it prints', () => {
    expect(typedSinceText('a  gain', 'a 5\\% gain', 5)).toBe('5%');
  });
  it('gives nothing when the text changed anywhere else too', () => {
    expect(typedSinceText('abc def', 'abXc dZef', 4)).toBe('');
    expect(typedSinceText('abc', 'ab', 2)).toBe('');
  });
});
