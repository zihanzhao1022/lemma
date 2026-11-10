import { describe, expect, it } from 'vitest';
import { findSourceWord, inverseSearch } from './sourceSearch';
import { Mark, parseMarks, withMarks } from './document';

const hit = (word: string, context = word) => ({ page: 1, x: 100, y: 650, baseline: 647, pageWidth: 612, word, context });
const mark: Mark = { kind: 'L', line: 1, page: 1, x: 72, y: 700, width: 450 };

describe('PDF inverse text search', () => {
  it('finds a heading with no position marks, including when there is no running text', () => {
    expect(inverseSearch({ 'main.tex': '\\section{Evaluation Protocol}' }, [], hit('Evaluation')))
      .toEqual({ file: 'main.tex', line: 1, start: 9, end: 19 });
  });

  it('finds the title in the preamble rather than unrelated body text', () => {
    const sources = { 'main.tex': 'This study compares baselines.', 'preamble.tex': '\\title{A Study of Efficient Adapters}' };
    expect(inverseSearch(sources, [mark], hit('Study', 'A Study of Efficient Adapters')))
      .toEqual({ file: 'preamble.tex', line: 1, start: 9, end: 14 });
  });

  it('uses the PDF line to distinguish repeated words on one long source line', () => {
    const source = 'Our method improves accuracy. Baseline method uses fewer parameters. Another method costs more.';
    const at = source.indexOf('method', source.indexOf('Baseline'));
    expect(inverseSearch({ 'main.tex': source }, [mark], hit('method', 'Baseline method uses fewer parameters.')))
      .toEqual({ file: 'main.tex', line: 1, start: at, end: at + 6 });
  });

  it('ignores comment text, command names, labels, references and file names', () => {
    const lines = ['% accuracy', '\\label{accuracy}', '\\ref{accuracy} \\input{accuracy}', '\\accuracy{The measured accuracy improves.}'];
    const at = lines[3].lastIndexOf('accuracy');
    expect(findSourceWord(lines, 1, 4, 'accuracy', 'The measured accuracy improves.'))
      .toEqual({ line: 4, start: at, end: at + 8 });
  });

  it('normalizes source ligatures and PDF ligatures while preserving original columns', () => {
    expect(findSourceWord(['The eﬃcient method.'], 1, 1, 'efficient'))
      .toEqual({ line: 1, start: 4, end: 11 });
    expect(findSourceWord(['The efficient method.'], 1, 1, 'eﬃcient'))
      .toEqual({ line: 1, start: 4, end: 13 });
  });

  it('finds discretionary hyphens, formatting commands and non-ASCII text', () => {
    expect(findSourceWord(['An ef\\-ficient method.'], 1, 1, 'efficient'))
      .toEqual({ line: 1, start: 3, end: 14 });
    expect(findSourceWord(['\\textbf{性能比较}'], 1, 1, '性能'))
      .toEqual({ line: 1, start: 8, end: 10 });
    expect(findSourceWord(['Adapter\\textbf{s} work.'], 1, 1, 'Adapters'))
      .toEqual({ line: 1, start: 0, end: 16 });
  });

  it('opens an included .tex file and disambiguates identical text using its marks', () => {
    const sources = { 'main.tex': 'The accuracy improves.', 'files/sections/results.tex': 'The accuracy improves.' };
    expect(inverseSearch(sources, [{ ...mark, file: 1 }], hit('accuracy'), ['main.tex', 'files/sections/results.tex']))
      .toEqual({ file: 'files/sections/results.tex', line: 1, start: 4, end: 12 });
  });

  it('uses surrounding text for a generated section number with no literal spelling', () => {
    expect(inverseSearch({ 'main.tex': '\\section{Evaluation Protocol}\nA table contains 1 example.' }, [], hit('1', '1 Evaluation Protocol')))
      .toEqual({ file: 'main.tex', line: 1, start: 9, end: 19 });
  });

  it('does not send a global word search into an unrelated longer word', () => {
    expect(inverseSearch({ 'main.tex': 'Another example.' }, [], hit('the'))).toBeNull();
  });

  it('uses context for generated numbers even when an unrelated numeric literal is in the marked range', () => {
    expect(inverseSearch({ 'main.tex': '\\section{Evaluation Protocol}\nA table contains 1 example.' }, [{ ...mark, line: 2 }], hit('1', '1 Evaluation Protocol')))
      .toEqual({ file: 'main.tex', line: 1, start: 9, end: 19 });
    expect(inverseSearch({ 'files/rows.tex': 'Numeric & 12 \\\\' }, [], hit('12', 'Numeric 12'))?.file).toBe('files/rows.tex');
  });

  it('keeps the positional fallback for a click in a figure without extractable text', () => {
    expect(inverseSearch({ 'main.tex': '\\includegraphics{plot}' }, [mark], hit('', '')))
      .toEqual({ file: 'main.tex', line: 1 });
    expect(inverseSearch({ 'main.tex': '' }, [], hit('', ''))).toBeNull();
  });

  it('keeps a HarmBench table-header click inside its own table despite a better matching caption elsewhere', () => {
    const lines = [
      '\\begin{table}',
      '\\caption{Method HarmBench AdvBench results.}',
      '\\end{table}',
      '',
      '\\begin{table*}',
      '\\begin{tabular}{lcc}',
      'Method & \\multicolumn{1}{c}{HarmBench} & AdvBench \\\\',
      'Ours & 80 & 90 \\\\',
      '\\end{tabular}',
      '\\caption{Our main results.}',
      '\\end{table*}',
    ];
    const marks: Mark[] = [
      { ...mark, kind: 'B', line: 5, y: 700 },
      { ...mark, kind: 'E', line: 11, y: 500 },
    ];
    expect(inverseSearch({ 'main.tex': lines.join('\n') }, marks, hit('HarmBench', 'Method HarmBench AdvBench')))
      .toEqual({ file: 'main.tex', line: 7, start: lines[6].indexOf('HarmBench'), end: lines[6].indexOf('HarmBench') + 9 });
  });

  it('uses adjacent header cells to distinguish a header from its own caption', () => {
    const lines = [
      '\\begin{table}',
      '\\caption{HarmBench results for all models.}',
      '\\begin{tabular}{lcc}',
      'Method & \\multicolumn{1}{c}{\\textbf{HarmBench}} & AdvBench \\\\',
      '\\end{tabular}',
      '\\end{table}',
    ];
    const marks: Mark[] = [{ ...mark, kind: 'B', line: 1, y: 700 }, { ...mark, kind: 'E', line: 6, y: 500 }];
    expect(inverseSearch({ 'main.tex': lines.join('\n') }, marks, { ...hit('HarmBench'), rowContext: 'Method HarmBench AdvBench' })?.line).toBe(4);
  });

  it('searches only the row fragments input by the clicked float', () => {
    const main = '\\begin{table}\n\\input{tables/../rows}\n\\caption{Ablations.}\n\\end{table}';
    const sources = {
      'main.tex': main,
      'files/rows.tex': '\\multicolumn{2}{c}{\\multirow{2}{*}{HarmBench}} \\\\',
      'files/other.tex': '\\caption{HarmBench results.}',
    };
    const marks: Mark[] = [{ ...mark, kind: 'B', line: 1, y: 700 }, { ...mark, kind: 'E', line: 4, y: 500 }];
    expect(inverseSearch(sources, marks, hit('HarmBench'))?.file).toBe('files/rows.tex');
    expect(inverseSearch({ ...sources, 'files/rows.tex': 'Other rows.' }, marks, hit('HarmBench'))?.file).toBe('main.tex');
  });
});

describe('position marks for included files', () => {
  it('writes stable file IDs without adding source lines, and reads them back', () => {
    expect(withMarks('First paragraph.\nSecond paragraph.', 2))
      .toBe('\\leavevmode\\galleytextat{2}{1}First paragraph.\n\\leavevmode\\galleytextat{2}{2}Second paragraph.');
    expect(parseMarks('L 2 1 4736286 38427457 229.5pt 2')[0]).toMatchObject({ line: 2, page: 1, file: 2 });
    expect(parseMarks('L 2 1 4736286 38427457 229.5pt 0')[0].file).toBeUndefined();
  });
});
