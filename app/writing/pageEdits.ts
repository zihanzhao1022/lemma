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
 * What was typed between where the caret was in the PDF on screen (`from`) and where it is now (`to`), as it will
 * print: shown at the caret until TeX has set it. Nothing for a new paragraph or much text (not mere typing).
 */
export function typedSince(text: string, from: number | null, to: number): string {
  if (from === null || to <= from || to - from > 120) return '';
  const typed = text.slice(from, to);
  if (typed.includes('\n')) return '';
  return typed.replace(/\\([%&$#_{}])/g, '$1').replace(/~/g, ' ').replace(/\\textbackslash\{\}/g, '\\');
}
