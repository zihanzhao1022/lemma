import { describe, expect, it } from 'vitest';
import { Context, Element, Inline, TextRun, hasUnsupported, parseBlocks, parseInline, readDefinitions } from './latexHtml';

const context = (preamble = ''): Context => ({ definitions: readDefinitions(preamble), labels: [] });
const blocks = (src: string, preamble = '') => parseBlocks(src, 0, src.length, context(preamble));
const inline = (src: string, preamble = '') => parseInline(src, 0, src.length, context(preamble));
const text = (items: Inline[]) => items.map((item) => (item.kind === 'text' ? item.text : `[${item.kind}]`)).join('');

describe('parseInline', () => {
  it('reads text with escapes, dashes, quotes and ties, each character keeping its source', () => {
    const src = "50\\% gain --- ``so'' Fig.~3";
    const items = inline(src);
    expect(text(items)).toBe('50% gain — “so” Fig.\u00a03');
    const run = items[0] as TextRun;
    // "%" comes from "\%".
    expect(src.slice(run.starts[2], run.ends[2])).toBe('\\%');
    expect(src.slice(run.starts[9], run.ends[9])).toBe('---');
  });

  it('collapses spaces and line ends into one space, and drops comments', () => {
    expect(text(inline('one   two\nthree % a comment\n   four'))).toBe('one two three four');
  });

  it('styles emphasis and bold, also nested and by switches inside a group', () => {
    const items = inline('a \\emph{b \\textbf{c}} {\\bfseries d} e') as TextRun[];
    expect(items.map((item) => [item.text, item.styles.sort().join()])).toEqual([
      ['a ', ''],
      ['b ', 'em'],
      ['c', 'bf,em'],
      [' ', ''],
      ['d', 'bf'],
      [' e', ''],
    ]);
  });

  it('keeps math, citations, references, links and footnotes as atoms', () => {
    const src = 'Let $x^2$ hold~\\cite[p.~3]{a, b} (see \\eqref{eq:1}) at \\url{https://x.org}\\footnote{A \\emph{note}.}.';
    const items = inline(src);
    expect(text(items)).toBe('Let [math] hold\u00a0[cite] (see [ref]) at [link][footnote].');
    const cite = items.find((item) => item.kind === 'cite');
    expect(cite).toMatchObject({ keys: ['a', 'b'], post: 'p.~3', command: 'cite' });
    expect(src.slice(cite!.kind === 'cite' ? cite!.from : 0, cite!.kind === 'cite' ? cite!.to : 0)).toBe('\\cite[p.~3]{a, b}');
    expect(items.find((item) => item.kind === 'math')).toMatchObject({ tex: 'x^2', display: false });
  });

  it('puts accents on letters', () => {
    expect(text(inline("Erd\\H{o}s and G\\\"odel and Fran\\c{c}ois"))).toBe('Erdős and Gödel and François');
  });

  it('shows a preamble macro as its text, and an unknown command by its argument', () => {
    expect(text(inline('Our \\method{} wins and \\unknown{shown} too', '\\newcommand{\\method}{\\textsc{Ada}}'))).toBe('Our [raw] wins and [raw] too');
    const items = inline('Our \\method{} wins', '\\newcommand{\\method}{\\textsc{Ada}}');
    expect(items.find((item) => item.kind === 'raw')).toMatchObject({ text: 'Ada' });
  });

  it('records labels set in text, for the numbering', () => {
    const own = context();
    parseInline('Text.\\label{sec:a} More.', 0, 24, own);
    expect(own.labels).toEqual([{ label: 'sec:a', at: 5 }]);
  });
});

describe('parseBlocks', () => {
  it('reads headings, paragraphs split by blank lines, and display math', () => {
    const src = '\\section{Intro}\\label{sec:intro}\nFirst line\nsame paragraph.\n\nSecond.\n\\begin{equation}\\label{eq:a} a=b \\end{equation}\nAfter.';
    const found = blocks(src);
    expect(found.map((item) => item.kind)).toEqual(['heading', 'paragraph', 'paragraph', 'equation', 'paragraph']);
    expect(found[3]).toMatchObject({ kind: 'equation', numbered: true, labels: ['eq:a'], tex: ' a=b ' });
    expect(text((found[1] as Extract<Element, { kind: 'paragraph' }>).content)).toBe('First line same paragraph.');
  });

  it('reads a figure: its pictures with their widths, caption and label', () => {
    const found = blocks('\\begin{figure*}[t]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{figs/a.pdf}\n\\caption{The \\emph{result}.}\\label{fig:a}\n\\end{figure*}');
    expect(found[0]).toMatchObject({ kind: 'figure', wide: true, labels: ['fig:a'], captionFirst: false, graphics: [{ path: 'figs/a.pdf', width: { share: 0.8 } }] });
  });

  it('reads a booktabs table: rules, cells, spans and the caption above it', () => {
    const src = '\\begin{table}\n\\caption{Scores.}\n\\begin{tabular}{lcc}\n\\toprule\nMethod & A & B \\\\\n\\midrule\nOurs & \\textbf{1.0} & \\multicolumn{1}{r}{2} \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}';
    const [table] = blocks(src);
    if (table.kind !== 'table') throw new Error('not a table');
    expect(table.captionFirst).toBe(true);
    expect(table.rows.map((row) => row.cells.map((cell) => text(cell.content)))).toEqual([
      ['Method', 'A', 'B'],
      ['Ours', '1.0', '2'],
    ]);
    expect(table.rows[0]).toMatchObject({ above: 'thick' });
    expect(table.rows[1]).toMatchObject({ above: 'thin', below: 'thick' });
    expect(table.rows[1].cells.map((cell) => cell.align)).toEqual(['l', 'c', 'r']);
  });

  it('reads lists, theorems and quotes with what is inside them', () => {
    const found = blocks('\\begin{itemize}\n\\item One.\n\\item Two $x$.\n\\end{itemize}\n\\begin{theorem}[Main]\nIt holds.\n\\end{theorem}');
    expect(found[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(found[0].kind === 'list' && found[0].items.map((item) => item.children.length)).toEqual([1, 1]);
    expect(found[1]).toMatchObject({ kind: 'environment', name: 'theorem' });
  });

  it('marks what it cannot show as a page', () => {
    const found = blocks('Text.\n\n\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}');
    expect(hasUnsupported(found)).toBe(true);
    expect(hasUnsupported(blocks('Just text.'))).toBe(false);
  });

  it('gives positions in the whole text when given a stretch of it', () => {
    const src = 'XXXX\\section{A}\nBody.';
    const found = parseBlocks(src, 4, src.length, context());
    expect(found[0]).toMatchObject({ kind: 'heading', from: 4 });
    const body = found[1];
    expect(body.kind === 'paragraph' && (body.content[0] as TextRun).starts[0]).toBe(src.indexOf('Body'));
  });
});

describe('readDefinitions', () => {
  it('reads text and math macros and theorem names', () => {
    const found = readDefinitions('\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\|#1\\|}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}\n\\newtheorem{lemma}[theorem]{Lemma}');
    expect(found.math).toMatchObject({ '\\R': '\\mathbb{R}', '\\norm': '\\|#1\\|', '\\argmax': '\\operatorname*{arg\\,max}' });
    expect(found.text.R).toBe('\\mathbb{R}');
    expect(found.text.norm).toBeUndefined();
    expect(found.theorems.lemma).toEqual({ title: 'Lemma', counter: 'theorem', numbered: true });
  });
});
