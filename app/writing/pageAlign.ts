/**
 * Pairs what a stretch of LaTeX prints (printed.ts) with the text pdf.js reads from the same place in the PDF,
 * character by character, so a click on a glyph finds its source and a source position finds its glyph.
 *
 * Words and punctuation are aligned first, as whole tokens, which keeps the pairing on the right occurrence of a
 * common letter; extra PDF text at either end of the region costs nothing, gaps inside it a little. Then the
 * characters of each paired token are paired one by one, and spaces go to the space right before the next word.
 */
import type { PrintedUnit } from './printed';

/** PDF text in reading order: a text item's string, or (item < 0) a space the layout implies: ' ' or a line end '\n'. */
export interface PdfPiece {
  item: number;
  text: string;
}

/** A glyph: UTF-16 `offset` and `length` in its text item's string; item -1 for a space the layout implies. */
export interface Spot {
  item: number;
  offset: number;
  length: number;
}

export interface PdfChar {
  spot: Spot;
  /** Folded for comparison (see fold); one glyph can give several (a ligature). */
  text: string;
  /** The unit it prints, or -1: text TeX generated (numbers, labels), a line-end hyphen, or text outside the region. */
  unit: number;
}

export interface Alignment {
  units: PrintedUnit[];
  /** For each unit, the first and last of `chars` it printed as; null when it is not paired. */
  unitChars: ([number, number] | null)[];
  chars: PdfChar[];
}

/** Characters as compared: NFKC (ligatures apart), lower case, one kind of quote and of dash, no soft hyphens. */
export const fold = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/­/g, '');

const isWordChar = (char: string): boolean => /[\p{L}\p{N}\p{M}]/u.test(char);
const isDigit = (char: string): boolean => /\p{N}/u.test(char);

interface Side {
  /** Folded characters; ' ' and '\n' are spaces. */
  text: string[];
  /** For a source side, the unit of each character; atoms are one character each. */
  atom: boolean[];
}

interface Token {
  kind: 'word' | 'punct' | 'atom';
  key: string;
  chars: number[];
}

