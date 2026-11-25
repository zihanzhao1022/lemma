import { describe, expect, it } from 'vitest';
import { ResultBlock, ResultPaper } from '../../types';
import {
  bibNeeds,
  copiesOf,
  definitionsOf,
  diffLines,
  filesUsed,
  inverse,
  labelClashes,
  mapArguments,
  mergeThree,
  packagesOf,
  planFiles,
  preambleNeeds,
  syncState,
  withPreambleLines,
} from './carry';

const paper = (id: string, blocks: ResultBlock[], extra: Partial<ResultPaper> = {}): ResultPaper => ({ id, slug: id, title: id, authors: [], blocks, ...extra });

describe('attachments', () => {
  const source = '\\includegraphics[width=\\linewidth]{figs/acc}\n\\input{rows.tex} % {old.png}';
  it('finds the files a source names, with or without extension, not in comments', () => {
    expect(filesUsed(source, ['figs/acc.pdf', 'rows.tex', 'old.png'])).toEqual([
      { argument: 'figs/acc', name: 'figs/acc.pdf' },
      { argument: 'rows.tex', name: 'rows.tex' },
    ]);
  });

  it('copies what is missing, skips what is the same, and puts a clash in a folder', () => {
    const from = { id: 'a', slug: 'paper-a', files: ['figs/acc.pdf', 'rows.tex'], fileHashes: { 'figs/acc.pdf': 'h1', 'rows.tex': 'h2' } };
    expect(planFiles(source, from, { files: [], fileHashes: {} })).toEqual({
      copies: [
        { from: 'figs/acc.pdf', to: 'figs/acc.pdf' },
        { from: 'rows.tex', to: 'rows.tex' },
      ],
      mapping: {},
    });
    const plan = planFiles(source, from, { files: ['figs/acc.pdf', 'rows.tex'], fileHashes: { 'figs/acc.pdf': 'other', 'rows.tex': 'h2' } });
    expect(plan).toEqual({ copies: [{ from: 'figs/acc.pdf', to: 'paper-a/figs/acc.pdf' }], mapping: { 'figs/acc': 'paper-a/figs/acc' } });
    expect(mapArguments(source, plan.mapping)).toContain('{paper-a/figs/acc}');
    expect(mapArguments(mapArguments(source, plan.mapping), inverse(plan.mapping))).toBe(source);
  });
});

describe('preamble', () => {
  const from = String.raw`\documentclass{article}
\usepackage{times}
\usepackage[table]{xcolor}
\usepackage{booktabs,multirow}
\definecolor{best}{RGB}{200,230,201}
\newcommand{\ours}{\textsc{Ada}\xspace}
\newcommand\best[1]{\cellcolor{best}\textbf{#1}}
\def\unused#1{#1}
\newcolumntype{C}{>{\centering\arraybackslash}p{1cm}}
\DeclareMathOperator*{\argmax}{arg\,max}
\newenvironment{note}{\begin{quote}}{\end{quote}}`;
  it('reads definitions and packages', () => {
    expect(definitionsOf(from).map((item) => `${item.kind}:${item.name}`)).toEqual([
      'color:best',
      'command:ours',
      'command:best',
      'command:unused',
      'column:C',
      'command:argmax',
      'environment:note',
    ]);
    expect(packagesOf(from).map((item) => item.line)).toEqual(['\\usepackage{times}', '\\usepackage[table]{xcolor}', '\\usepackage{booktabs}', '\\usepackage{multirow}']);
  });

  it('brings the definitions a source uses, and those they use, that the target lacks', () => {
    const source = '\\begin{tabular}{lC}\\ours & \\best{91.2}\\end{tabular}';
    const needs = preambleNeeds(source, from, '\\documentclass{article}\n\\usepackage{booktabs}\n\\newcommand{\\ours}{Ours}');
    // \ours is the target's own; \best brings the colour it uses.
    expect(needs.definitions.map((item) => `${item.kind}:${item.name}`)).toEqual(['color:best', 'command:best', 'column:C']);
    expect(needs.packages.map((item) => [item.name, item.suggested])).toEqual([
      ['times', false],
      ['xcolor', true],
      ['multirow', true],
    ]);
  });

  it('adds lines at the end of the preamble under a note', () => {
    expect(withPreambleLines('\\documentclass{article}\n', ['\\usepackage{bm}'], 'from A')).toBe('\\documentclass{article}\n\n% from A\n\\usepackage{bm}\n');
    expect(withPreambleLines('x', [], 'n')).toBe('x');
  });
});

