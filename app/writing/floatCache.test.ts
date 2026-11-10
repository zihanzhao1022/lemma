import { describe, expect, it } from 'vitest';
import { cacheableFloats, captureSource, withCachedFloats } from './floatCache';

const table = String.raw`%% galley-block blk-1 table
\begin{table*}[t]
\centering
\small
\resizebox{\linewidth}{!}{%
\begin{tabular}{lc}
a & \cellcolor{red!20}1 \\
\end{tabular}%
}
\caption{Scores \ref{x}.}
\label{tab:a}
\end{table*}`;

describe('cacheableFloats', () => {
  it('finds the boxes of a table float, outermost first', () => {
    const [float] = cacheableFloats(table);
    expect(float.wide).toBe(true);
    expect(float.units).toHaveLength(1);
    expect(table.slice(float.units[0].from, float.units[0].to)).toMatch(/^\\resizebox\{\\linewidth\}\{!\}\{%[\s\S]*\\end\{tabular\}%\n\}$/);
  });

  it('finds several tabulars, and leaves out floats it cannot cache', () => {
    const two = '\\begin{table}\n\\begin{tabular}{l}a\\end{tabular}\\quad\\begin{tabular}{l}b\\end{tabular}\n\\caption{c}\\end{table}';
    expect(cacheableFloats(two)[0].units).toHaveLength(2);
    expect(cacheableFloats('\\begin{table}\\begin{tabular}{l}a\\footnote{n}\\end{tabular}\\end{table}')).toEqual([]);
    expect(cacheableFloats('\\begin{table}\\includegraphics{x}\\begin{tabular}{l}a\\end{tabular}\\end{table}')).toEqual([]);
    expect(cacheableFloats('% \\begin{table}\\begin{tabular}{l}a\\end{tabular}\\end{table}')).toEqual([]);
    expect(cacheableFloats('\\begin{figure}\\begin{tabular}{l}a\\end{tabular}\\end{figure}')).toEqual([]);
  });

  it('sets up the float without its caption and label, each box captured', () => {
    const [float] = cacheableFloats(table);
    const source = captureSource(table, float);
    expect(source).not.toMatch(/\\caption|\\label/);
    expect(source).toContain('\\lemmacapture{\\resizebox{\\linewidth}');
    expect(source).toContain('\\small');
  });

  it('leaves a float not cached yet as it is', () => {
    expect(withCachedFloats(table, '\\documentclass{article}', undefined)).toEqual({ body: table, files: {}, missing: 1 });
  });
});
