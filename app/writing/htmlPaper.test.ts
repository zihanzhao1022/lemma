import { describe, expect, it } from 'vitest';
import { citationText, numberPaper, paperStyle, parseBibRecords, referenceText } from './htmlPaper';
import { Context, parseBlocks, readDefinitions } from './latexHtml';

const parse = (src: string) => {
  const context: Context = { definitions: readDefinitions(''), labels: [] };
  return { elements: parseBlocks(src, 0, src.length, context), labels: context.labels };
};

const BIB = `@article{smith2020, author = {Smith, John and Lee, Ann and Kim, Bo}, title = {A {Great} Study}, journal = {J. Things}, year = 2020}
@inproceedings{lee2019, author = "Ann Lee", title = {Earlier}, booktitle = {Proc. X}, year = {2019}}`;

describe('paperStyle', () => {
  it('knows the common templates', () => {
    expect(paperStyle('\\documentclass[conference]{IEEEtran}')).toMatchObject({ template: 'ieee', columns: 2, font: 'times', citations: 'numeric' });
    expect(paperStyle('\\documentclass[11pt]{article}\n\\usepackage[review]{acl}', 'acl_natbib')).toMatchObject({ template: 'acl', columns: 2, citations: 'author-year' });
    expect(paperStyle('\\documentclass{article}\n\\usepackage{iclr2025_conference,times}', 'iclr2025_conference')).toMatchObject({ template: 'iclr', columns: 1 });
    expect(paperStyle('\\documentclass{article}\n\\usepackage{icml2025}')).toMatchObject({ template: 'icml', columns: 2 });
  });

  it('reads a plain article: its size, font, columns and margins', () => {
    expect(paperStyle('\\documentclass{article}')).toMatchObject({ template: 'article', columns: 1, font: 'cm', size: 10, textWidth: 345 });
    expect(paperStyle('\\documentclass[11pt,twocolumn]{article}\n\\usepackage{times}')).toMatchObject({ columns: 2, font: 'times', size: 11 });
    expect(paperStyle('\\documentclass{article}\n\\usepackage[margin=1in]{geometry}').textWidth).toBe(612 - 144);
  });

  it('reads citations by author and year for natbib styles, unless numbers are asked for', () => {
    expect(paperStyle('\\documentclass{article}', 'plainnat').citations).toBe('author-year');
    expect(paperStyle('\\documentclass{article}\n\\usepackage[numbers]{natbib}', 'plainnat').citations).toBe('numeric');
    expect(paperStyle('\\documentclass{article}', 'plain').citations).toBe('numeric');
  });
});

describe('parseBibRecords', () => {
  it('reads braced, quoted and bare fields', () => {
    const [first, second] = parseBibRecords(BIB);
    expect(first).toMatchObject({ key: 'smith2020', type: 'article', fields: { year: '2020', journal: 'J. Things', title: 'A {Great} Study' } });
    expect(second.fields.author).toBe('Ann Lee');
    expect(referenceText(first)).toBe('John Smith, Ann Lee, and Bo Kim. A Great Study. J. Things. 2020.');
  });
});

describe('numberPaper', () => {
  it('numbers headings, floats and equations in order, and gives labels their numbers', () => {
    const blocks = [
      parse('\\section{Intro}\\label{sec:intro}\nText \\cite{smith2020}.\n\\subsection{More}\nSee.'),
      parse('\\begin{figure}\\includegraphics{a}\\caption{A}\\label{fig:a}\\end{figure}'),
      parse('\\section*{Unnumbered}\n\\section{Method}\n\\begin{equation}x\\label{eq:x}\\end{equation}\\cite{lee2019,smith2020}'),
    ];
    const style = paperStyle('\\documentclass{article}');
    const numbering = numberPaper(blocks, style, parseBibRecords(BIB), 'unsrt');
    expect(blocks.flatMap((block) => block.elements).map((element) => numbering.numbers.get(element) ?? '-')).toEqual(['1', '-', '1.1', '-', '1', '-', '2', '1', '-']);
    expect(numbering.labels).toEqual({ 'sec:intro': '1', 'fig:a': '1', 'eq:x': '1' });
    // unsrt: in the order cited.
    expect(numbering.references.map((item) => item.key)).toEqual(['smith2020', 'lee2019']);
    expect(citationText('cite', ['lee2019', 'smith2020'], numbering, style)).toBe('[2, 1]');
  });

  it('numbers IEEE sections with Roman numerals and tables too', () => {
    const blocks = [parse('\\section{A}\n\\subsection{B}\n\\begin{table}\\caption{T}\\begin{tabular}{l}x\\end{tabular}\\end{table}')];
    const numbering = numberPaper(blocks, paperStyle('\\documentclass{IEEEtran}'), []);
    expect(blocks[0].elements.map((element) => numbering.numbers.get(element))).toEqual(['I', 'A', 'I']);
  });

  it('cites by author and year, sorted by author', () => {
    const blocks = [parse('\\citep{smith2020} and \\citet{lee2019}')];
    const style = paperStyle('\\documentclass{article}', 'plainnat');
    const numbering = numberPaper(blocks, style, parseBibRecords(BIB), 'plainnat');
    expect(numbering.references.map((item) => item.key)).toEqual(['lee2019', 'smith2020']);
    expect(citationText('citep', ['smith2020'], numbering, style)).toBe('(Smith et al., 2020)');
    expect(citationText('citet', ['lee2019'], numbering, style)).toBe('Lee (2019)');
    expect(citationText('citep', ['nope'], numbering, style)).toBe('(?)');
  });
});
