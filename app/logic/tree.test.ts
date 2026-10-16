import { describe, expect, it } from 'vitest';
import { ResultBlock, ResultPaper } from '../../types';
import { nodeLabels, wordsOf } from './labels';
import { layoutTree } from './layout';
import { ancestorsOf, buildTree, canMove, cleanLogic, logicTree, movesFrom, paperParents, paperTree, placedIn, pruned, subtreeOf, withPlacement, withoutBlock } from './tree';

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

/** The slide's logical organization, built by hand: the methodology on top, each experiment under its method. */
const LOGIC = { meth: '', m1: 'meth', m2: 'meth', e1: 'm1', t1: 'e1', e2: 'm1', e3: 'm2', e4: 'e3' };

describe("a paper's own tree", () => {
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
    expect(paperTree(paper()).order).toHaveLength(13);
  });

  it('keeps a heading open across blocks, and starts over at the appendix', () => {
    const blocks = [text('a', '\\section{A}\nx\n\\subsection{A.1}'), text('b', 'more of A.1'), text('c', '\\subsection{A.2}'), text('app', '\\appendix\n\\section{More}'), text('d', 'extra')];
    expect(paperParents({ blocks })).toEqual({ a: null, b: 'a', c: 'a', app: null, d: 'app' });
  });
});

describe('a logic built by hand', () => {
  it('holds only the blocks put in it, in the paper order under each block', () => {
    expect(logicTree(paper()).order).toEqual([]);
    const tree = logicTree(paper(LOGIC));
    expect(tree.roots).toEqual(['meth']);
    expect(tree.nodes.meth.children).toEqual(['m1', 'm2']);
    expect(tree.nodes.m1.children).toEqual(['e1', 'e2']);
    expect(tree.nodes.e3.children).toEqual(['e4']);
    expect(tree.order).toEqual(['meth', 'm1', 'e1', 't1', 'e2', 'm2', 'e3', 'e4']);
    expect(tree.nodes.m3).toBeUndefined();
    expect([tree.nodes.e4.depth, tree.nodes.t1.depth]).toEqual([3, 3]);
    expect(ancestorsOf(tree, 'e4')).toEqual(['meth', 'm2', 'e3']);
    expect([...subtreeOf(tree, 'm1')]).toEqual(['m1', 'e1', 't1', 'e2']);
  });

  it('counts a block others are under as in it, at the top (how the first version stored moves)', () => {
    const tree = logicTree(paper({ e1: 'm1', e2: 'm1', e3: 'm2', e4: 'e3' }));
    expect(tree.roots).toEqual(['m1', 'm2']);
    expect(placedIn(paper().blocks, { e1: 'm1', gone: 'm1', e2: 'gone' })).toEqual(new Set(['e1', 'm1', 'e2']));
  });

  it('places blocks, at the top or under another, and never under themselves', () => {
    let logic = withPlacement(paper().blocks, {}, 'm1', null);
    logic = withPlacement(paper().blocks, logic, 'e1', 'm1');
    logic = withPlacement(paper().blocks, logic, 'e2', 'e1');
    expect(logic).toEqual({ m1: '', e1: 'm1', e2: 'e1' });
    const tree = logicTree(paper(logic));
    expect(canMove(tree, 'm1', 'e2')).toBe(false);
    expect(canMove(tree, 'e2', 'm1')).toBe(true);
    expect(canMove(tree, 'e4', 'e2')).toBe(true);
    expect(canMove(tree, 'e4', 'e4')).toBe(false);
    // Moves that would make a loop, or name a block that is gone, are at the top.
    const looped = logicTree(paper({ m1: 'e1', e1: 'm1', e2: 'gone' }));
    expect(looped.order.sort()).toEqual(['e1', 'e2', 'm1']);
    expect(looped.nodes.e2.parent).toBeNull();
  });

  it('takes a block out, the blocks under it going up to where it was', () => {
    expect(withoutBlock(paper().blocks, LOGIC, 'm1')).toEqual({ meth: '', m2: 'meth', e1: 'meth', t1: 'e1', e2: 'meth', e3: 'm2', e4: 'e3' });
    expect(withoutBlock(paper().blocks, { e1: 'm1', e2: 'm1' }, 'm1')).toEqual({ e1: '', e2: '' });
    expect(cleanLogic(paper().blocks, { e1: 'm1', gone: 'm1', e2: 'gone', e3: 'e3' })).toEqual({ e1: 'm1', e2: '', e3: '' });
  });

  it('goes up, down, across branches and through in order', () => {
    const tree = logicTree(paper(LOGIC));
    expect(movesFrom(tree, 'e2')).toEqual({ up: 'm1', down: null, left: 'e1', right: 'e3', previous: 't1', next: 'm2' });
    expect(movesFrom(tree, 'm1')).toMatchObject({ up: 'meth', down: 'e1', left: null, right: 'm2' });
    expect(movesFrom(tree, 'meth')).toMatchObject({ up: null, left: null, right: null, previous: null });
  });

  it('leaves out what a reader does not see, lifting what was under it', () => {
    const tree = pruned(logicTree(paper(LOGIC)), (id) => id !== 'm2', ['references']);
    expect(tree.nodes.meth.children).toEqual(['m1', 'e3']);
    expect(tree.roots[tree.roots.length - 1]).toBe('references');
    expect(tree.order).not.toContain('m2');
  });

  it('turns a loop of parents, which placing never makes, into blocks at the top', () => {
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
