import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ResultPaper } from '../../types';
import { blocksOfBody, commentAt, mainCandidates, metadataOf, plainText, projectPaper, replaceContent, splitDocument } from './project';
import { expandZips, unzip, wrapperOf } from './zip';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (data: Uint8Array): string => new TextDecoder().decode(data);

/** A made-up Overleaf project: main.tex with a section in its own file, macros, a .bib and a figure. */
const MAIN = String.raw`% A made-up paper.
\documentclass[11pt]{article}
\usepackage{graphicx}
\usepackage{natbib}
\input{macros}
\title{A Made-up Study of Things\thanks{Work done while made up.}}
\author{Ada Example \\ Made-up University \\ \texttt{ada@example.org} \And Bo Sample \\ Elsewhere}
\begin{document}
\maketitle
\begin{abstract}
We study made-up things.
\end{abstract}
\input{sections/intro}
\section{Results}
Our made-up method works~\citep{doe2020}.
\begin{table}[t]
\centering
\begin{tabular}{lc} A & 1 \\ \end{tabular}
\caption{Made-up numbers.}\label{tab:main}
\end{table}
More words, 50\% of them.
% \begin{figure} only a comment
\begin{figure*}
\includegraphics{figures/plot}
\caption{A made-up plot.}
\end{figure*}
\appendix
\section{More}
Extra.
\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
`;

const project = (): Record<string, Uint8Array> => ({
  'main.tex': encode(MAIN),
  'sections/intro.tex': encode('\\section{Introduction}\nMade-up introduction.\n\\subsection{Motivation}\nWhy it matters.\n'),
  'macros.tex': encode('\\newcommand{\\ours}{Ours}\n'),
  'refs.bib': encode('@article{doe2020, title={Made-up}, author={Doe, Jane}, year={2020}}\n'),
  'figures/plot.pdf': new Uint8Array([1, 2, 3]),
  'notes/other.tex': encode('\\section{Not a document}\n'),
});

