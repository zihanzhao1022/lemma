import { describe, expect, it } from 'vitest';
import { ResultBlock, ResultPaper } from '../../types';
import { serializeDeck } from '../slides/htmlDeck';
import { filterItems, labelsOf, libraryItems, refsOf, slidesOfBlocks, tagsOf } from './results';

const block = (id: string, kind: ResultBlock['kind'], source: string, labels?: string[]): ResultBlock => ({
  id,
  kind,
  source,
  ...(labels
    ? {
        output: {
          pdf: `results/p/${id}.pdf`,
          width: 400,
          height: 200,
          labels: Object.fromEntries(labels.map((name) => [name, '{1}{1}'])),
        },
      }
    : {}),
});

const paper = (id: string, blocks: ResultBlock[], extra: Partial<ResultPaper> = {}): ResultPaper => ({
  id,
  slug: id,
  title: `Paper ${id}`,
  authors: [],
  blocks,
  ...extra,
});

const fig = block('f1', 'figure', '\\begin{figure}\\includegraphics{a}\\caption{Accuracy over \\textbf{steps}}\\label{fig:acc}\\end{figure}', ['fig:acc']);
const tab = block('t1', 'table', '\\begin{table}\\caption{Main results}\\label{tab:main}\\label{tab:alias}\\end{table}');
const text = block('x1', 'text', '\\section{Results} See \\cref{tab:main,fig:other} and Figure~\\ref{fig:acc}. % \\ref{tab:alias}');

describe('labels and refs', () => {
  it('reads compiled labels first, then written ones, without comments', () => {
    expect(labelsOf(tab)).toEqual(['tab:main', 'tab:alias']);
    expect(labelsOf(block('b', 'figure', '% \\label{gone}\n\\label{kept}', ['out']))).toEqual(['out', 'kept']);
  });
  it('splits \\cref lists and skips comments', () => {
    expect(refsOf(text.source)).toEqual(['tab:main', 'fig:other', 'fig:acc']);
  });
});

describe('libraryItems', () => {
  it('lists figures and tables with caption and the text that cites them', () => {
    const items = libraryItems([paper('p', [text, fig, tab])]);
    expect(items.map((item) => item.key)).toEqual(['p/f1', 'p/t1']);
    expect(items[0]).toMatchObject({
      kind: 'figure',
      caption: 'Accuracy over steps',
      citedBy: ['x1'],
      slides: [],
    });
    expect(items[1]).toMatchObject({
      kind: 'table',
      caption: 'Main results',
      citedBy: ['x1'],
    });
  });

  it('finds the slides that show a block in each kind of deck', () => {
    const visual = paper('p', [fig, tab], {
      slides: {
        kind: 'visual',
        slides: [
          { id: 's1', elements: [] },
          {
            id: 's2',
            elements: [{ type: 'block', blockId: 't1', id: 'e', x: 0, y: 0, w: 1, h: 1 }],
          },
        ],
      },
    });
    expect(slidesOfBlocks(visual)).toEqual({ t1: [2] });

    const beamer = paper('p', [fig, tab], {
      slides: {
        kind: 'beamer',
        slides: [],
        beamer: '\\begin{frame}t\\end{frame}\n\\begin{frame}\\lemmablock{fig:acc}\\lemmablock[width=1]{t1}\\end{frame}\n% \\begin{frame}\\lemmablock{t1}',
      },
    });
    expect(slidesOfBlocks(beamer)).toEqual({ f1: [2], t1: [2] });

    const html = paper('p', [fig, tab], {
      slides: { kind: 'html', slides: [], html: { hash: 'h' } },
    });
    expect(slidesOfBlocks(html)).toEqual({});
    const file = serializeDeck({
      title: 'Talk',
      footer: '',
      brief: '',
      css: '',
      slides: [
        { id: 's1', html: '<section class="slide"><h1>a</h1></section>' },
        {
          id: 's2',
          html: '<section class="slide" data-from="t1"><lemma-block ref="fig:acc"></lemma-block></section>',
        },
      ],
    });
    expect(slidesOfBlocks(html, file)).toEqual({ t1: [2], f1: [2] });
  });
});

describe('filterItems', () => {
  const items = libraryItems([paper('a', [fig]), paper('b', [tab], { venue: 'ICLR' })]);
  it('keeps a kind, a paper, and words found in caption, labels or the paper', () => {
    expect(filterItems(items, { kind: 'table' }).map((item) => item.key)).toEqual(['b/t1']);
    expect(filterItems(items, { paper: 'a' }).map((item) => item.key)).toEqual(['a/f1']);
    expect(filterItems(items, { search: 'iclr main' }).map((item) => item.key)).toEqual(['b/t1']);
    expect(filterItems(items, { search: 'fig:acc' }).map((item) => item.key)).toEqual(['a/f1']);
    expect(filterItems(items, { search: 'nothing' })).toEqual([]);
  });
});

describe('copies in the library', () => {
  it('shows a copy under the block it came from, and on its own once that is gone', () => {
    const home = paper('a', [fig]);
    const other = paper('b', [{ id: 'c1', kind: 'figure', source: fig.source, origin: { paper: 'a', block: 'f1', base: fig.source! } }]);
    const items = libraryItems([home, other]);
    expect(items.map((item) => item.key)).toEqual(['a/f1']);
    expect(items[0].copies.map((copy) => [copy.paper.id, copy.block.id, copy.state])).toEqual([['b', 'c1', 'synced']]);
    expect(libraryItems([other]).map((item) => item.key)).toEqual(['b/c1']);
  });
});

describe('tags', () => {
  it('filters by a tag and lists the tags with their colours', async () => {
    const { applyResultsOp } = await import('../../editor/results/ops');
    let papers = [paper('a', [fig, tab])];
    papers = applyResultsOp(papers, { kind: 'setBlockMark', paperId: 'a', blockId: 't1', mark: { color: '#ef4444', tag: ' main ' } });
    papers = applyResultsOp(papers, { kind: 'setBlockMark', paperId: 'a', blockId: 'f1', mark: { tag: 'main' } });
    const items = libraryItems(papers);
    expect(items[1].block.mark).toEqual({ color: '#ef4444', tag: 'main' });
    expect(tagsOf(items)).toEqual([{ tag: 'main', color: '#ef4444', count: 2 }]);
    expect(filterItems(items, { tag: 'main', kind: 'table' }).map((item) => item.key)).toEqual(['a/t1']);
    papers = applyResultsOp(papers, { kind: 'setBlockMark', paperId: 'a', blockId: 't1', mark: { tag: '  ' } });
    expect(papers[0].blocks[1].mark).toBeUndefined();
  });
});
