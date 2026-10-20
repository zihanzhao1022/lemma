import { describe, expect, it } from 'vitest';
import { parseSpace, serializeSpace } from '../../editor/results/space';
import { ResearchSpace } from '../../types';
import { cleanSpace, inSpace, isIdea, spaceTree, withIdea, withIdeaText, withLine, withNode, withoutNode } from './space';

const PAPERS = ['res-a', 'res-b', 'res-c'];
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

  it('reads what is stored, leaving out what is malformed', () => {
    expect(parseSpace(null)).toEqual(empty());
    expect(parseSpace('not json')).toEqual(empty());
    const space: ResearchSpace = { parents: { 'res-a': '' }, relations: [['idea-1', 'res-a']], ideas: { 'idea-1': 'Made up' } };
    expect(parseSpace(serializeSpace(space))).toEqual(space);
    expect(parseSpace(JSON.stringify({ parents: { a: 1, b: '' }, relations: [['x'], ['a', 'b'], 'c'], ideas: [] }))).toEqual({ parents: { b: '' }, relations: [['a', 'b']], ideas: {} });
  });
});
