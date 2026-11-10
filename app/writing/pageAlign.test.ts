import { describe, expect, it } from 'vitest';
import { PdfPiece, align, atomChars, caretAt, spotFor } from './pageAlign';
import { printedUnits } from './printed';

/** PDF lines, each a list of text items (separated by a gap), numbered in order across lines. */
function pieces(lines: string[][]): PdfPiece[] {
  const out: PdfPiece[] = [];
  let item = 0;
  lines.forEach((line, row) => {
    if (row > 0) out.push({ item: -1, text: '\n' });
    line.forEach((text, column) => {
      if (column > 0) out.push({ item: -1, text: ' ' });
      out.push({ item: item++, text });
    });
  });
  return out;
}

/** Where the unit printing source[at] went: "item:offset". */
function placeOf(source: string, pdf: PdfPiece[], at: number): string | null {
  const alignment = align(printedUnits(source), pdf);
  const unit = alignment.units.findIndex((candidate) => candidate.from === at);
  const range = alignment.unitChars[unit];
  if (!range) return null;
  const { spot } = alignment.chars[range[0]];
  return `${spot.item}:${spot.offset}`;
}

describe('align', () => {
  it('pairs each character of identical text', () => {
    const source = 'Hello world';
    const pdf = pieces([['Hello world']]);
    expect(placeOf(source, pdf, 0)).toBe('0:0');
    expect(placeOf(source, pdf, 6)).toBe('0:6');
    expect(placeOf(source, pdf, 5)).toBe('0:5');
  });

  it('joins a word TeX hyphenated across lines and leaves the hyphen unpaired', () => {
    const source = 'a calibration b';
    const pdf = pieces([['a calibra-'], ['tion b']]);
    expect(placeOf(source, pdf, 2)).toBe('0:2');
    expect(placeOf(source, pdf, 9)).toBe('1:0');
    const alignment = align(printedUnits(source), pdf);
    const hyphen = alignment.chars.find((char) => char.spot.item === 0 && char.spot.offset === 9)!;
    expect(hyphen.unit).toBe(-1);
  });

  it('keeps a real hyphen that falls at a line end', () => {
    const source = 'a trade-off b';
    const pdf = pieces([['a trade-'], ['off b']]);
    expect(placeOf(source, pdf, 7)).toBe('0:7');
    expect(placeOf(source, pdf, 8)).toBe('1:0');
  });

  it('pairs both letters of a ligature with its one glyph', () => {
    const source = 'find';
    const pdf = pieces([['ﬁnd']]);
    expect(placeOf(source, pdf, 0)).toBe('0:0');
    expect(placeOf(source, pdf, 1)).toBe('0:0');
    expect(placeOf(source, pdf, 2)).toBe('0:1');
  });

  it('ignores case, for headings set in capitals', () => {
    expect(placeOf('Accuracy and Cost', pieces([['ACCURACY AND COST']]), 13)).toBe('0:13');
  });

  it('gives an atom the generated text between its neighbours', () => {
    const source = 'see~\\cite{x} now';
    const alignment = align(printedUnits(source), pieces([['see [12] now']]));
    const atom = alignment.units.findIndex((unit) => unit.kind === 'atom');
    const [first, last] = atomChars(alignment, atom)!;
    expect(alignment.chars.slice(first, last + 1).map((char) => char.spot.offset)).toEqual([4, 5, 6, 7]);
    expect(placeOf(source, pieces([['see [12] now']]), 13)).toBe('0:9');
  });

  it('finds the region inside extra text on both sides', () => {
    const source = 'We route the step.';
    const pdf = pieces([['end of it. We route the step. The next.']]);
    expect(placeOf(source, pdf, 0)).toBe('0:11');
    expect(placeOf(source, pdf, 17)).toBe('0:28');
  });

  it('pairs table cells across the gaps between them, repeated values in order', () => {
    const source = 'Ours & 0.62 & 0.62 \\\\';
    const pdf = pieces([['Ours', '0.62', '0.62']]);
    expect(placeOf(source, pdf, 7)).toBe('1:0');
    expect(placeOf(source, pdf, 14)).toBe('2:0');
  });

  it('pairs a space with the space right before the next word, not one inside math', () => {
    const source = 'confidence $c_t$ falls';
    const pdf = pieces([['confidence c t falls']]);
    expect(placeOf(source, pdf, 16)).toBe('0:14');
  });
});

describe('carets', () => {
  const source = 'We route each step.';
  const pdf = pieces([['We route each step.']]);
  const alignment = align(printedUnits(source), pdf);
  const charAt = (offset: number) => alignment.chars.findIndex((char) => char.spot.item === 0 && char.spot.offset === offset);

  it('puts the caret before or after the clicked glyph', () => {
    expect(caretAt(alignment, charAt(3), 'before')).toEqual({ offset: 3 });
    expect(caretAt(alignment, charAt(3), 'after')).toEqual({ offset: 4 });
  });

  it('draws a caret at the end of a word after its last glyph', () => {
    expect(spotFor(alignment, 8)).toEqual({ char: charAt(7), side: 'after' });
  });

  it('draws a caret at the start of a word before its first glyph', () => {
    expect(spotFor(alignment, 0)).toEqual({ char: charAt(0), side: 'before' });
  });

  it('selects an atom when its generated text is clicked', () => {
    const cited = 'see~\\cite{x} now';
    const withAtom = align(printedUnits(cited), pieces([['see [12] now']]));
    const bracket = withAtom.chars.findIndex((char) => char.spot.offset === 5);
    expect(caretAt(withAtom, bracket, 'before')).toEqual({ atom: withAtom.units.findIndex((unit) => unit.kind === 'atom') });
  });

  it('places no caret for a click on a line of text the source does not print, like a label inside a figure', () => {
    const figure = align(printedUnits('\\includegraphics{a.pdf}\\caption{Accuracy of the methods.}'), pieces([['74.8'], ['Figure 1: Accuracy of the methods.']]));
    const label = figure.chars.findIndex((char) => char.spot.item === 0 && char.spot.offset === 1);
    expect(caretAt(figure, label, 'before')).toBeNull();
    expect(caretAt(figure, label, 'after')).toBeNull();
  });

  it('moves a click on unpaired text to the nearest paired character', () => {
    const hyphenated = align(printedUnits('a calibration b'), pieces([['a calibra-'], ['tion b']]));
    const hyphen = hyphenated.chars.findIndex((char) => char.spot.item === 0 && char.spot.offset === 9);
    expect(caretAt(hyphenated, hyphen, 'before')).toEqual({ offset: 9 });
  });
});
