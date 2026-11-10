/**
 * Typing on the PDF, as changes to the LaTeX: what typed text becomes, what Backspace and Delete remove, and
 * where the arrow keys move the caret. All of it works on the printed units of the source (printed.ts), so
 * markup is stepped over, atoms (math, citations, references) go as a whole and table separators stay.
 */
import type { PrintedUnit } from './printed';

const ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '^': '\\^{}',
  '~': '\\~{}',
};

/** Typed text as LaTeX that prints it; `previous` is the source character before the caret (for quotes). */
export function escapeTyped(text: string, previous = ''): string {
  let out = '';
  let before = previous;
  for (const char of text) {
    if (char === '"') out += before === '' || /\s|[([{]/.test(before) ? '``' : "''";
    else out += ESCAPES[char] ?? char;
    before = char;
  }
  return out;
}

export interface Removal {
  from: number;
  to: number;
}

const removable = (unit: PrintedUnit | undefined): Removal | null => (unit && unit.kind !== 'separator' ? { from: unit.from, to: unit.to } : null);

/** The source Backspace removes: the printed unit before the caret, unless it is a table separator. */
export function deleteBefore(units: PrintedUnit[], caret: number): Removal | null {
  let before: PrintedUnit | undefined;
  for (const unit of units) if (unit.to <= caret) before = unit;
  return removable(before);
}

/** The source Delete removes: the printed unit after the caret, unless it is a table separator. */
export function deleteAfter(units: PrintedUnit[], caret: number): Removal | null {
  return removable(units.find((unit) => unit.from >= caret));
}

/** The caret one printed unit to the left (-1) or right (1); it stays at either end. */
export function moveCaret(units: PrintedUnit[], caret: number, direction: -1 | 1): number {
  if (direction < 0) {
    let before: PrintedUnit | undefined;
    for (const unit of units) if (unit.to <= caret) before = unit;
    return before ? before.from : caret;
  }
  const after = units.find((unit) => unit.from >= caret);
  return after ? after.to : caret;
}

/**
 * The source between `from` and `to` with the printed units in it taken out, as one change: what Backspace would
 * remove unit by unit, so markup (braces, commands, table separators) stays and the LaTeX stays valid. Null when
 * nothing printed is in the range.
 */
export function removeRange(source: string, units: PrintedUnit[], from: number, to: number): { from: number; to: number; insert: string } | null {
  const inside = units.filter((unit) => unit.kind !== 'separator' && unit.from >= from && unit.to <= to);
  if (inside.length === 0) return null;
  const start = inside[0].from;
  const end = inside[inside.length - 1].to;
  let insert = '';
  let at = start;
  for (const unit of inside) {
    insert += source.slice(at, unit.from);
    // A line break before a comment line stays, so the comment (or a block's marker) keeps its own line.
    if (unit.kind === 'space' && unit.text !== '' && /\n/.test(source.slice(unit.from, unit.to)) && /^[ \t]*%/.test(source.slice(unit.to))) insert += '\n';
    at = unit.to;
  }
  return { from: start, to: end, insert };
}

const wordy = (unit: PrintedUnit) => unit.kind === 'char' && /[\p{L}\p{N}\p{M}'’-]/u.test(unit.text);

/**
 * The caret a word to the left (-1) or right (1), as Alt+arrow moves it: past the spaces and punctuation next to it,
 * then to the word's far end. An atom is a word of its own; a table separator stops it.
 */
export function moveWord(units: PrintedUnit[], caret: number, direction: -1 | 1): number {
  const order = direction < 0 ? units.filter((unit) => unit.to <= caret).reverse() : units.filter((unit) => unit.from >= caret);
  let index = 0;
  const edge = (unit: PrintedUnit) => (direction < 0 ? unit.from : unit.to);
  while (index < order.length && order[index].kind !== 'separator' && !wordy(order[index]) && order[index].kind !== 'atom') index += 1;
  if (index >= order.length) return order.length > 0 && order[order.length - 1].kind !== 'separator' ? edge(order[order.length - 1]) : caret;
  if (order[index].kind === 'separator') return index > 0 ? edge(order[index - 1]) : caret;
  if (order[index].kind === 'atom') return edge(order[index]);
  while (index + 1 < order.length && wordy(order[index + 1])) index += 1;
  return edge(order[index]);
}

/**
 * What was typed between where the caret was in the PDF on screen (`from`) and where it is now (`to`), as it will
 * print: shown at the caret until TeX has set it. Nothing for a new paragraph or much text (not mere typing).
 */
export function typedSince(text: string, from: number | null, to: number): string {
  if (from === null || to <= from || to - from > 120) return '';
  const typed = text.slice(from, to);
  if (typed.includes('\n')) return '';
  return typed.replace(/\\([%&$#_{}])/g, '$1').replace(/~/g, ' ').replace(/\\textbackslash\{\}/g, '\\');
}

/**
 * What was typed at the caret since `then` (the text a PDF on screen was compiled from), when that is the only
 * change: the text `now` inserted ending at `caret`, as it prints. Nothing otherwise (see typedSince).
 */
export function typedSinceText(then: string, now: string, caret: number): string {
  if (now.length <= then.length) return '';
  const inserted = now.length - then.length;
  const from = caret - inserted;
  if (from < 0 || now.slice(0, from) !== then.slice(0, from) || now.slice(caret) !== then.slice(from)) return '';
  return typedSince(now, from, caret);
}

/** A unit as compared across two versions of a text: what it prints, an atom or separator by its source. */
const token = (unit: PrintedUnit, source: string): string =>
  unit.kind === 'char' ? `c${unit.text}` : unit.kind === 'space' ? ' ' : `${unit.kind}${source.slice(unit.from, unit.to)}`;

export interface PrintedChange {
  /** The units of the old text the change replaced: indices [from, to). */
  from: number;
  to: number;
  /** What it put in their place, as it prints; null when that is more than text (an atom, a separator). */
  inserted: string | null;
  /** Where the change starts and ends in the new text. */
  start: number;
  end: number;
}

/**
 * How what a stretch of text prints changed, as one replacement: the units of `before` (from `beforeSource`) that
 * went, and what `after` (from `afterSource`) prints in their place. Markup that changed but prints nothing is not
 * a change. With `caret` (in `afterSource`), the change reaches it: typing "all" over "full" puts in "all", not
 * "a" before a kept "ll". Null when both print the same.
 */
export function printedChange(before: PrintedUnit[], beforeSource: string, after: PrintedUnit[], afterSource: string, caret?: number): PrintedChange | null {
  const old = before.map((unit) => token(unit, beforeSource));
  const now = after.map((unit) => token(unit, afterSource));
  const maxHead = caret === undefined ? now.length : after.filter((unit) => unit.to <= caret).length;
  const maxTail = caret === undefined ? now.length : after.filter((unit) => unit.from >= caret).length;
  let head = 0;
  while (head < old.length && head < now.length && head < maxHead && old[head] === now[head]) head += 1;
  let tail = 0;
  while (tail < old.length - head && tail < now.length - head && tail < maxTail && old[old.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
  if (head === old.length && head === now.length) return null;
  const put = after.slice(head, after.length - tail);
  const inserted = put.every((unit) => unit.kind === 'char' || unit.kind === 'space') ? put.map((unit) => unit.text).join('') : null;
  const start = head > 0 ? after[head - 1].to : put[0]?.from ?? after[head]?.from ?? 0;
  const end = put.length > 0 ? put[put.length - 1].to : start;
  return { from: head, to: old.length - tail, inserted, start, end };
}
