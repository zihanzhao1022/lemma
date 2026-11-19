import { describe, expect, it } from 'vitest';
import { ResultBlock, ResultPaper } from '../../types';
import { axisFor, chartHtml, findBlock, refsIn, resolveBlocks, tableHtml } from './blockHtml';

const TABLE = String.raw`\begin{table}[t]
\centering
\caption{Accuracy of the made-up methods.}\label{tab:main}
\begin{tabular}{lrrr}
\toprule
 & EM $\uparrow$ & F1 $\uparrow$ & Time (s) $\downarrow$ \\
\midrule
Method A & 22.4 & 31.5 & \textbf{2.4} \\
Method B & 27.1 & 36.2 & \underline{4.8} \\
\cmidrule{1-4}
Ours & \textbf{42.2} & \textbf{52.9} & \textcolor{red}{18.3} \\
\bottomrule
\end{tabular}
\end{table}`;

const block = (id: string, extra: Partial<ResultBlock> = {}): ResultBlock => ({ id, kind: 'table', source: TABLE, ...extra });
const paper = (blocks: ResultBlock[]): ResultPaper => ({ id: 'p', slug: 'p', title: 'Made-up', authors: [], blocks });
const pictureOf = async (b: ResultBlock) => (b.output ? `data:image/png;base64,${b.id}` : null);

describe('a table block as HTML', () => {
  const html = tableHtml(block('t1'), '\\documentclass{article}') ?? '';

  it('is a table of its own, its header the rows down to the first rule', () => {
    expect(html.startsWith('<table><thead>')).toBe(true);
    const head = /<thead>(.*?)<\/thead>/.exec(html)?.[1] ?? '';
    expect(head.match(/<tr\b/g)).toHaveLength(1);
    expect(head).toContain('<span class="n">EM <span');
    expect(/<tbody>(.*?)<\/tbody>/.exec(html)?.[1].match(/<tr\b/g)).toHaveLength(3);
  });

  it('keeps what the paper sets: bold, underline, colour and the rules', () => {
    expect(html).toContain('<b>2.4</b>');
    expect(html).toContain('<u>4.8</u>');
    expect(html).toContain('<span style="color:#ff0000">18.3</span>');
    // \toprule above the header, \midrule above the first row, \cmidrule above the last, \bottomrule below it.
    expect(html).toMatch(/<tr data-r="0" data-above="thick">/);
    expect(html).toMatch(/<tr data-r="1" data-row="Method A" data-above="thin">/);
    expect(html).toMatch(/<tr data-r="3" data-row="Ours" data-above="thin" data-below="thick">/);
  });

  it('writes the math as MathML', () => {
    expect(html).toContain('<math');
    expect(html).not.toContain('class="katex-html"');
  });

  it('names each cell by its row and its column, with a row label first and header cells over the columns', () => {
    expect(html).toMatch(/<th[^>]*data-row="Ours"[^>]*data-r="3" data-c="0"><span class="n">Ours<\/span><\/th>/);
    expect(html).toMatch(/<td[^>]*data-row="Ours"[^>]*data-col="EM"[^>]*data-r="3" data-c="1"/);
    expect(html).toMatch(/<td[^>]*data-row="Method A"[^>]*data-col="Time \(s\)"[^>]*data-r="1" data-c="3"/);
    expect(html).toMatch(/<th[^>]*data-col="F1"[^>]*data-r="0" data-c="2">/);
    expect(html).toContain('text-align:right');
  });

  it('is nothing for a block that has no table, or one the page cannot read', () => {
    expect(tableHtml(block('f1', { kind: 'figure', source: '\\begin{figure}\\includegraphics{a.pdf}\\end{figure}' }), '')).toBeNull();
    expect(tableHtml(block('u1', { source: '\\begin{table}\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\\end{table}' }), '')).toBeNull();
  });
});

describe('finding a block', () => {
  const blocks = [block('b1'), block('b2', { source: '\\begin{table}\\caption{Other}\\label{tab:other}\\end{table}', output: { pdf: 'x.pdf', width: 1, height: 1, labels: { 'tab:out': '{1}' } } })];
  const target = paper(blocks);

  it('goes by id, by a label of the compiled output, or by a \\label in the LaTeX', () => {
    expect(findBlock(target, 'b2')?.id).toBe('b2');
    expect(findBlock(target, 'tab:out')?.id).toBe('b2');
    expect(findBlock(target, 'tab:main')?.id).toBe('b1');
    expect(findBlock(target, 'tab:none')).toBeUndefined();
    expect(findBlock(target, '')).toBeUndefined();
  });

  it('lists the refs a slide names', () => {
    expect(refsIn('<lemma-block ref="tab:main"></lemma-block><p>x</p><lemma-block ref=\'b2\'/><lemma-block ref="tab:main">')).toEqual(['tab:main', 'b2']);
  });
});

