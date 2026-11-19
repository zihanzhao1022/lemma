/** The table blocks of a writing view's main.tex, and the edits their rules ask for (editor/results/table/rules.ts). */
import { Edit, readRules, ruleEdits } from '../../editor/results/table/rules';
import { bodyBlocks } from './articleBlocks';
import { readMarker, splitMain } from './document';
import { lineStarts } from './pageMap';

export interface TableBlock {
  id: string;
  /** [from, to) of its code in main.tex, past its marker line. */
  from: number;
  to: number;
  /** Lines (0-based) [first, last) of its code. */
  lines: [number, number];
}

/** The table blocks of main.tex (its preamble and all, or its body alone), in order. */
export function tableBlocks(main: string): TableBlock[] {
  const parts = splitMain(main);
  const body = parts ? parts.body : main;
  const at = parts?.bodyAt ?? 0;
  const line = (parts?.bodyLine ?? 1) - 1;
  const lines = body.split('\n');
  const starts = lineStarts(body);
  return bodyBlocks(body)
    .filter((block) => readMarker(lines[block.from - 1] ?? '')?.kind === 'table')
    .map((block) => ({
      id: block.id,
      from: at + (starts[block.from] ?? body.length),
      to: at + (block.to < starts.length ? starts[block.to] - 1 : body.length),
      lines: [line + block.from, line + block.to] as [number, number],
    }));
}

/** The table block whose code holds a line (0-based) of main.tex. */
export const tableBlockAt = (main: string, line: number): TableBlock | undefined =>
  tableBlocks(main).find((block) => line >= block.lines[0] && line < block.lines[1]);

/** What the rules of main.tex's tables change, as edits of main.tex. */
export function bodyRuleEdits(main: string): Edit[] {
  return tableBlocks(main).flatMap((block) => {
    const code = main.slice(block.from, block.to);
    if (!readRules(code)) return [];
    return ruleEdits(code).map((edit) => ({ from: edit.from + block.from, to: edit.to + block.from, insert: edit.insert }));
  });
}
