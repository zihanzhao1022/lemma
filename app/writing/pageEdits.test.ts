import { describe, expect, it } from 'vitest';
import { deleteAfter, deleteBefore, escapeTyped, moveCaret, moveWord, printedChange, removeRange, typedSince, typedSinceText } from './pageEdits';
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

describe('removeRange', () => {
  const apply = (source: string, from: number, to: number) => {
    const change = removeRange(source, printedUnits(source), from, to);
    return change ? source.slice(0, change.from) + change.insert + source.slice(change.to) : source;
  };

  it('takes out the printed text and keeps the markup it crosses', () => {
    const source = 'one \\textbf{two three} four';
    expect(apply(source, source.indexOf('wo'), source.indexOf('our'))).toBe('one \\textbf{t}our');
  });

  it('keeps table separators, takes the spaces beside them and an atom whole', () => {
    expect(apply('a & b $x$ c \\\\ d', 0, 12)).toBe('&\\\\ d');
  });

  it('keeps the line break before a comment line, so it stays a line of its own', () => {
    const source = 'one two\n\n%% galley-block b2 text\nthree four';
    expect(apply(source, source.indexOf('two'), source.indexOf('four'))).toBe('one \n%% galley-block b2 text\nfour');
  });

  it('gives nothing when nothing printed is selected', () => {
    expect(removeRange('\\label{x}', printedUnits('\\label{x}'), 0, 9)).toBeNull();
  });
});

describe('moveWord', () => {
  const units = (source: string) => printedUnits(source);

  it('goes to the start of the word before and the end of the word after', () => {
    const source = 'the \\emph{quick} brown, fox';
    expect(moveWord(units(source), source.indexOf('brown') + 2, -1)).toBe(source.indexOf('brown'));
    expect(moveWord(units(source), source.indexOf('brown'), -1)).toBe(source.indexOf('quick'));
    expect(moveWord(units(source), source.indexOf('brown'), 1)).toBe(source.indexOf(','));
    expect(moveWord(units(source), source.indexOf(','), 1)).toBe(source.length);
  });

  it('takes an atom as one word and stops at a table separator', () => {
    const source = 'see $x+y$ here & next';
    expect(moveWord(units(source), source.indexOf(' here'), -1)).toBe(source.indexOf('$'));
    expect(moveWord(units(source), source.indexOf('here'), 1)).toBe(source.indexOf(' &'));
    expect(moveWord(units(source), source.indexOf(' &'), 1)).toBe(source.indexOf('&'));
  });
});

describe('printedChange', () => {
  const change = (before: string, after: string) => printedChange(printedUnits(before), before, printedUnits(after), after);

  it('finds the printed units that went and the text put in their place', () => {
    const before = 'one \\textbf{two three} four';
    const after = 'one \\textbf{tX}our';
    expect(change(before, after)).toEqual({ from: 5, to: 15, inserted: 'X', start: after.indexOf('X'), end: after.indexOf('X') + 1 });
  });

  it('gives a deletion with nothing put in and an insertion with nothing taken', () => {
    expect(change('abc', 'ac')).toEqual({ from: 1, to: 2, inserted: '', start: 1, end: 1 });
    expect(change('ac', 'a b c')).toMatchObject({ from: 1, to: 1, inserted: ' b ' });
  });

  it('reaches the caret, so text typed over a word is all put in', () => {
    const before = 'of full fine';
    const after = 'of all fine';
    expect(printedChange(printedUnits(before), before, printedUnits(after), after)).toMatchObject({ from: 3, to: 5, inserted: 'a' });
    expect(printedChange(printedUnits(before), before, printedUnits(after), after, 6)).toMatchObject({ from: 3, to: 7, inserted: 'all', start: 3, end: 6 });
  });

  it('gives nothing for markup that prints nothing, and no text for an atom put in', () => {
    expect(change('a b', '\\emph{a} b')).toBeNull();
    expect(change('a b', 'a $x$ b')).toMatchObject({ inserted: null });
  });
});