describe('resolving the tags of a slide', () => {
  const target = paper([
    block('t1'),
    { id: 'f1', kind: 'figure', source: '\\begin{figure}\\includegraphics{a.pdf}\\caption{Curves.}\\label{fig:c}\\end{figure}', output: { pdf: 'f.pdf', width: 100, height: 80 } },
    { id: 'f2', kind: 'figure', source: '\\begin{figure}\\end{figure}' },
  ]);

  it('puts a table in place, with the steps that point at it', async () => {
    const out = await resolveBlocks('<div class="content"><lemma-block ref="tab:main" focus="tr[data-row=&quot;Ours&quot;]"></lemma-block><p>after</p></div>', target, pictureOf);
    expect(out).toMatch(/^<div class="content"><div class="block tbl" data-ref="tab:main" data-focus="tr\[data-row=&quot;Ours&quot;\]"><table>/);
    expect(out.endsWith('</table></div><p>after</p></div>')).toBe(true);
  });

  it('draws what is not a table as its picture, and says what it cannot show', async () => {
    const out = await resolveBlocks('<lemma-block ref="fig:c"/> <lemma-block ref="f2"></lemma-block> <lemma-block ref="gone"></lemma-block>', target, pictureOf);
    expect(out).toContain('<div class="block pic" data-ref="fig:c"><img src="data:image/png;base64,f1" alt="Curves."></div>');
    expect(out).toContain('<div class="block missing" data-ref="f2">');
    expect(out).toContain('<div class="block missing" data-ref="gone">');
  });

  it('draws a table the page cannot read as its picture', async () => {
    const odd = paper([{ id: 'u1', kind: 'table', source: '\\begin{table}\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\\end{table}', output: { pdf: 'u.pdf', width: 1, height: 1 } }]);
    expect(await resolveBlocks('<lemma-block ref="u1"></lemma-block>', odd, pictureOf)).toContain('<img src="data:image/png;base64,u1"');
  });

  it('leaves markup without tags as it is', async () => {
    expect(await resolveBlocks('<p>none</p>', target, pictureOf)).toBe('<p>none</p>');
  });
});

describe('a chart of a table column', () => {
  const chart = (given: Record<string, string>) => chartHtml(block('t1'), '\\documentclass{article}', given);
  const html = (given: Record<string, string>) => {
    const made = chart(given);
    return 'html' in made ? made.html : '';
  };

  it('draws a bar for each row with a number in the column, named by its row and column as the cells are', () => {
    const out = html({ col: 'EM' });
    expect(out.match(/class="row/g)).toHaveLength(3);
    expect(out).toContain('<div class="row" style="--v:22.4"><span class="lab">Method A</span>');
    expect(out).toContain('<span class="val" data-row="Method A" data-col="EM">22.4</span>');
    // The axis ends a little past the largest number, with a line at each step.
    expect(out).toContain('<div class="plot" style="--max:50;--lab:11cqw;--tail:6cqw">');
    expect(out).toContain('<i style="--x:40" data-t="40"></i>');
  });

  it('draws the row whose number is bold in the accent colour, or the one named', () => {
    expect(html({ col: 'EM' })).toContain('<div class="row ours" style="--v:42.2"><span class="lab">Ours</span>');
    expect(html({ col: 'EM', ours: 'Method B' })).toContain('<div class="row ours" style="--v:27.1">');
  });

  it('with a base row, marks it and the gain over it at a step, and lets both numbers travel', () => {
    const out = html({ col: 'em', base: 'Method B', step: '2' });
    expect(out).toContain('<div class="marker" data-step="2" style="--b:27.1"><em>Method B 27.1</em></div>');
    expect(out).toContain('<i class="gain" data-step="2"></i><span class="gainlab" data-step="2">+15.1</span>');
    expect(out).toContain('data-row="Ours" data-col="EM" data-move=""');
    expect(out).toContain('data-row="Method B" data-col="EM" data-move=""');
    expect(out).not.toContain('data-row="Method A" data-col="EM" data-move');
  });

  it('takes the rows asked for, in that order, a column by its number, and an axis end', () => {
    const out = html({ col: '3', rows: 'Ours; Method A', max: '30' });
    expect(out.match(/<span class="lab">([^<]*)</g)).toEqual(['<span class="lab">Ours<', '<span class="lab">Method A<']);
    expect(out).toContain('data-col="Time (s)"');
    expect(out).toContain('--max:30');
  });

  it('says what is wrong instead', () => {
    expect(chart({ col: 'BLEU' })).toEqual({ problem: 'no-column', column: 'BLEU' });
    expect(chart({ col: '0' })).toEqual({ problem: 'no-column', column: '0' });
    expect(chartHtml(block('f1', { kind: 'figure' }), '', { col: 'EM' })).toEqual({ problem: 'not-table' });
  });

  it('is put on a slide by its tag, next to blocks', async () => {
    const out = await resolveBlocks('<lemma-block ref="tab:main"></lemma-block><lemma-chart ref="tab:main" col="F1"></lemma-chart><lemma-chart ref="gone" col="F1">', paper([block('t1')]), pictureOf);
    expect(out.indexOf('class="block tbl"')).toBeLessThan(out.indexOf('class="block chart"'));
    expect(out).toContain('<div class="block chart" data-ref="tab:main" data-col="F1"><div class="plot"');
    expect(out).toContain('class="block missing" data-ref="gone"');
    expect(refsIn('<lemma-chart ref="tab:a" col="x"><lemma-block ref="tab:b">')).toEqual(['tab:b', 'tab:a']);
  });

  it('ends its axis at 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(axisFor(42.2)).toEqual({ max: 50, step: 10 });
    expect(axisFor(0.87)).toEqual({ max: 1, step: 0.2 });
    expect(axisFor(9.7)).toEqual({ max: 10, step: 2 });
    expect(axisFor(118)).toEqual({ max: 125, step: 25 });
  });
});
