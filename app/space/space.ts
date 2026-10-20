/**
 * A research space (ResearchSpace) as a graph: the person's papers and ideas, each under the node it belongs to,
 * with lines drawn between related ones. It is built like a paper's logic (app/logic/tree.ts), with papers and
 * ideas in place of blocks.
 */
import { ResearchSpace } from '../../types';
import { Relation, cleanRelations, withRelation, withoutRelation } from '../logic/graph';
import { LogicTree, cleanLogic, logicTree, placedIn, withPlacement, withoutBlock } from '../logic/tree';

/** A new idea's ID: "idea-" and lowercase letters and digits, with a little chance in it. */
export const newIdeaId = (): string => `idea-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const isIdea = (id: string): boolean => id.startsWith('idea-');

/** What can be a node: the person's papers (in their order), then the space's ideas. */
const nodesOf = (space: ResearchSpace, paperIds: readonly string[]): { id: string }[] => [...paperIds, ...Object.keys(space.ideas)].map((id) => ({ id }));

/** The space's tree: the nodes placed in it, each under its own; one under a node that is gone is at the top. */
export const spaceTree = (space: ResearchSpace, paperIds: readonly string[]): LogicTree => logicTree({ blocks: nodesOf(space, paperIds), logic: space.parents });

/** The nodes in the space, as a set. */
export const inSpace = (space: ResearchSpace, paperIds: readonly string[]): Set<string> => placedIn(nodesOf(space, paperIds), space.parents);

/**
 * The space without what is gone (papers deleted from the repository) and with lines only between nodes in it.
 * Ideas live only in the space: one no longer in it is gone too.
 */
export function cleanSpace(space: ResearchSpace, paperIds: readonly string[]): ResearchSpace {
  const nodes = nodesOf(space, paperIds);
  const kept = cleanLogic(nodes, space.parents);
  const placed = placedIn(nodes, kept);
  return {
    parents: kept,
    relations: cleanRelations(space.relations, placed),
    ideas: Object.fromEntries(Object.entries(space.ideas).filter(([id]) => placed.has(id))),
  };
}

/** The space with node `id` under `under`, or on its own (null); put in the space if it was not. */
export const withNode = (space: ResearchSpace, paperIds: readonly string[], id: string, under: string | null): ResearchSpace => ({
  ...space,
  parents: withPlacement(nodesOf(space, paperIds), space.parents, id, under),
});

/** The space with a new idea saying `text`, under `under` or on its own; and the idea's ID. */
export function withIdea(space: ResearchSpace, paperIds: readonly string[], text: string, under: string | null): { space: ResearchSpace; id: string } {
  const id = newIdeaId();
  return { space: withNode({ ...space, ideas: { ...space.ideas, [id]: text } }, paperIds, id, under), id };
}

/** The space with an idea saying `text` instead. */
export const withIdeaText = (space: ResearchSpace, id: string, text: string): ResearchSpace => ({ ...space, ideas: { ...space.ideas, [id]: text } });

/** The space without node `id`: the nodes under it go up to where it was, its lines go, and an idea is gone. */
export function withoutNode(space: ResearchSpace, paperIds: readonly string[], id: string): ResearchSpace {
  const ideas = { ...space.ideas };
  delete ideas[id];
  return {
    parents: withoutBlock(nodesOf(space, paperIds), space.parents, id),
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