describe('labels and citations', () => {
  it('finds labels the target already has', () => {
    const target = paper('b', [{ id: 'x', kind: 'table', source: '\\label{tab:main}' }]);
    expect(labelClashes('\\label{tab:main}\\label{tab:new}', target)).toEqual(['tab:main']);
    expect(labelClashes('\\label{tab:main}', target, 'x')).toEqual([]);
  });
  it('brings the cited entries the target lacks', () => {
    const fromBib = '@article{a, title={A}}\n@inproceedings{b, title={B}}';
    expect(bibNeeds('\\citep{a,b} \\cite{c}', fromBib, '@misc{b, title={B2}}')).toEqual({ keys: ['a'], text: '@article{a, title={A}}' });
  });
});

describe('copies', () => {
  const home: ResultBlock = { id: 'h', kind: 'table', source: 'row 1\n{figs/acc}' };
  const papers = (homeSource: string, copySource: string, base: string) => {
    const a = paper('a', [{ ...home, source: homeSource }]);
    const b = paper('b', [{ id: 'c', kind: 'table', source: copySource, origin: { paper: 'a', block: 'h', base, files: { 'figs/acc': 'a/figs/acc' } } }]);
    return { all: [a, b], copy: b.blocks[0] };
  };
  it('tells whose side changed, through renamed files', () => {
    const local = 'row 1\n{a/figs/acc}';
    expect(syncState(papers(home.source!, local, local).copy, papers(home.source!, local, local).all)).toBe('synced');
    const behind = papers('row 2\n{figs/acc}', local, local);
    expect(syncState(behind.copy, behind.all)).toBe('behind');
    const ahead = papers(home.source!, 'row 3\n{a/figs/acc}', local);
    expect(syncState(ahead.copy, ahead.all)).toBe('ahead');
    const diverged = papers('row 2\n{figs/acc}', 'row 3\n{a/figs/acc}', local);
    expect(syncState(diverged.copy, diverged.all)).toBe('diverged');
    expect(syncState(diverged.copy, [diverged.all[1]])).toBe('orphan');
    expect(copiesOf('a', 'h', diverged.all).map((item) => item.block.id)).toEqual(['c']);
  });
});

describe('mergeThree', () => {
  const base = 'a\nb\nc\nd';
  it('takes changes made on one side', () => {
    expect(mergeThree(base, 'a\nB\nc\nd', 'a\nb\nc\nD')).toEqual({ text: 'a\nB\nc\nD', conflicts: 0 });
    expect(mergeThree(base, 'a\nb\nc\nd\ne', 'x\na\nb\nc\nd')).toEqual({ text: 'x\na\nb\nc\nd\ne', conflicts: 0 });
    expect(mergeThree(base, 'a\nc\nd', 'a\nb\nc\nd')).toEqual({ text: 'a\nc\nd', conflicts: 0 });
  });
  it('marks the same lines changed differently', () => {
    expect(mergeThree(base, 'a\nB1\nc\nd', 'a\nB2\nc\nd', { mine: 'here', theirs: 'there' })).toEqual({
      text: 'a\n<<<<<<< here\nB1\n=======\nB2\n>>>>>>> there\nc\nd',
      conflicts: 1,
    });
  });
  it('takes the same change once', () => {
    expect(mergeThree(base, 'a\nX\nc\nd', 'a\nX\nc\nd')).toEqual({ text: 'a\nX\nc\nd', conflicts: 0 });
  });
});

describe('diffLines', () => {
  it('marks lines only one side has', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
  });
});
