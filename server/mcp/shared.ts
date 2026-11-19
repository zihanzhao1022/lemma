/** What the MCP tools share: their shape, the arguments every tool takes, and finding the paper asked for. */
import { resultsCommitMessage } from '../../editor/results/ops';
import { ResultPaper } from '../../types';
import { Library, ToolError } from './library';

export interface Schema {
  type: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: string[];
  additionalProperties?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run: (args: Record<string, unknown>, library: Library) => Promise<string>;
}

/** Longest text a tool gives back in one go. */
export const MAX_TEXT = 200_000;

export const REPO: Schema = { type: 'string', description: 'owner/name of the OnizukaTex repository; needed only when the person has several.' };
export const PAPER: Schema = { type: 'string', description: 'The paper: its ID, slug or title, as list_papers shows them.' };

export const object = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', properties: { ...properties, repo: REPO }, required, additionalProperties: false });

export const given = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`Give ${what}.`);
  return value.trim();
};
export const optional = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export const message = (action: string, paper: ResultPaper): string => `${resultsCommitMessage(action, paper.title)} (Claude Code)`;

export function paperOf(papers: ResultPaper[], ref: unknown): ResultPaper {
  const wanted = given(ref, 'the paper (its ID, slug or title)');
  const lower = wanted.toLowerCase();
  const found =
    papers.find((paper) => paper.id === wanted) ??
    papers.find((paper) => paper.slug === wanted) ??
    papers.find((paper) => paper.title.trim().toLowerCase() === lower);
  if (found) return found;
  const near = papers.filter((paper) => paper.title.toLowerCase().includes(lower));
  if (near.length === 1) return near[0];
  const list = papers.map((paper) => `${paper.id} "${paper.title}"`).join('; ');
  throw new ToolError(`No paper "${wanted}"${near.length > 1 ? ' (several titles contain it)' : ''}. The papers: ${list || 'none'}.`);
}

export async function paperIn(library: Library, args: Record<string, unknown>): Promise<ResultPaper> {
  return paperOf(await library.papers(), args.paper);
}
