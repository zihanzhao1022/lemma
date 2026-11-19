import { describe, expect, it } from 'vitest';
import { joinMain, markerLine } from './document';
import { tableBlockAt, tableBlocks } from './tableRules';

describe('table blocks of main.tex', () => {
  const table = '\\begin{table}\n\\begin{tabular}{lc}\nA & 1 \\\\\n\\end{tabular}\n\\end{table}';
  const main = joinMain('\\documentclass{article}\n', `${markerLine('t1', 'text')}\nText.\n\n${markerLine('t2', 'table')}\n${table}\n`);

  it('finds a table in the body, at its offsets and lines in main.tex', () => {
    const [block] = tableBlocks(main);
    expect(block.id).toBe('t2');
    expect(main.slice(block.from, block.to)).toBe(table);
    const lines = main.split('\n');
    expect(lines[block.lines[0]]).toBe('\\begin{table}');
    expect(lines[block.lines[1] - 1]).toBe('\\end{table}');
  });

  it('leaves the preamble and \\end{document} out', () => {
    const lines = main.split('\n');
    expect(tableBlockAt(main, 0)).toBeUndefined();
    expect(tableBlockAt(main, lines.indexOf('\\end{document}'))).toBeUndefined();
    expect(tableBlockAt(main, lines.indexOf('A & 1 \\\\'))?.id).toBe('t2');
  });
});
