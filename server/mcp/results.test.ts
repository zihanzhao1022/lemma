import { describe, expect, it } from 'vitest';
import { hashBytes } from '../../editor/results/attachments';
import { ResultsOp, applyResultsOp } from '../../editor/results/ops';
import { ResultPaper } from '../../types';
import { BytesWrite, Library, TextWrite } from './library';
import { RESULT_TOOLS } from './results';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const FIGURE = '\\begin{figure}\\includegraphics{acc}\\caption{Accuracy of \\ours~\\cite{k1}.}\\label{fig:acc}\\end{figure}';

async function papers(): Promise<ResultPaper[]> {
  return [
    {
      id: 'res-a',
      slug: 'study',
      title: 'A Made-up Study',
      authors: [],
      preamble: '\\documentclass{article}\n\\usepackage{times}\n\\usepackage{booktabs}\n\\newcommand{\\ours}{Ours}',
      files: ['acc.pdf', 'references.bib'],
      fileHashes: { 'acc.pdf': await hashBytes(enc('PDF-A')), 'references.bib': 'x' },
      blocks: [
        { id: 'txt', kind: 'text', source: 'See Figure~\\ref{fig:acc}.' },
        { id: 'fig', kind: 'figure', source: FIGURE },
      ],
    },
    { id: 'res-b', slug: 'survey', title: 'A Made-up Survey', authors: [], preamble: '\\documentclass{article}', blocks: [{ id: 'intro', kind: 'text', source: 'Intro.' }] },
  ];
}

/** The papers and files in memory, saved as the repository would: the op and the files in one commit. */
async function fakeLibrary() {
  const state = {
    papers: await papers(),
    files: { 'results/res-a/files/acc.pdf': enc('PDF-A'), 'results/res-a/files/references.bib': enc('@article{k1, title={One}}') } as Record<string, Uint8Array>,
    commits: [] as { op: ResultsOp; message: string }[],
  };
  const library: Library = {
    repo: 'ada-example/lemma-papers',
    papers: async () => state.papers,
    save: async (op, message, _deletes = [], check, writes = []) => {
      check?.(state.papers);
      state.papers = applyResultsOp(state.papers, op);
      for (const write of writes as (TextWrite | BytesWrite)[]) state.files[write.path] = 'content' in write ? enc(write.content) : write.data;
      state.commits.push({ op, message });
      return state.papers;
    },
    readText: async (path) => (state.files[path] ? dec(state.files[path]) : null),
    readBytes: async (path) => {
      if (!state.files[path]) throw new Error(`no ${path}`);
      return state.files[path];
    },
  };
  return { library, state };
}

const tool = (name: string) => {
  const found = RESULT_TOOLS.find((item) => item.name === name);
  if (!found) throw new Error(name);
  return (args: Record<string, unknown>, library: Library) => found.run(args, library);
};

describe('the results library over MCP', () => {
  it('lists, inserts with what the block needs, and keeps the copy in step', async () => {
    const { library, state } = await fakeLibrary();
    expect(await tool('list_results')({}, library)).toContain('res-a fig: Figure of "A Made-up Study" — Accuracy of');

    const inserted = await tool('insert_result')({ from: 'study', block: 'fig', into: 'survey', after: 'intro' }, library);
    expect(inserted).toContain('Copied attachments: acc.pdf.');
    expect(inserted).toContain('\\usepackage{booktabs}\n\\newcommand{\\ours}{Ours}');
    expect(inserted).toContain('Not added (loaded by "A Made-up Study" only; pass them in "packages" if the block needs them): times.');
    expect(inserted).toContain('Added to references.bib: k1.');
    const survey = () => state.papers.find((paper) => paper.id === 'res-b')!;
    const copy = () => survey().blocks[1];
    expect(copy().origin).toMatchObject({ paper: 'res-a', block: 'fig' });
    expect(dec(state.files['results/res-b/files/acc.pdf'])).toBe('PDF-A');
    expect(dec(state.files['results/res-b/files/references.bib'])).toBe('@article{k1, title={One}}\n');
    expect(await tool('list_results')({ paper: 'study' }, library)).toContain('the same as the library');

    // The copy changes: status shows the line, push gives it to the library.
    state.papers = applyResultsOp(state.papers, { kind: 'putBlock', paperId: 'res-b', block: { ...copy(), source: copy().source!.replace('Accuracy', 'Mean accuracy') } });
    const status = await tool('sync_result')({ paper: 'survey', block: copy().id, action: 'status' }, library);
    expect(status).toContain('changed in this paper');
    expect(status).toContain('+ \\begin{figure}\\includegraphics{acc}\\caption{Mean accuracy');
    await expect(tool('sync_result')({ paper: 'survey', block: copy().id, action: 'pull', source: '<<<<<<< x' }, library)).rejects.toThrow('conflict markers');
    expect(await tool('sync_result')({ paper: 'survey', block: copy().id, action: 'push' }, library)).toContain('took the copy’s version of fig');
    expect(state.papers[0].blocks[1].source).toContain('Mean accuracy');

    // Both change: pull needs the merge.
    state.papers = applyResultsOp(state.papers, { kind: 'putBlock', paperId: 'res-a', block: { ...state.papers[0].blocks[1], source: `${state.papers[0].blocks[1].source}\n% a` } });
    state.papers = applyResultsOp(state.papers, { kind: 'putBlock', paperId: 'res-b', block: { ...copy(), source: `% b\n${copy().source}` } });
    expect(await tool('sync_result')({ paper: 'survey', block: copy().id, action: 'status' }, library)).toContain('0 conflict(s)');
    await expect(tool('sync_result')({ paper: 'survey', block: copy().id, action: 'pull' }, library)).rejects.toThrow('Both sides changed');
    const merged = `% b\n${state.papers[0].blocks[1].source}`;
    await tool('sync_result')({ paper: 'survey', block: copy().id, action: 'push', source: merged }, library);
    expect(copy().source).toBe(merged);
    expect(state.papers[0].blocks[1].source).toBe(merged);
    expect(await tool('sync_result')({ paper: 'survey', block: copy().id, action: 'status' }, library)).toContain('the same as the library');

    await tool('sync_result')({ paper: 'survey', block: copy().id, action: 'unlink' }, library);
    expect(copy().origin).toBeUndefined();
  });
});
