/**
 * The results library of the Management page: every figure and table of the account's own papers, each with the
 * paper it belongs to and where it is used (the paper's text and its slides).
 */
import { stripComments } from '../../editor/tex/document';
import { blockNumber } from '../../lib/headings';
import { tagsOfMark } from '../../editor/results/ops';
import { FloatKind, ResultBlock, ResultPaper } from '../../types';
import { captionOf, plain, usedRefs } from '../slides/deck';
import { findBlock } from '../slides/blockTags';
import { parseDeck } from '../slides/htmlDeck';
import { sourceIds } from '../slides/sources';
import { SyncState, copiesOf, homeOf, syncState } from './carry';

export interface LibraryItem {
  /** "<paper id>/<block id>". */
  key: string;
  paper: ResultPaper;
  block: ResultBlock;
  kind: FloatKind;
  /** As the paper numbers it ("3"), once compiled. */
  number?: string;
  /** The caption as plain text; "" for none. */
  caption: string;
  /** The names \label gives it, compiled ones first. */
  labels: string[];
  /** The text blocks of its paper that \ref (or \cref, \autoref…) one of its labels. */
  citedBy: string[];
  /** The slides of its paper's deck that show it, counted from 1. */
  slides: number[];
  /** Its copies in the owner's other papers, each with how it compares with this block. */
  copies: { paper: ResultPaper; block: ResultBlock; state: SyncState }[];
}

const LABEL = /\\label\s*\{([^}]*)\}/g;
const REF = /\\(?:ref|cref|Cref|autoref|pageref|nameref|vref|cpageref|subref)\*?\s*\{([^}]*)\}/g;

/** The names a block's \label gives it: those its compiled output defined, then any written since. */
export function labelsOf(block: ResultBlock): string[] {
  const compiled = Object.keys(block.output?.labels ?? {});
  const written = [...stripComments(block.source ?? '').matchAll(LABEL)].map((match) => match[1].trim());
  return [...new Set([...compiled, ...written])].filter(Boolean);
}

/** The labels a LaTeX source refers to with \ref and its kin; \cref{a,b} names two. */
export const refsOf = (source = ''): string[] => [
  ...new Set([...stripComments(source).matchAll(REF)].flatMap((match) => match[1].split(',').map((name) => name.trim())).filter(Boolean)),
];

/**
 * For each block of a paper, the slides of its deck that show it (from 1). A visual deck's block elements, a Beamer
 * deck's \lemmablock in each frame, an HTML deck's <lemma-block> and data-from (its file's text, given as `html`).
 */
export function slidesOfBlocks(paper: ResultPaper, html?: string): Record<string, number[]> {
  const deck = paper.slides;
  const found: Record<string, number[]> = {};
  const add = (id: string, slide: number) => {
    const list = (found[id] ??= []);
    if (!list.includes(slide)) list.push(slide);
  };
  if (!deck) return found;
  if (deck.kind === 'visual') {
    deck.slides.forEach((slide, index) => {
      for (const element of slide.elements) if (element.type === 'block') add(element.blockId, index + 1);
    });
  } else if (deck.kind === 'beamer') {
    const frames = stripComments(deck.beamer ?? '')
      .split(/\\begin\s*\{frame\}/)
      .slice(1);
    frames.forEach((frame, index) => {
      for (const ref of usedRefs(frame)) {
        const block = findBlock(paper, ref);
        if (block) add(block.id, index + 1);
      }
    });
  } else if (html !== undefined) {
    let slides: { html: string }[] = [];
    try {
      slides = parseDeck(html).slides;
    } catch {
      slides = [];
    }
    slides.forEach((slide, index) => {
      for (const id of sourceIds(slide.html, paper)) add(id, index + 1);
    });
  }
  return found;
}

/**
 * The figures and tables of the given papers, paper by paper in the order given and in each paper's order.
 * `htmlDecks` holds the text of the HTML decks read so far, by paper ID. Copies and the blocks they came from are
 * looked for in `all` (archived papers too), not only in the papers listed.
 */
export function libraryItems(papers: ResultPaper[], htmlDecks: Record<string, string> = {}, all: ResultPaper[] = papers): LibraryItem[] {
  return papers.flatMap((paper) => {
    const slides = slidesOfBlocks(paper, htmlDecks[paper.id]);
    const refs = paper.blocks.map((block) => (block.kind === 'text' ? refsOf(block.source) : []));
    return paper.blocks.flatMap((block, index): LibraryItem[] => {
      if (block.kind !== 'figure' && block.kind !== 'table') return [];
      // A copy shows under the block it came from, unless that is gone.
      if (block.origin && homeOf(block.origin, all)) return [];
      const labels = labelsOf(block);
      const citedBy = paper.blocks.filter((other, at) => other.id !== block.id && refs[at].some((name) => labels.includes(name))).map((other) => other.id);
      return [
        {
          key: `${paper.id}/${block.id}`,
          paper,
          block,
          kind: block.kind,
          number: blockNumber(paper.blocks, index),
          caption: plain(captionOf(block.source)),
          labels,
          citedBy,
          slides: slides[block.id] ?? [],
          copies: copiesOf(paper.id, block.id, all).map((copy) => ({ ...copy, state: syncState(copy.block, all) ?? 'synced' })),
        },
      ];
    });
  });
}

export interface LibraryFilter {
  kind?: FloatKind;
  /** Only items with every one of these tags (ResultBlock.mark). */
  tags?: string[];
  /** A paper's ID. */
  paper?: string;
  search?: string;
}

/** The items a filter keeps: of that kind, from that paper, with all those tags, and with every word of the search in the caption, a label, the tag or the paper's title. */
export function filterItems(items: LibraryItem[], filter: LibraryFilter): LibraryItem[] {
  const words = (filter.search ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter.kind && item.kind !== filter.kind) return false;
    if (filter.paper && item.paper.id !== filter.paper) return false;
    if (filter.tags && filter.tags.length > 0) {
      const own = tagsOfMark(item.block.mark);
      if (!filter.tags.every((tag) => own.includes(tag))) return false;
    }
    if (words.length === 0) return true;
    const text = [item.caption, ...item.labels, item.paper.title, item.paper.venue ?? '', ...tagsOfMark(item.block.mark)].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The tags given to the items, each with how many have it, in the order they first appear. */
export function tagsOf(items: LibraryItem[]): { tag: string; count: number }[] {
  const found = new Map<string, number>();
  for (const item of items) for (const tag of tagsOfMark(item.block.mark)) found.set(tag, (found.get(tag) ?? 0) + 1);
  return [...found].map(([tag, count]) => ({ tag, count }));
}
