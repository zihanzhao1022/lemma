import { inverseSearch } from '../../app/writing/sourceSearch';
import type { SourcePosition } from '../../app/writing/sourceMapping';

export interface BlockPdfText {
  word: string;
  context: string;
  rowContext?: string;
  contextOffset?: number;
  rowContextOffset?: number;
}

/** A block PDF can only navigate to that block's code, even when other blocks repeat its text. */
export function blockSourceLocation(source: string, click: BlockPdfText): SourcePosition | null {
  const found = inverseSearch({ 'main.tex': source }, [], {
    page: 1, x: 0, y: 0, pageWidth: 1,
    ...click, context: click.rowContext || click.context,
    contextOffset: click.rowContext ? click.rowContextOffset : click.contextOffset,
  }, ['main.tex'], {
    // Other cells may render macros (such as \alpha), so the PDF row need not match word for word.
    literalNumbers: /\\begin\s*\{(?:table\*?|tabular\*?|tabularx|longtable)\}/.test(source),
  });
  return found ? { line: found.line, start: found.start, end: found.end } : null;
}
