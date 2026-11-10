/** Where each block of a paper is in its article's main.tex, and the article's position marks as stored. */
import { stripComments } from '../../editor/tex/document';
import type { ResultArticle } from '../../types';
import { Mark, readMarker } from './document';

export type ArticleBlock = ResultArticle['blocks'][number];
export type PackedMark = ResultArticle['marks'][number];

const HEADING = /^\s*\\(?:section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\]\s*)?\{(.*)\}/;

/** A heading's title as it prints, roughly: without commands, braces and math signs. */
const plainTitle = (title: string): string => title.replace(/\\[A-Za-z]+\s*/g, '').replace(/[{}$~]/g, ' ').replace(/\s+/g, ' ').trim();

/** The blocks of a main.tex: each block's lines (its marker line first, up to the next block's) and its first heading. */
export function bodyBlocks(body: string): ArticleBlock[] {
  const lines = body.replace(/\n$/, '').split('\n');
  const blocks: ArticleBlock[] = [];
  lines.forEach((line, index) => {
    const marker = readMarker(line);
    if (marker) {
      const last = blocks[blocks.length - 1];
      if (last) last.to = index;
      blocks.push({ id: marker.id, from: index + 1, to: lines.length });
      return;
    }
    const last = blocks[blocks.length - 1];
    const heading = HEADING.exec(stripComments(line));
    if (last && heading && last.heading === undefined) {
      const title = plainTitle(heading[1]);
      if (title) last.heading = title;
    }
  });
  // A block ends at its last line of code, not at the empty line before the next block.
  for (const block of blocks) while (block.to > block.from && !lines[block.to - 1].trim()) block.to -= 1;
  return blocks;
}

/** The lines of the headings in a block of a main.tex (\\section down to \\paragraph), in order. */
export function blockHeadingLines(body: string, block: ArticleBlock): number[] {
  const lines = body.split('\n');
  const found: number[] = [];
  for (let line = block.from; line <= block.to; line += 1) if (HEADING.test(stripComments(lines[line - 1] ?? ''))) found.push(line);
  return found;
}

export const packMarks = (marks: Mark[]): PackedMark[] =>
  marks.map((mark) => {
    const packed: PackedMark = [mark.kind, mark.line, mark.page, mark.x, mark.y, mark.width];
    return mark.file ? [...packed, mark.file] : packed;
  });

export const unpackMarks = (packed: PackedMark[]): Mark[] =>
  packed.map(([kind, line, page, x, y, width, file]) => ({ kind: kind as Mark['kind'], ...(file ? { file } : {}), line, page, x, y, width }));

