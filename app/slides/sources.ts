/**
 * What a slide was written from, so that a block changed since can be pointed out: the blocks it puts on itself
 * (<lemma-block>, <lemma-chart>) and those its <section data-from="…"> names, each with a hash of its LaTeX. A slide
 * records them when it is written (stamped) and when someone says it was checked; a block whose LaTeX differs now, or
 * that is gone, is one to check. Read without drawing anything: the MCP server uses it too.
 */
import { hashText } from '../../editor/results/numbering';
import { ResultBlock, ResultPaper } from '../../types';
import { findBlock, refsIn } from './blockTags';
import { HtmlDeck, HtmlSlide } from './htmlDeck';

/** A short hash of a block's LaTeX. */
export const sourceHash = (block: ResultBlock): string => hashText(block.source ?? '').slice(-8);

/** The ids of the blocks a slide's markup is written from, in the order it names them. */
export function sourceIds(html: string, paper: ResultPaper): string[] {
  const named = /<section\b[^>]*\bdata-from\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ?? '';
  const refs = [...refsIn(html), ...named.split(/\s+/).filter(Boolean)];
  return [...new Set(refs.map((ref) => findBlock(paper, ref)?.id).filter((id): id is string => !!id))];
}

/** The blocks a slide's markup is written from, each with the hash of its LaTeX now. */
export function sourcesOf(html: string, paper: ResultPaper): Record<string, string> {
  return Object.fromEntries(
    sourceIds(html, paper).flatMap((id) => {
      const block = paper.blocks.find((item) => item.id === id);
      return block ? [[id, sourceHash(block)]] : [];
    }),
  );
}

/**
 * The deck with what each slide was written from: a slide whose markup is what it was in `before` keeps what it
 * had; a slide written since (or new) records its blocks as they are now.
 */
export function stamped(next: HtmlDeck, before: HtmlDeck | null, paper: ResultPaper): HtmlDeck {
  const old = new Map((before?.slides ?? []).map((slide) => [slide.id, slide]));
  return {
    ...next,
    slides: next.slides.map((slide): HtmlSlide => {
      const was = old.get(slide.id);
      const kept = was && was.html === slide.html ? (slide.seen ?? was.seen) : undefined;
      return { ...slide, seen: kept ?? sourcesOf(slide.html, paper) };
    }),
  };
}

/** The blocks a slide was written from that changed since, or are gone. */
export function changedSources(slide: HtmlSlide, paper: ResultPaper): string[] {
  return Object.entries(slide.seen ?? {})
    .filter(([id, hash]) => {
      const block = paper.blocks.find((item) => item.id === id);
      return !block || sourceHash(block) !== hash;
    })
    .map(([id]) => id);
}

/** The deck with one slide checked against its blocks as they are now. */
export function checkedSlide(deck: HtmlDeck, index: number, paper: ResultPaper): HtmlDeck {
  return { ...deck, slides: deck.slides.map((slide, at) => (at === index ? { ...slide, seen: sourcesOf(slide.html, paper) } : slide)) };
}
