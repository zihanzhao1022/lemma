import { describe, expect, it } from 'vitest';
import { ResultBlock, ResultPaper } from '../../types';
import { nodeLabels, wordsOf } from './labels';
import { layoutTree } from './layout';
import { ancestorsOf, buildTree, canMove, cleanLogic, logicTree, movesFrom, paperParents, pruned, subtreeOf, withMove } from './tree';

const text = (id: string, source: string): ResultBlock => ({ id, kind: 'text', source });

/** A made-up paper laid out as papers are: the methods in one section, their experiments in the next. */
const paper = (logic?: Record<string, string>): Pick<ResultPaper, 'blocks' | 'preamble' | 'logic'> => ({
  blocks: [
    text('abs', '\\begin{abstract}\nWe study made-up things.\n\\end{abstract}'),
    text('meth', '\\section{Methodology}\nOverview.'),
    text('m1', '\\subsection{Method 1}\nThe first made-up method.'),
    text('m2', '\\subsection{Method 2}\nThe second.'),
    text('m3', '\\subsection{Method 3}\nThe third.'),
    text('exps', '\\section{Experiments}\nSetup.'),
    text('e1', '\\subsection{Exp 1}\nResult one.'),
    { id: 't1', kind: 'table', source: '\\begin{table}\n\\caption{Made-up numbers.}\\label{tab:one}\n\\end{table}' },
    text('e2', '\\subsection{Exp 2}\nResult two.'),
    text('e3', '\\subsection{Exp 3}\nResult three.'),
    text('e4', '\\subsection{Exp 4}\nResult four.'),
    text('more', 'More about the fourth.'),
    text('concl', '\\section{Conclusion}\nDone.'),
  ],
  ...(logic ? { logic } : {}),
});

/** The slide's logical organization: each experiment under the method it tests, the fourth after the third. */
const LOGIC = { e1: 'm1', e2: 'm1', e3: 'm2', e4: 'e3' };

describe('a paper as a tree', () => {
  it('puts each block where its headings do: subsections under sections, the rest under the heading above it', () => {
    expect(paperParents(paper())).toEqual({
      abs: null,
      meth: null,
      m1: 'meth',
      m2: 'meth',
      m3: 'meth',
      exps: null,
      e1: 'exps',
      t1: 'e1',
      e2: 'exps',
      e3: 'exps',
      e4: 'exps',
      more: 'e4',
      concl: null,
    });
  });

  it('keeps a heading open across blocks, and starts over at the appendix', () => {
    const blocks = [text('a', '\\section{A}\nx\n\\subsection{A.1}'), text('b', 'more of A.1'), text('c', '\\subsection{A.2}'), text('app', '\\appendix\n\\section{More}'), text('d', 'extra')];
    expect(paperParents({ blocks })).toEqual({ a: null, b: 'a', c: 'a', app: null, d: 'app' });
  });

  it('moves experiments under their methods, with what is under them, the others keeping the paper order', () => {
    const tree = logicTree(paper(LOGIC));
    expect(tree.nodes.m1.children).toEqual(['e1', 'e2']);
    expect(tree.nodes.m2.children).toEqual(['e3']);
    expect(tree.nodes.e3.children).toEqual(['e4']);
    expect(tree.nodes.exps.children).toEqual([]);
    expect(tree.nodes.e1.moved && !tree.nodes.t1.moved && !tree.nodes.m1.moved).toBe(true);
    expect(tree.order).toEqual(['abs', 'meth', 'm1', 'e1', 't1', 'e2', 'm2', 'e3', 'e4', 'more', 'm3', 'exps', 'concl']);
    expect([tree.nodes.e4.depth, tree.nodes.more.depth]).toEqual([3, 4]);
    expect(ancestorsOf(tree, 'more')).toEqual(['meth', 'm2', 'e3', 'e4']);
    expect([...subtreeOf(tree, 'm1')]).toEqual(['m1', 'e1', 't1', 'e2']);
  });

  it('never puts a block under itself or a block under it, nor under a block that is gone', () => {
    const tree = logicTree(paper(LOGIC));
    expect(canMove(tree, 'm1', 't1')).toBe(false);
    expect(canMove(tree, 'm1', 'm1')).toBe(false);
    expect(canMove(tree, 'e2', 'e1')).toBe(true);
    // Moves that would make a loop, or name a block that is gone, count for nothing.
    const looped = logicTree(paper({ m1: 'e1', e1: 'm1', e2: 'gone' }));
    expect(looped.nodes.m1.parent).toBe('e1');
    expect(looped.nodes.e1.parent).toBe('exps');
    expect(looped.nodes.e2.parent).toBe('exps');
    expect(looped.order).toHaveLength(13);
  });

  it('keeps only the moves that differ from the headings', () => {
    const moved = withMove(paper(), {}, 'e1', 'm1');
    expect(moved).toEqual({ e1: 'm1' });
    expect(withMove(paper(), moved, 'e1', 'exps')).toEqual({});
    expect(withMove(paper(), moved, 'e1', null)).toEqual({});
    expect(cleanLogic(paper().blocks, { e1: 'm1', gone: 'm1', e2: 'gone', e3: 'e3' })).toEqual({ e1: 'm1' });
  });

  it('goes up, down, across branches and through in order', () => {
    const tree = logicTree(paper(LOGIC));
    expect(movesFrom(tree, 'e2')).toEqual({ up: 'm1', down: null, left: 'e1', right: 'e3', previous: 't1', next: 'm2' });
    expect(movesFrom(tree, 'm1')).toMatchObject({ up: 'meth', down: 'e1', left: null, right: 'm2' });
    expect(movesFrom(tree, 'abs')).toMatchObject({ up: null, left: null, right: 'meth', previous: null });
  });

  it('leaves out what a reader does not see, lifting what was under it', () => {
    const tree = pruned(logicTree(paper(LOGIC)), (id) => id !== 'm2', ['references']);
    expect(tree.nodes.meth.children).toEqual(['m1', 'e3', 'm3']);
    expect(tree.nodes.e3.moved).toBe(true);
    expect(tree.roots[tree.roots.length - 1]).toBe('references');
    expect(tree.order).not.toContain('m2');
  });

  it('turns a loop of parents, which moves never make, into blocks at the top', () => {
    const tree = buildTree(['a', 'b'], { a: 'b', b: 'a' });
    expect(tree.order.sort()).toEqual(['a', 'b']);
  });
});