/** Words (letters and digits, joined by inner hyphens, apostrophes and decimal points), punctuation and atoms. */
function tokenize(side: Side, joinLineEndHyphens: boolean): Token[] {
  const tokens: Token[] = [];
  const { text } = side;
  const space = (k: number) => text[k] === ' ' || text[k] === '\n';
  let k = 0;
  while (k < text.length) {
    if (side.atom[k]) {
      tokens.push({ kind: 'atom', key: `\u0000${k}`, chars: [k] });
      k += 1;
      continue;
    }
    if (space(k)) {
      k += 1;
      continue;
    }
    if (!isWordChar(text[k])) {
      tokens.push({ kind: 'punct', key: text[k], chars: [k] });
      k += 1;
      continue;
    }
    const chars: number[] = [];
    while (k < text.length && !side.atom[k]) {
      const char = text[k];
      if (isWordChar(char)) {
        chars.push(k);
        k += 1;
        continue;
      }
      const previous = text[chars[chars.length - 1]];
      const next = text[k + 1];
      if ((char === '-' || char === "'") && next !== undefined && isWordChar(next)) {
        chars.push(k);
        k += 1;
        continue;
      }
      if ((char === '.' || char === ',') && isDigit(previous) && next !== undefined && isDigit(next)) {
        chars.push(k);
        k += 1;
        continue;
      }
      // TeX's hyphen at a line end, inside a word that goes on on the next line.
      if (joinLineEndHyphens && char === '-' && text[k + 1] === '\n' && text[k + 2] !== undefined && isWordChar(text[k + 2])) {
        chars.push(k);
        k += 2;
        continue;
      }
      break;
    }
    const key = chars.map((index) => text[index]).join('').replace(/['-]/g, '');
    tokens.push({ kind: 'word', key, chars });
  }
  return tokens;
}

const MATCH_WORD = 40;
const MATCH_PUNCT = 10;
const SKIP_SOURCE = 10;
const SKIP_PDF = 2;

/** Token pairs (source index, PDF index) of the best alignment; PDF tokens before the first and after the last pair are free. */
function alignTokens(source: Token[], pdf: Token[]): [number, number][] {
  const n = source.length;
  const m = pdf.length;
  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  const move = new Uint8Array((n + 1) * width);
  for (let j = 1; j <= m; j += 1) move[j] = 3;
  for (let i = 1; i <= n; i += 1) {
    score[i * width] = -SKIP_SOURCE * i;
    move[i * width] = 2;
    for (let j = 1; j <= m; j += 1) {
      const a = source[i - 1];
      const b = pdf[j - 1];
      let best = score[(i - 1) * width + j] - SKIP_SOURCE;
      let step = 2;
      const left = score[i * width + j - 1] - SKIP_PDF;
      if (left > best) {
        best = left;
        step = 3;
      }
      if (a.kind !== 'atom' && a.kind === b.kind && a.key === b.key) {
        const diagonal = score[(i - 1) * width + j - 1] + (a.kind === 'word' ? MATCH_WORD : MATCH_PUNCT);
        if (diagonal >= best) {
          best = diagonal;
          step = 1;
        }
      }
      score[i * width + j] = best;
      move[i * width + j] = step;
    }
  }
  let end = 0;
  for (let j = 1; j <= m; j += 1) if (score[n * width + j] > score[n * width + end]) end = j;
  const pairs: [number, number][] = [];
  let i = n;
  let j = end;
  while (i > 0 && j >= 0) {
    const step = move[i * width + j];
    if (step === 1) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (step === 2 || j === 0) i -= 1;
    else j -= 1;
  }
  return pairs.reverse();
}

export function align(units: PrintedUnit[], pieces: PdfPiece[]): Alignment {
  const chars: PdfChar[] = [];
  for (const piece of pieces) {
    if (piece.item < 0) {
      chars.push({ spot: { item: -1, offset: 0, length: 0 }, text: piece.text === '\n' ? '\n' : ' ', unit: -1 });
      continue;
    }
    for (let offset = 0; offset < piece.text.length; ) {
      const point = String.fromCodePoint(piece.text.codePointAt(offset)!);
      const folded = fold(point);
      for (const char of folded) chars.push({ spot: { item: piece.item, offset, length: point.length }, text: /\s/.test(char) ? ' ' : char, unit: -1 });
      offset += point.length;
    }
  }

  const sourceText: string[] = [];
  const sourceUnit: number[] = [];
  const sourceAtom: boolean[] = [];
  units.forEach((unit, index) => {
    if (unit.kind === 'char') {
      for (const char of fold(unit.text)) {
        sourceText.push(char);
        sourceUnit.push(index);
        sourceAtom.push(false);
      }
    } else {
      sourceText.push(unit.kind === 'atom' ? '\u0000' : ' ');
      sourceUnit.push(index);
      sourceAtom.push(unit.kind === 'atom');
    }
  });

  const sourceTokens = tokenize({ text: sourceText, atom: sourceAtom }, false);
  const pdfTokens = tokenize({ text: chars.map((char) => char.text), atom: chars.map(() => false) }, true);
  const unitChars: ([number, number] | null)[] = units.map(() => null);
  const pair = (sourceChar: number, pdfChar: number) => {
    const unit = sourceUnit[sourceChar];
    chars[pdfChar].unit = unit;
    const range = unitChars[unit];
    unitChars[unit] = range ? [Math.min(range[0], pdfChar), Math.max(range[1], pdfChar)] : [pdfChar, pdfChar];
  };
  for (const [s, p] of alignTokens(sourceTokens, pdfTokens)) {
    const a = sourceTokens[s].chars;
    const b = pdfTokens[p].chars;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const x = sourceText[a[i]];
      const y = chars[b[j]].text;
      if (x === y) {
        pair(a[i], b[j]);
        i += 1;
        j += 1;
      } else if (x === '-' || x === "'") i += 1;
      else if (y === '-' || y === "'") j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
  }

  // Spaces: the PDF space right before the next printed unit, else right after the previous one.
  const printed = (index: number) => units[index].kind === 'char' || units[index].kind === 'atom';
  const isPdfSpace = (index: number) => index >= 0 && index < chars.length && (chars[index].text === ' ' || chars[index].text === '\n') && chars[index].unit < 0;
  units.forEach((unit, index) => {
    if (unit.kind !== 'space' && unit.kind !== 'separator') return;
    let next = index + 1;
    while (next < units.length && !printed(next)) next += 1;
    const after = next < units.length ? unitChars[next] : null;
    if (after && isPdfSpace(after[0] - 1)) {
      chars[after[0] - 1].unit = index;
      unitChars[index] = [after[0] - 1, after[0] - 1];
      return;
    }
    let previous = index - 1;
    while (previous >= 0 && !printed(previous)) previous -= 1;
    const before = previous >= 0 ? unitChars[previous] : null;
    if (before && isPdfSpace(before[1] + 1)) {
      chars[before[1] + 1].unit = index;
      unitChars[index] = [before[1] + 1, before[1] + 1];
    }
  });
  return { units, unitChars, chars };
}

const isSpaceChar = (char: PdfChar) => char.text === ' ' || char.text === '\n';

/** The generated glyphs of an atom: the unpaired characters between its paired neighbours, spaces trimmed. */
export function atomChars(alignment: Alignment, unit: number): [number, number] | null {
  const { unitChars, chars } = alignment;
  let previous = unit - 1;
  while (previous >= 0 && !unitChars[previous]) previous -= 1;
  let next = unit + 1;
  while (next < unitChars.length && !unitChars[next]) next += 1;
  if (previous < 0 || next >= unitChars.length) return null;
  let first = unitChars[previous]![1] + 1;
  let last = unitChars[next]![0] - 1;
  while (first <= last && (isSpaceChar(chars[first]) || chars[first].unit >= 0)) first += 1;
  while (last >= first && (isSpaceChar(chars[last]) || chars[last].unit >= 0)) last -= 1;
  return first <= last ? [first, last] : null;
}

export type Caret = { offset: number } | { atom: number };

/** The source position a click on a glyph means: before or after it, or the atom it belongs to. */
export function caretAt(alignment: Alignment, index: number, side: 'before' | 'after'): Caret | null {
  const { chars, units } = alignment;
  if (index < 0 || index >= chars.length) return null;
  const sameGlyph = (k: number) => chars[k].spot.item === chars[index].spot.item && chars[k].spot.offset === chars[index].spot.offset;
  let at = index;
  if (side === 'after') while (at + 1 < chars.length && chars[at].spot.item >= 0 && sameGlyph(at + 1)) at += 1;
  const unit = chars[at].unit;
  if (unit >= 0) return { offset: side === 'before' ? units[unit].from : units[unit].to };
  for (let candidate = 0; candidate < units.length; candidate += 1) {
    if (units[candidate].kind !== 'atom') continue;
    const range = atomChars(alignment, candidate);
    if (range && index >= range[0] && index <= range[1]) return { atom: candidate };
  }
  // Text the source does not print (a line-end hyphen, a number TeX put before a caption) leads to the nearest
  // printed character on its line; a line with none (a label inside a figure's picture) leads nowhere.
  const paired = (k: number) => chars[k].unit >= 0 && units[chars[k].unit].kind === 'char';
  let back = index - 1;
  while (back >= 0 && chars[back].text !== '\n' && !paired(back)) back -= 1;
  let ahead = index + 1;
  while (ahead < chars.length && chars[ahead].text !== '\n' && !paired(ahead)) ahead += 1;
  const before = back >= 0 && paired(back) ? back : -1;
  const after = ahead < chars.length && paired(ahead) ? ahead : -1;
  if (side === 'before' && before >= 0) return { offset: units[chars[before].unit].to };
  if (after >= 0) return { offset: units[chars[after].unit].from };
  return before >= 0 ? { offset: units[chars[before].unit].to } : null;
}

/** The glyph to draw a caret at a source position against: after the character before it, else before the one after. */
export function spotFor(alignment: Alignment, offset: number): { char: number; side: 'before' | 'after' } | null {
  const { units, unitChars } = alignment;
  const ranges = units.map((unit, index) => (unit.kind === 'atom' ? atomChars(alignment, index) : unitChars[index]));
  const shown = (index: number) => ranges[index] !== null && units[index].kind !== 'space' && units[index].kind !== 'separator';
  for (let index = 0; index < units.length; index += 1) if (units[index].to === offset && shown(index)) return { char: ranges[index]![1], side: 'after' };
  for (let index = 0; index < units.length; index += 1) if (units[index].from === offset && shown(index)) return { char: ranges[index]![0], side: 'before' };
  let last = -1;
  for (let index = 0; index < units.length; index += 1) if (shown(index) && units[index].to <= offset) last = index;
  if (last >= 0) return { char: ranges[last]![1], side: 'after' };
  for (let index = 0; index < units.length; index += 1) if (shown(index) && units[index].from >= offset) return { char: ranges[index]![0], side: 'before' };
  return null;
}
