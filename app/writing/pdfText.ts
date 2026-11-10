import type { TextItem } from 'pdfjs-dist/types/src/display/api';

interface Geometry {
  item: TextItem;
  index: number;
  x: number;
  y: number;
  ux: number;
  uy: number;
  width: number;
  height: number;
}

export interface PdfTextHit {
  index: number;
  baseline: number;
  word: string;
  context: string;
  /** UTF-16 offset of the clicked glyph in the normalized, trimmed context. */
  contextOffset?: number;
  /** Complete baseline, including cells separated by wide table-column gaps. */
  rowContext: string;
  rowContextOffset?: number;
}

/** PDF text commonly contains presentation ligatures and discretionary hyphens. */
export const normalizePdfText = (text: string): string => text.normalize('NFKC')
  .replace(/\u00ad/g, '')
  .replace(/[\u2010\u2011\u2212]/g, '-')
  .replace(/[\u2018\u2019]/g, "'");

const isCjk = (char: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
const isLetter = (char: string) => /[\p{L}\p{N}\p{M}]/u.test(char);
const isJoiner = (char: string) => /[-'\u00ad\u2010\u2011\u2018\u2019]/u.test(char);
const numericToken = /[+\-\u2212]?(?:(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+\-\u2212]?[0-9]+)?%?/;

/** Native double-click selection can cover just one side of the clicked decimal. */
export function pdfClickWord(selected: string, computed: string): string {
  if (!selected) return computed;
  if (computed.match(numericToken)?.[0] === computed && computed.includes(selected)) return computed;
  return selected;
}

/** Uses code points before normalization, so a ligature still occupies one glyph at the click. */
export function pdfWordAt(text: string, character: number): string {
  const chars = Array.from(text);
  const at = Math.max(0, Math.min(chars.length - 1, Math.floor(character)));
  // Numeric cells are one source token even when the browser selects only one side of a decimal.
  // Match the original text so normalization of earlier ligatures cannot move the clicked glyph.
  const offset = chars.slice(0, at).join('').length;
  for (const match of text.matchAll(new RegExp(numericToken.source, 'g'))) {
    const start = match.index!;
    const end = start + match[0].length;
    if (offset < start || offset >= end) continue;
    // Do not split identifiers such as GPT4 or scientific method names containing digits.
    const preceding = Array.from(text.slice(0, start));
    const before = preceding[preceding.length - 1];
    const after = Array.from(text.slice(end))[0];
    if ((!before || !isLetter(before)) && (!after || !isLetter(after))) return normalizePdfText(match[0]);
  }
  if (!chars.length || (!isLetter(chars[at]) && !isJoiner(chars[at]))) return '';
  // A whole unspaced CJK paragraph is not a useful word; its line remains available as context.
  if (isCjk(chars[at])) return normalizePdfText(chars[at]);
  const belongs = (index: number): boolean => {
    const char = chars[index];
    if (!char || isCjk(char)) return false;
    return isLetter(char) || (isJoiner(char) && index > 0 && index + 1 < chars.length
      && isLetter(chars[index - 1]) && isLetter(chars[index + 1]));
  };
  if (!belongs(at)) return '';
  let start = at;
  let end = at + 1;
  while (start > 0 && belongs(start - 1)) start -= 1;
  while (end < chars.length && belongs(end)) end += 1;
  return normalizePdfText(chars.slice(start, end).join(''));
}

function geometry(item: TextItem, index: number): Geometry | null {
  const [a, b, c, d, x, y] = item.transform as number[];
  const length = Math.hypot(a, b);
  if (!Number.isFinite(length) || length === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const vertical = item.dir === 'ttb';
  return {
    item, index, x, y,
    // PDF.js rotates vertical text by 90 degrees in viewport coordinates (whose y axis is reversed).
    ux: vertical ? b / length : a / length,
    uy: vertical ? -a / length : b / length,
    width: Math.abs(vertical ? item.height : item.width),
    height: Math.hypot(c, d) || Math.abs(item.height) || length,
  };
}

const along = (item: Geometry, x: number, y: number) => (x - item.x) * item.ux + (y - item.y) * item.uy;
const above = (item: Geometry, x: number, y: number) => -(x - item.x) * item.uy + (y - item.y) * item.ux;

/**
 * Hits transformed text in PDF coordinates, then follows only its contiguous line fragment.
 * The DOM text layer may supply a preferred index because it knows the font's exact ascent.
 */
export function pdfTextAt(items: TextItem[], x: number, y: number, preferredIndex?: number): PdfTextHit | null {
  const geometries = items.map(geometry).filter((item): item is Geometry => item !== null && item.width > 0 && item.item.str.length > 0);
  const under = geometries.find((item) => item.index === preferredIndex) ?? geometries
    .filter((item) => {
      const offset = along(item, x, y);
      const height = above(item, x, y);
      return offset >= -0.5 && offset <= item.width + 0.5 && height >= -item.height * 0.25 && height <= item.height * 0.95;
    })
    .sort((a, b) => Math.abs(above(a, x, y) - a.height * 0.35) / a.height
      - Math.abs(above(b, x, y) - b.height * 0.35) / b.height)[0];
  if (!under) return null;

  const line = geometries.filter((item) => item.ux * under.ux + item.uy * under.uy > 0.995
    && Math.abs(above(under, item.x, item.y)) <= Math.max(1, Math.min(item.height, under.height) * 0.25))
    .map((item) => ({ ...item, start: along(under, item.x, item.y) }))
    .sort((a, b) => a.start - b.start);
  const at = line.findIndex((item) => item.index === under.index);
  const separated = (left: typeof line[number], right: typeof line[number]) =>
    right.start - left.start - left.width > Math.max(12, Math.min(left.height, right.height) * 1.6);
  let first = at;
  let last = at;
  while (first > 0 && !separated(line[first - 1], line[first])) first -= 1;
  while (last + 1 < line.length && !separated(line[last], line[last + 1])) last += 1;

  const chars = Array.from(under.item.str);
  const share = Math.max(0, Math.min(0.999999, along(under, x, y) / under.width));
  const underCharacter = Math.min(chars.length - 1, Math.floor((under.item.dir === 'rtl' ? 1 - share : share) * chars.length));
  let context = '';
  let character = 0;
  for (let index = first; index <= last; index += 1) {
    const item = line[index];
    const previous = line[index - 1];
    const gap = previous ? item.start - previous.start - previous.width : 0;
    if (index > first && gap > Math.min(item.height, previous.height) * 0.15
      && !/\s$/.test(context) && !/^\s/.test(item.item.str)) context += ' ';
    if (item.index === under.index) {
      character = Array.from(context).length + underCharacter;
    }
    context += item.item.str;
  }
  let rowContext = '';
  let rowCharacter = 0;
  for (let index = 0; index < line.length; index += 1) {
    const item = line[index];
    const previous = line[index - 1];
    if (previous && item.start - previous.start - previous.width > Math.min(item.height, previous.height) * 0.15
      && !/\s$/.test(rowContext) && !/^\s/.test(item.item.str)) rowContext += ' ';
    if (item.index === under.index) rowCharacter = Array.from(rowContext).length + underCharacter;
    rowContext += item.item.str;
  }
  const normalized = (text: string, at: number): { text: string; offset: number } => {
    const full = normalizePdfText(text);
    const trimmed = full.trim();
    const leading = full.length - full.trimStart().length;
    const prefix = normalizePdfText(Array.from(text).slice(0, at).join(''));
    return { text: trimmed, offset: Math.max(0, Math.min(trimmed.length, prefix.length - leading)) };
  };
  const fragment = normalized(context, character);
  const row = normalized(rowContext, rowCharacter);
  return {
    index: under.index, baseline: under.y, word: pdfWordAt(context, character),
    context: fragment.text, contextOffset: fragment.offset,
    rowContext: row.text, rowContextOffset: row.offset,
  };
}

/** Both selection ends and the selected glyphs must belong to the actual clicked text span. */
export function selectedPdfWord(selection: Selection | null, clicked: HTMLElement | undefined, x: number, y: number): string {
  if (!selection || !clicked || selection.rangeCount !== 1 || selection.isCollapsed
    || !selection.anchorNode || !selection.focusNode
    || !clicked.contains(selection.anchorNode) || !clicked.contains(selection.focusNode)) return '';
  const selected = normalizePdfText(selection.toString()).trim();
  if (!selected || /\s/.test(selected) || !normalizePdfText(clicked.textContent ?? '').includes(selected)) return '';
  const overSelection = Array.from(selection.getRangeAt(0).getClientRects()).some((rect) =>
    x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1);
  return overSelection ? selected : '';
}