describe('drawing the tree', () => {
  const spacing = { w: 10, h: 10, across: 2, down: 5, between: 4 };
  const tree = buildTree(['a', 'b', 'c', 'd'], { a: null, b: 'a', c: 'a', d: null });

  it('centres each block over the blocks under it, the trees side by side', () => {
    expect(layoutTree(tree, new Set(), spacing)).toEqual({
      at: { a: { x: 6, y: 0 }, b: { x: 0, y: 15 }, c: { x: 12, y: 15 }, d: { x: 26, y: 0 } },
      width: 36,
      height: 25,
    });
  });

  it('leaves out what is under a folded block', () => {
    const drawn = layoutTree(tree, new Set(['a']), spacing);
    expect(Object.keys(drawn.at)).toEqual(['a', 'd']);
    expect(drawn.at.d.x).toBe(14);
    expect(drawn.height).toBe(10);
  });

  it('never puts two boxes of a level on top of each other', () => {
    const drawn = layoutTree(logicTree(paper(LOGIC)));
    const rows = new Map<number, number[]>();
    for (const { x, y } of Object.values(drawn.at)) rows.set(y, [...(rows.get(y) ?? []), x]);
    for (const xs of rows.values()) {
      const sorted = xs.sort((left, right) => left - right);
      sorted.slice(1).forEach((x, index) => expect(x - sorted[index]).toBeGreaterThanOrEqual(184));
    }
  });
});

describe('what a block is called', () => {
  const words = { figure: (n?: string) => `Figure ${n ?? ''}`.trim(), table: (n?: string) => `Table ${n ?? ''}`.trim(), abstract: 'Abstract', empty: '(empty)' };

  it('names text by its heading or first words, figures and tables by number and caption', () => {
    const labels = nodeLabels(paper(), words);
    expect(labels.m1.title).toMatch(/Method 1$/);
    expect(labels.m1.detail).toBe('The first made-up method');
    expect(labels.abs).toEqual({ title: 'Abstract', detail: 'We study made-up things' });
    expect(labels.t1).toEqual({ title: 'Table', detail: 'Made-up numbers' });
    expect(labels.more).toEqual({ title: 'More about the fourth' });
    expect(wordsOf('% a note\n\\section{A}\n\\begin{itemize}\\item One~\\cite{x}.\\end{itemize}')).toBe('One.');
  });
});
