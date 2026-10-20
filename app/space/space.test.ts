import { describe, expect, it } from 'vitest';
import { parseSpace, serializeSpace } from '../../editor/results/space';
import { ResearchSpace } from '../../types';
import { blockNode, blockOfNode, cleanSpace, inSpace, isIdea, spaceNodes, spaceTree, withIdea, withIdeaText, withLine, withNode, withoutNode } from './space';

const PAPERS = ['res-a', 'res-b', 'res-c', 'res-a/blk-1', 'res-a/blk-2'];
const empty = (): ResearchSpace => ({ parents: {}, relations: [], ideas: {} });

describe('a research space', () => {
  it('holds papers and ideas, each under the node it belongs to', () => {
    const { space, id } = withIdea(empty(), PAPERS, 'Why does a made-up safety property collapse?', null);
    expect(isIdea(id)).toBe(true);
    let built = withNode(space, PAPERS, 'res-a', id);
    built = withNode(built, PAPERS, 'res-b', id);
    built = withNode(built, PAPERS, 'res-c', 'res-a');
    const tree = spaceTree(built, PAPERS);
    expect(tree.roots).toEqual([id]);
    expect(tree.nodes[id].children).toEqual(['res-a', 'res-b']);
    expect(tree.nodes['res-a'].children).toEqual(['res-c']);
    expect([...inSpace(built, PAPERS)].sort()).toEqual([id, 'res-a', 'res-b', 'res-c'].sort());
  });

  it('takes a node out, the nodes under it going up; an idea taken out is gone with its lines', () => {
    const { space, id } = withIdea(empty(), PAPERS, 'A made-up question', null);
    let built = withNode(withNode(space, PAPERS, 'res-a', id), PAPERS, 'res-c', 'res-a');
    built = withLine(withNode(built, PAPERS, 'res-b', null), id, 'res-b', true);
    const withoutA = withoutNode(built, PAPERS, 'res-a');
    expect(withoutA.parents).toEqual({ [id]: '', 'res-c': id, 'res-b': '' });
    const withoutIdea = withoutNode(built, PAPERS, id);
    expect(withoutIdea.ideas).toEqual({});
    expect(withoutIdea.relations).toEqual([]);
    expect(withoutIdea.parents).toEqual({ 'res-a': '', 'res-c': 'res-a', 'res-b': '' });
  });

  it('forgets papers that are gone, ideas no longer in it, and lines that lead nowhere', () => {
    const stored: ResearchSpace = {
      parents: { 'res-a': 'idea-1', 'res-gone': '', 'res-b': 'res-gone', 'idea-1': '' },
      relations: [['res-a', 'res-gone'], ['idea-1', 'res-b']],
      ideas: { 'idea-1': 'Made up', 'idea-loose': 'Never placed' },
    };
    expect(cleanSpace(stored, PAPERS)).toEqual({ parents: { 'res-a': 'idea-1', 'res-b': '', 'idea-1': '' }, relations: [['idea-1', 'res-b']], ideas: { 'idea-1': 'Made up' } });
    expect(withIdeaText(stored, 'idea-1', 'Changed').ideas['idea-1']).toBe('Changed');
  });

  it('holds blocks of papers too, which leave it when they are deleted', () => {
    const papers = [
      { id: 'res-a', blocks: [{ id: 'blk-1', kind: 'figure' as const }, { id: 'blk-2', kind: 'text' as const }] },
      { id: 'res-b', blocks: [] },
    ];
    expect(spaceNodes(papers)).toEqual(['res-a', 'res-a/blk-1', 'res-a/blk-2', 'res-b']);
    expect(blockNode('res-a', 'blk-1')).toBe('res-a/blk-1');
    expect(blockOfNode('res-a/blk-1')).toEqual({ paperId: 'res-a', blockId: 'blk-1' });
    expect(blockOfNode('res-a')).toBeNull();
    const { space, id } = withIdea(empty(), spaceNodes(papers), 'A made-up question', null);
    const built = withLine(withNode(withNode(space, spaceNodes(papers), 'res-a/blk-1', id), spaceNodes(papers), 'res-a/blk-2', 'res-a/blk-1'), id, 'res-b', true);
    expect(spaceTree(built, spaceNodes(papers)).nodes[id].children).toEqual(['res-a/blk-1']);
    // The figure is deleted from its paper: it leaves the space, and the text under it goes to the top.
    const after = [{ id: 'res-a', blocks: [{ id: 'blk-2', kind: 'text' as const }] }, { id: 'res-b', blocks: [] }];
    expect(cleanSpace(built, spaceNodes(after)).parents).toEqual({ [id]: '', 'res-a/blk-2': '' });
  });

  it('reads what is stored, leaving out what is malformed', () => {
    expect(parseSpace(null)).toEqual(empty());
    expect(parseSpace('not json')).toEqual(empty());
    const space: ResearchSpace = { parents: { 'res-a': '' }, relations: [['idea-1', 'res-a']], ideas: { 'idea-1': 'Made up' } };
    expect(parseSpace(serializeSpace(space))).toEqual(space);
    expect(parseSpace(JSON.stringify({ parents: { a: 1, b: '' }, relations: [['x'], ['a', 'b'], 'c'], ideas: [] }))).toEqual({ parents: { b: '' }, relations: [['a', 'b']], ideas: {} });
  });
});
