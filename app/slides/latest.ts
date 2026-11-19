import { ResultPaper, SlideDeck } from '../../types';

/**
 * Each paper's deck as last changed in this tab, kept until a save of exactly that deck lands. A slide view
 * opened again before then (back to the paper at once), and a presentation started from the paper's bar,
 * show it rather than the paper's older saved deck.
 */
const decks = new Map<string, SlideDeck | null>();
/** The text of an HTML deck changed in this tab (the deck itself holds only its hash), kept as long as the deck is. */
const texts = new Map<string, string>();

/** The deck to show for a paper: the one changed here while it is not saved yet, else the paper's own. */
export const deckOf = (paper: ResultPaper): SlideDeck | null => (decks.has(paper.id) ? decks.get(paper.id) ?? null : paper.slides ?? null);

/** The text of the paper's HTML deck while a change to it is not saved yet; otherwise nothing. */
export const unsavedText = (paper: ResultPaper): string | undefined => (decks.has(paper.id) ? texts.get(paper.id) : undefined);

/** A change to a paper's deck (null: the deck was dropped); an HTML deck's text goes with it. */
export const changedDeck = (paperId: string, deck: SlideDeck | null, text?: string): void => {
  decks.set(paperId, deck);
  if (text === undefined) texts.delete(paperId);
  else texts.set(paperId, text);
};

/** A save of `deck` landed: the paper has it now, unless the deck changed again since. */
export const savedDeck = (paperId: string, deck: SlideDeck | null): void => {
  if (decks.get(paperId) === deck) {
    decks.delete(paperId);
    texts.delete(paperId);
  }
};
