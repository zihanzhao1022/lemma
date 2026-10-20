/**
 * A research space (ResearchSpace) as a graph: the person's papers, blocks of them (text, figures, tables) and
 * ideas, each under the node it belongs to, with lines drawn between related ones. It is built like a paper's
 * logic (app/logic/tree.ts), with these in place of blocks.
 *
 * Node IDs: a paper's own ("res-…"), a block's as "<paper ID>/<block ID>", an idea's ("idea-…").
 */
import { ResearchSpace, ResultPaper } from '../../types';
import { Relation, cleanRelations, withRelation, withoutRelation } from '../logic/graph';
import { LogicTree, cleanLogic, logicTree, placedIn, withPlacement, withoutBlock } from '../logic/tree';

/** A new idea's ID: "idea-" and lowercase letters and digits, with a little chance in it. */
export const newIdeaId = (): string => `idea-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const isIdea = (id: string): boolean => id.startsWith('idea-');

/** The node of a paper's block. */
export const blockNode = (paperId: string, blockId: string): string => `${paperId}/${blockId}`;
/** Which paper and block a node is, when it is a block's. */
export function blockOfNode(id: string): { paperId: string; blockId: string } | null {
  const at = id.indexOf('/');
  return at > 0 ? { paperId: id.slice(0, at), blockId: id.slice(at + 1) } : null;
}

/** Every paper and block that can be a node: each paper followed by its blocks, in their order. */
export const spaceNodes = (papers: readonly Pick<ResultPaper, 'id' | 'blocks'>[]): string[] =>
  papers.flatMap((paper) => [paper.id, ...paper.blocks.map((block) => blockNode(paper.id, block.id))]);

/** What can be a node: the papers and blocks there are (`known`, see spaceNodes), then the space's ideas. */
const nodesOf = (space: ResearchSpace, known: readonly string[]): { id: string }[] => [...known, ...Object.keys(space.ideas)].map((id) => ({ id }));

/** The space's tree: the nodes placed in it, each under its own; one under a node that is gone is at the top. */
export const spaceTree = (space: ResearchSpace, known: readonly string[]): LogicTree => logicTree({ blocks: nodesOf(space, known), logic: space.parents });

/** The nodes in the space, as a set. */
export const inSpace = (space: ResearchSpace, known: readonly string[]): Set<string> => placedIn(nodesOf(space, known), space.parents);

/**
 * The space without what is gone (papers and blocks deleted since) and with lines only between nodes in it. Ideas
 * live only in the space: one no longer in it is gone too.
 */
export function cleanSpace(space: ResearchSpace, known: readonly string[]): ResearchSpace {
  const nodes = nodesOf(space, known);
  const kept = cleanLogic(nodes, space.parents);
  const placed = placedIn(nodes, kept);
  return {
    parents: kept,
    relations: cleanRelations(space.relations, placed),
    ideas: Object.fromEntries(Object.entries(space.ideas).filter(([id]) => placed.has(id))),
  };
}

/** The space with node `id` under `under`, or on its own (null); put in the space if it was not. */
export const withNode = (space: ResearchSpace, known: readonly string[], id: string, under: string | null): ResearchSpace => ({
  ...space,
  parents: withPlacement(nodesOf(space, known), space.parents, id, under),
});

/** The space with a new idea saying `text`, under `under` or on its own; and the idea's ID. */
export function withIdea(space: ResearchSpace, known: readonly string[], text: string, under: string | null): { space: ResearchSpace; id: string } {
  const id = newIdeaId();
  return { space: withNode({ ...space, ideas: { ...space.ideas, [id]: text } }, known, id, under), id };
}

/** The space with an idea saying `text` instead. */
export const withIdeaText = (space: ResearchSpace, id: string, text: string): ResearchSpace => ({ ...space, ideas: { ...space.ideas, [id]: text } });

/** The space without node `id`: the nodes under it go up to where it was, its lines go, and an idea is gone. */
export function withoutNode(space: ResearchSpace, known: readonly string[], id: string): ResearchSpace {
  const ideas = { ...space.ideas };
  delete ideas[id];
  return {
    parents: withoutBlock(nodesOf(space, known), space.parents, id),
    relations: space.relations.filter((pair) => !pair.includes(id)),
    ideas,
  };
}

/** The space with a line between `a` and `b`, or without it. */
export const withLine = (space: ResearchSpace, a: string, b: string, on: boolean): ResearchSpace => ({
  ...space,
  relations: (on ? withRelation : withoutRelation)(space.relations, a, b),
});

/** Lines of the space between nodes in it. */
export const linesOf = (space: ResearchSpace, nodes: ReadonlySet<string>): Relation[] => cleanRelations(space.relations, nodes);
