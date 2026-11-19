/**
 * The tags a slide uses to put a block of the paper on itself, read without drawing anything (the MCP server reads
 * them too): <lemma-block ref="label"> puts the block there, <lemma-chart ref="label" col="…"> draws a chart from a
 * table block's numbers (see blockHtml.ts for both).
 */
import { ResultBlock, ResultPaper } from '../../types';
import { unescapeHtml } from './htmlDeck';

export const BLOCK_TAG = /<lemma-block\b([^>]*?)\/?>(?:\s*<\/lemma-block>)?/gi;
export const CHART_TAG = /<lemma-chart\b([^>]*?)\/?>(?:\s*<\/lemma-chart>)?/gi;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A tag's attributes, names in lower case, values unescaped. */
export function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) found[match[1].toLowerCase()] = unescapeHtml(match[2] ?? match[3] ?? '');
  return found;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The block a ref names: its id, a label of its compiled output, or a \label in its LaTeX (a block not compiled yet has no output). */
export function findBlock(paper: ResultPaper, ref: string): ResultBlock | undefined {
  if (!ref) return undefined;
  const label = new RegExp(`\\\\label\\s*\\{${escapeRegExp(ref)}\\}`);
  return (
    paper.blocks.find((block) => block.id === ref) ??
    paper.blocks.find((block) => Object.keys(block.output?.labels ?? {}).includes(ref)) ??
    paper.blocks.find((block) => label.test(block.source ?? ''))
  );
}

/** The refs a slide's <lemma-block> and <lemma-chart> tags name. */
export const refsIn = (html: string): string[] =>
  [...new Set([...html.matchAll(BLOCK_TAG), ...html.matchAll(CHART_TAG)].map((match) => (attributes(match[1]).ref ?? '').trim()).filter(Boolean))];
