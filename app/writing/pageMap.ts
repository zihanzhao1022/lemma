/**
 * One region of the PDF paired with its source: from a click on a glyph to a source position, and from a source
 * position to the glyph a caret is drawn against. Positions are offsets into the file's text.
 */
import type { Mark } from './document';
import { Alignment, Spot, align, atomChars, caretAt, spotFor } from './pageAlign';
import { PageText, Region, regionForLine } from './pageRegions';
import { printedUnits } from './printed';

export interface RegionMap {
  region: Region;
  /** The region's source: offsets [from, to) of its lines in the file's text. */
  from: number;
  to: number;
  alignment: Alignment;
}

/** Offset of the start of each line: starts[n - 1] for line n. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

/** The 1-based line an offset is on. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) line += 1;
  return line;
}

export function mapRegion(text: string, marks: Mark[], pages: (PageText | undefined)[], file: number, line: number): RegionMap | null {
  const region = regionForLine(marks, pages, file, line);
  if (!region) return null;
  const starts = lineStarts(text);
  if (region.from > starts.length) return null;
  const from = starts[region.from - 1];
  const to = region.until < starts.length ? starts[region.until] - 1 : text.length;
  return { region, from, to, alignment: align(printedUnits(text, from, to), region.pieces) };
}

export type PageCaret = { offset: number } | { atom: { from: number; to: number } };

/** The source position (or atom) a click means, `offset` being the UTF-16 offset of the clicked glyph in its item. */
export function clickToCaret(map: RegionMap, item: number, offset: number, side: 'before' | 'after'): PageCaret | null {
  const { chars, units } = map.alignment;
  const index = chars.findIndex((char) => char.spot.item === item && offset >= char.spot.offset && offset < char.spot.offset + Math.max(1, char.spot.length));
  if (index < 0) return null;
  const caret = caretAt(map.alignment, index, side);
  if (!caret) return null;
  if ('atom' in caret) return { atom: { from: units[caret.atom].from, to: units[caret.atom].to } };
  return caret;
}

/** The glyph to draw a caret at `offset` against, and on which side of it. */
export function caretToSpot(map: RegionMap, offset: number): (Spot & { side: 'before' | 'after' }) | null {
  const found = spotFor(map.alignment, offset);
  if (!found) return null;
  const { spot } = map.alignment.chars[found.char];
  return spot.item < 0 ? null : { ...spot, side: found.side };
}

/** The first and last glyphs an atom starting at `offset` printed, for outlining it. */
export function atomRange(map: RegionMap, offset: number): [Spot, Spot] | null {
  const unit = map.alignment.units.findIndex((candidate) => candidate.kind === 'atom' && candidate.from === offset);
  if (unit < 0) return null;
  const range = atomChars(map.alignment, unit);
  if (!range) return null;
  return [map.alignment.chars[range[0]].spot, map.alignment.chars[range[1]].spot];
}
