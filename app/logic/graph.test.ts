import { describe, expect, it } from 'vitest';
import { ResultBlock } from '../../types';
import { fitAll, graphOf, nodeAt, radiusOf, startOf } from './graph';
import { logicTree } from './tree';

const text = (id: string, source: string): ResultBlock => ({ id, kind: 'text', source });

describe('the graph of a paper’s logic', () => {
  it('starts at the introduction, whatever its number or language', () => {
    const blocks = [text('abs', '\\begin{abstract}\nMade up.\n\\end{abstract}'), text('intro', '\\section{Introduction}\nWhy.'), text('m', '\\section{Method}')];
    expect(startOf({ blocks })).toBe('intro');
    expect(startOf({ blocks: [text('a', 'Words.'), text('b', '\\section{引言}\n为什么。')] })).toBe('b');
    expect(startOf({ blocks: [text('a', '\\section*{はじめに}')] })).toBe('a');
    // Without one: the first block with a heading, else the first block.
    expect(startOf({ blocks: [text('a', 'Words.'), text('b', '\\section{Method}')] })).toBe('b');
    expect(startOf({ blocks: [{ id: 't', kind: 'table', source: '' }] })).toBe('t');
    expect(startOf({ blocks: [] })).toBeNull();
  });

  it('draws the blocks of the logic and the start, linked from each block to the ones under it', () => {
    const blocks = [text('intro', '\\section{Introduction}'), text('m1', '\\section{Method}'), text('e1', '\\section{Experiment}'), text('x', 'Elsewhere.')];
    expect(graphOf(logicTree({ blocks }), 'intro')).toEqual({ ids: ['intro'], links: [] });
    const tree = logicTree({ blocks, logic: { m1: 'intro', e1: 'm1', x: '' } });
    expect(graphOf(tree, 'intro')).toEqual({
      ids: ['intro', 'm1', 'e1', 'x'],
      links: [
        { source: 'intro', target: 'm1' },
        { source: 'm1', target: 'e1' },
      ],
    });
  });

  it('finds the node under the pointer, the nearest one, never one it is told to skip', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0, r: 10 },
      { id: 'b', x: 18, y: 0, r: 10 },
    ];
    expect(nodeAt(nodes, 2, 0)).toBe('a');
    expect(nodeAt(nodes, 12, 0)).toBe('b');
    expect(nodeAt(nodes, 2, 0, new Set(['a']))).toBe('b');
    expect(nodeAt(nodes, 0, 40)).toBeNull();
  });

  it('sizes the start and the busier blocks larger, and fits them all in view', () => {
    expect(radiusOf(0, true)).toBeGreaterThan(radiusOf(9, false));
    expect(radiusOf(4, false)).toBeGreaterThan(radiusOf(0, false));
    const view = fitAll(
      [
        { id: 'a', x: -500, y: 0, r: 7 },
        { id: 'b', x: 500, y: 200, r: 7 },
      ],
      800,
      600,
    );
    expect(view.k).toBeLessThan(1);
    // The middle of the nodes lands in the middle of the view.
    expect(view.x + 0 * view.k).toBeCloseTo(400, 0);
  });
});
