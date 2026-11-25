import { describe, expect, it } from 'vitest';
import { hashBytes } from '../../editor/results/actions';
import { ResultsOp, applyResultsOp } from '../../editor/results/ops';
import { ResultPaper } from '../../types';
import { syncState } from './carry';
import { insertCopy, planCarry, planPull, planPush, pullOps, pushOps, suggestedChoices } from './transfer';

const enc = (text: string) => new TextEncoder().encode(text);

const files: Record<string, Uint8Array> = {
  'results/a/files/acc.pdf': enc('A-PDF'),
  'results/a/files/references.bib': enc('@article{k1, title={One}}\n@article{k2, title={Two}}'),
  'results/b/files/acc.pdf': enc('B-PDF'),
};
const readFile = async (path: string) => {
  const found = files[path];
  if (!found) throw new Error(`no ${path}`);
  return found;
};

const a: ResultPaper = {
  id: 'a',
  slug: 'paper-a',
  title: 'A',
  authors: [],
  preamble: '\\documentclass{article}\n\\usepackage{booktabs}\n\\newcommand{\\ours}{Ours}',
  files: ['acc.pdf', 'references.bib'],
  // As the editor records them: hashes of the content.
  fileHashes: { 'acc.pdf': await hashBytes(enc('A-PDF')), 'references.bib': await hashBytes(files['results/a/files/references.bib']) },
  blocks: [{ id: 'fig', kind: 'figure', source: '\\includegraphics{acc}\n\\caption{\\ours \\cite{k1}}\n\\label{fig:acc}' }],
};
const b: ResultPaper = { id: 'b', slug: 'paper-b', title: 'B', authors: [], preamble: '\\documentclass{article}', files: ['acc.pdf'], fileHashes: { 'acc.pdf': 'other' }, blocks: [] };

const apply = (papers: ResultPaper[], op: ResultsOp) => applyResultsOp(papers, op);

describe('moving a figure between papers', () => {
  it('inserts a copy with what it needs, then pulls and pushes', async () => {
    const plan = await planCarry(a.blocks[0].source!, a, b, readFile);
    expect(plan.source).toContain('{paper-a/acc}');
    expect(plan.copies).toEqual([{ from: 'acc.pdf', to: 'paper-a/acc.pdf' }]);
    expect(plan.definitions.map((item) => item.name)).toEqual(['ours']);
    expect(plan.packages.map((item) => item.name)).toEqual(['booktabs']);
    expect(plan.bib.keys).toEqual(['k1']);

    const inserted = await insertCopy(plan, a.blocks[0], suggestedChoices(plan), readFile, 'from A');
    let papers = apply([a, b], inserted.op);
    const copyOf = () => papers[1].blocks.find((block) => block.id === inserted.blockId)!;
    expect(papers[1].preamble).toContain('\\usepackage{booktabs}\n\\newcommand{\\ours}{Ours}');
    expect(papers[1].files).toEqual(['acc.pdf', 'paper-a/acc.pdf', 'references.bib']);
    expect(new TextDecoder().decode(inserted.writes.find((write) => write.path.endsWith('references.bib'))!.data)).toBe('@article{k1, title={One}}\n');
    expect(copyOf().origin).toEqual({ paper: 'a', block: 'fig', base: plan.source, files: { acc: 'paper-a/acc' } });
    expect(syncState(copyOf(), papers)).toBe('synced');

    // The home changes: the copy is behind, and pulling keeps its renamed picture.
    papers = apply(papers, { kind: 'putBlock', paperId: 'a', block: { ...papers[0].blocks[0], source: a.blocks[0].source!.replace('\\ours', '\\ours{} v2') } });
    expect(syncState(copyOf(), papers)).toBe('behind');
    const pull = await planPull({ paper: papers[1], block: copyOf() }, papers, readFile)!;
    expect(pull.copies).toEqual([]);
    papers = apply(papers, (await pullOps({ paper: papers[1], block: copyOf() }, pull, suggestedChoices(pull), readFile, 'n')).op);
    expect(copyOf().source).toContain('v2');
    expect(copyOf().source).toContain('{paper-a/acc}');
    expect(syncState(copyOf(), papers)).toBe('synced');

    // The copy changes: it is ahead, and pushing gives the home its own picture name back.
    papers = apply(papers, { kind: 'putBlock', paperId: 'b', block: { ...copyOf(), source: `${copyOf().source}\n% note` } });
    expect(syncState(copyOf(), papers)).toBe('ahead');
    const push = await planPush({ paper: papers[1], block: copyOf() }, papers, readFile)!;
    papers = apply(papers, (await pushOps({ paper: papers[1], block: copyOf() }, push, suggestedChoices(push), readFile, 'n')).op);
    expect(papers[0].blocks[0].source).toContain('{acc}');
    expect(papers[0].blocks[0].source).toContain('% note');
    expect(syncState(copyOf(), papers)).toBe('synced');
    expect(copyOf().origin?.files).toEqual({ acc: 'paper-a/acc' });
  });
});