describe('a LaTeX project as a paper', () => {
  it('finds the main .tex: a whole document, least deep, main.tex first', () => {
    expect(mainCandidates(project())).toEqual(['main.tex']);
    const two = { ...project(), 'paper.tex': encode('\\documentclass{article}\n\\begin{document}\nX\n\\end{document}\n'), 'deep/main.tex': encode(MAIN) };
    expect(mainCandidates(two)).toEqual(['main.tex', 'paper.tex', 'deep/main.tex']);
  });

  it('reads comments, the preamble and the body as TeX does', () => {
    expect(commentAt('50\\% done % a note')).toBe(10);
    expect(commentAt('\\\\% after a line break')).toBe(2);
    const document = splitDocument('\\documentclass{article}\n% \\begin{document} not yet\n\\begin{document}\nHello.\n\\end{document}\nafter');
    expect(document?.preamble).toBe('\\documentclass{article}\n% \\begin{document} not yet\n');
    expect(document?.body.trim()).toBe('Hello.');
  });

  it('takes the title and the authors, without notes and affiliations', () => {
    expect(metadataOf(MAIN)).toEqual({ title: 'A Made-up Study of Things', authors: ['Ada Example', 'Bo Sample'] });
    expect(plainText('A~\\textbf{bold} $x$ \\\\ line')).toBe('A bold x line');
  });

  it('cuts the text at sections and the abstract, each figure and table a block of its own', async () => {
    const paper = await projectPaper(project(), 'main.tex');
    expect(paper).not.toBeNull();
    expect(paper!.blocks.map((block) => [block.kind, block.source.split('\n')[0]])).toEqual([
      ['text', '\\begin{abstract}'],
      ['text', '\\section{Introduction}'],
      ['text', '\\subsection{Motivation}'],
      ['text', '\\section{Results}'],
      ['table', '\\begin{table}[t]'],
      ['text', 'More words, 50\\% of them.'],
      ['figure', '\\begin{figure*}'],
      // \appendix prints nothing, so it goes on with the section after it.
      ['text', '\\appendix'],
    ]);
    expect(paper!.blocks[7].source).toBe('\\appendix\n\\section{More}\nExtra.');
    // What Lemma shows itself is left out of the blocks.
    const all = paper!.blocks.map((block) => block.source).join('\n');
    expect(all).not.toMatch(/\\maketitle|\\bibliography|\\input/);
    expect(paper!.preamble).toContain('\\input{macros}');
    expect(paper!.preamble).not.toContain('\\begin{document}');
    expect([paper!.title, paper!.authors]).toEqual(['A Made-up Study of Things', ['Ada Example', 'Bo Sample']]);
  });

  it('keeps the other files as attachments, the .bib also as references.bib, the parts taken in left out', async () => {
    const paper = await projectPaper(project(), 'main.tex');
    expect(Object.keys(paper!.attachments).sort()).toEqual(['figures/plot.pdf', 'macros.tex', 'notes/other.tex', 'references.bib', 'refs.bib']);
    expect(decode(paper!.attachments['references.bib'])).toContain('@article{doe2020');
  });

  it('names the .tex files taken into the text', async () => {
    const paper = await projectPaper(project(), 'main.tex');
    expect(paper!.taken.sort()).toEqual(['main.tex', 'sections/intro.tex']);
  });

  it('goes into a paper that exists in place of its content, keeping its address and other attachments', () => {
    const previous: ResultPaper = {
      id: 'res-a',
      slug: 'a',
      title: 'Untitled',
      authors: ['**Ada Example**'],
      preamble: '\\documentclass{article}',
      files: ['main.tex', 'other.sty'],
      logic: { b2: 'b1' },
      blocks: [
        { id: 'b1', kind: 'text', source: 'Old.', output: { pdf: 'results/res-a/b1.pdf', width: 1, height: 1 } },
        { id: 'b2', kind: 'table', source: 'Old.', alternate: { kind: 'figure', source: 'x', output: { pdf: 'results/res-a/b2-alt.pdf', width: 1, height: 1 } } },
      ],
    };
    const next: ResultPaper = { ...previous, title: 'A Made-up Study', authors: ['**Ada Example**', 'Bo Sample'], preamble: '\\documentclass{article}\n\\usepackage{x}', blocks: [{ id: 'n1', kind: 'text', source: 'New.' }] };
    const { ops, deletes } = replaceContent(previous, next, ['main.tex']);
    expect(ops.map((op) => op.kind)).toEqual(['putPaper', 'patchPaper', 'deleteBlock', 'deleteBlock', 'putBlock', 'removeFile']);
    expect(ops[0]).toMatchObject({ paper: { id: 'res-a', slug: 'a', title: 'A Made-up Study' } });
    expect(ops[1]).toEqual({ kind: 'patchPaper', id: 'res-a', fields: { preamble: next.preamble, logic: null } });
    expect(deletes).toEqual(['results/res-a/b1.pdf', 'results/res-a/b2-alt.pdf', 'results/res-a/files/main.tex']);
    // The same title and authors change nothing there.
    expect(replaceContent(previous, { ...next, title: previous.title, authors: previous.authors }, []).ops[0].kind).toBe('patchPaper');
  });

  it('renames files TeX and the repository cannot hold as they are, and the code that names them', async () => {
    const files = { 'main.tex': encode('\\documentclass{article}\n\\begin{document}\n\\begin{figure}\n\\includegraphics{figs/my plot}\n\\end{figure}\n\\end{document}\n'), 'figs/my plot.png': new Uint8Array([9]) };
    const paper = await projectPaper(files, 'main.tex');
    expect(paper!.renamed).toHaveLength(1);
    const renamed = paper!.renamed[0].to;
    expect(renamed).toMatch(/^figs\/my-plot-[0-9a-f]{8}\.png$/);
    expect(paper!.blocks[0].source).toContain(`\\includegraphics{${renamed.replace(/\.png$/, '')}}`);
  });

  it('never cuts inside a float or verbatim', () => {
    const blocks = blocksOfBody('\\begin{verbatim}\n\\section{not a section}\n\\end{verbatim}\n\\section{Real}\nText.\n\\begin{figure}\n\\begin{figure}\nnested\n\\end{figure}\n\\end{figure}');
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'text', 'figure']);
    expect(blocks[0].source).toBe('\\begin{verbatim}\n\\section{not a section}\n\\end{verbatim}');
    expect(blocks[2].source.split('\n')).toHaveLength(5);
  });

  it('keeps what prints nothing on its own with what follows', () => {
    const blocks = blocksOfBody('\\label{start}\n\\clearpage\n\\section{Real}\nText.');
    expect(blocks).toEqual([{ kind: 'text', source: '\\label{start}\n\\clearpage\n\\section{Real}\nText.' }]);
  });
});

describe('a .zip', () => {
  const zipped = async (files: Record<string, Uint8Array | string>): Promise<Uint8Array> => {
    const zip = new JSZip();
    for (const [path, data] of Object.entries(files)) zip.file(path, data);
    return zip.generateAsync({ type: 'uint8array' });
  };

  it('opens to the files a paper can use, a wrapping folder and junk taken off', async () => {
    const data = await zipped({ 'paper/main.tex': 'x', 'paper/figs/a.pdf': 'y', 'paper/data.csv': 'z', '__MACOSX/paper/._main.tex': 'junk', 'paper/.DS_Store': 'junk' });
    const opened = await unzip(data);
    expect(Object.keys(opened.files).sort()).toEqual(['figs/a.pdf', 'main.tex']);
    expect(opened.skipped.type).toEqual(['data.csv']);
    expect(wrapperOf(['a/b', 'a/c/d'])).toBe('a/');
    expect(wrapperOf(['a/b', 'c'])).toBe('');
  });

  it('dropped among other files stands for what is in it, in the folder it was in', async () => {
    const data = await zipped({ 'figs/a.pdf': 'y', 'main.tex': 'x' });
    const { picked, archives } = await expandZips([
      { path: 'paper.bib', file: new File(['@misc{a}'], 'paper.bib') },
      { path: 'extra/project.zip', file: new File([data.slice()], 'project.zip') },
    ]);
    expect(archives).toEqual(['extra/project.zip']);
    expect(picked.map((item) => item.path).sort()).toEqual(['extra/figs/a.pdf', 'extra/main.tex', 'paper.bib']);
  });
});
