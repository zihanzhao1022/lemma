/**
 * An HTML deck from its file to the page that shows it, for the places that need the whole deck at once: the
 * presentation, and the files a deck is exported to.
 */
import type { ReadFile } from '../../editor/results/actions';
import { slidesPath } from '../../editor/results/slidesFile';
import { ResultPaper, SlideDeck } from '../../types';
import { resolveBlocks } from './blockHtml';
import { pictureOf } from './blockPicture';
import { DocumentMode, buildDocument } from './deckDocument';
import { HtmlDeck, parseDeck } from './htmlDeck';
import { unsavedText } from './latest';

/** An HTML deck as its file holds it: what was changed in this tab and is not saved yet, else the saved file. */
export async function loadHtmlDeck(paper: ResultPaper, deck: SlideDeck, readFile: ReadFile): Promise<HtmlDeck> {
  const text = unsavedText(paper) ?? new TextDecoder().decode(await readFile(slidesPath(paper.id), deck.html?.hash));
  return parseDeck(text);
}

/** The page for a deck, each slide's blocks in place. */
export async function htmlPage(html: HtmlDeck, paper: ResultPaper, readFile: ReadFile, mode: DocumentMode, lang: string, start?: { slide: number; step: number }): Promise<string> {
  const picture = pictureOf(readFile);
  const slides = await Promise.all(html.slides.map(async (slide) => ({ ...slide, html: await resolveBlocks(slide.html, paper, picture) })));
  return buildDocument({ ...html, slides }, { mode, lang, start });
}
