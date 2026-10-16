import { blockNumber } from '../../lib/headings';
import { ResultPaper } from '../../types';
import { captionOf, plain, shorten } from '../slides/deck';
import { headingTitles } from './tree';

/** What a block is called in the logic view: a heading, "Table 2", or its first words; and what follows. */
export interface NodeLabel {
  title: string;
  detail?: string;
}

/** The interface's words for what has no heading, in its language (given by the caller). */
export interface LabelWords {
  figure: (number?: string) => string;
  table: (number?: string) => string;
  abstract: string;
  empty: string;
}

const HEADING = /\\(?:sub)*section\*?\s*(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}|\\paragraph\*?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g;

/** A text block's words, without headings, environments and comments. */
export function wordsOf(source = ''): string {
  return plain(
    source
      .replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, '$1$2')
      .replace(HEADING, ' ')
      .replace(/\\(?:begin|end)\s*\{[^}]*\}(?:\[[^\]]*\])?/g, ' ')
      .replace(/\\(?:appendix|maketitle|label\s*\{[^}]*\})/g, ' '),
  );
}

/** Each block's label: text by its first heading (or its first words), figures and tables by number and caption. */
export function nodeLabels(paper: Pick<ResultPaper, 'blocks' | 'preamble'>, words: LabelWords): Record<string, NodeLabel> {
  const headings = headingTitles(paper);
  const labels: Record<string, NodeLabel> = {};
  paper.blocks.forEach((block, index) => {
    if (block.kind === 'figure' || block.kind === 'table') {
      const number = blockNumber(paper.blocks, index);
      const caption = captionOf(block.source);
      labels[block.id] = { title: block.kind === 'figure' ? words.figure(number) : words.table(number), ...(caption ? { detail: shorten(caption, 90) } : {}) };
      return;
    }
    const text = wordsOf(block.source);
    const heading = headings[block.id];
    if (heading) labels[block.id] = { title: heading, ...(text ? { detail: shorten(text, 90) } : {}) };
    else if (/\\begin\s*\{abstract\}/.test(block.source ?? '')) labels[block.id] = { title: words.abstract, ...(text ? { detail: shorten(text, 90) } : {}) };
    else labels[block.id] = { title: text ? shorten(text, 40) : words.empty, ...(text.length > 40 ? { detail: shorten(text, 90) } : {}) };
  });
  return labels;
}
