import { ResearchSpace } from '../../types';

/** The research space's file in the account's repository (see ResearchSpace). */
export const SPACE_PATH = 'research-space.json';

export const emptySpace = (): ResearchSpace => ({ parents: {}, relations: [], ideas: {} });

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const texts = (value: unknown): Record<string, string> => Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/** A research space as stored; an empty one when there is none, and whatever is malformed in it left out. */
export function parseSpace(text: string | null): ResearchSpace {
  if (text === null) return emptySpace();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return emptySpace();
  }
  const stored = record(value);
  const relations = Array.isArray(stored.relations)
    ? stored.relations.filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string'))
    : [];
  return { parents: texts(stored.parents), relations, ideas: texts(stored.ideas) };
}

export const serializeSpace = (space: ResearchSpace): string => `${JSON.stringify(space, null, 2)}\n`;
