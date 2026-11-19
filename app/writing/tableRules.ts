/** The table blocks of a writing view's main.tex, and the edits their rules ask for (editor/results/table/rules.ts). */
import { Edit, readRules, ruleEdits } from '../../editor/results/table/rules';
import { bodyBlocks } from './articleBlocks';
import { readMarker } from './document';
import { lineStarts } from './pageMap';

export interface TableBlock {
  id: string;
  /** [from, to) of its code in main.tex, past its marker line. */
  from: number;
  to: number;
  /** Lines (0-based) [first, last) of its code. */
  lines: [number, number];
}

/** The table blocks of main.tex, in order. */
export function tableBlocks(body: string): TableBlock[] {
  const lines = body.split('\n');
  const starts = lineStarts(body);
  return bodyBlocks(body)
    .filter((block) => readMarker(lines[block.from - 1] ?? '')?.kind === 'table')
    .map((block) => ({
      id: block.id,
      from: starts[block.from] ?? body.length,
      to: block.to < starts.length ? starts[block.to] - 1 : body.length,
      lines: [block.from, block.to] as [number, number],
    }));
}

/** The table block whose code holds a line (0-based) of main.tex. */
export const tableBlockAt = (body: string, line: number): TableBlock | undefined =>
  tableBlocks(body).find((block) => line >= block.lines[0] && line < block.lines[1]);

/** What the rules of main.tex's tables change, as edits of main.tex. */
export function bodyRuleEdits(body: string): Edit[] {
  return tableBlocks(body).flatMap((block) => {
    const code = body.slice(block.from, block.to);
    if (!readRules(code)) return [];
    return ruleEdits(code).map((edit) => ({ from: edit.from + block.from, to: edit.to + block.from, insert: edit.insert }));
  });
}
