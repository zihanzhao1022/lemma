/**
 * An HTML deck as the file it is kept in, and the deck a paper starts from. The file is a plain HTML document:
 * the title, a footer line, a brief at the top (what the talk is for, written for whoever writes the slides), the
 * deck's own style, then each slide as a <section class="slide"> after a `<!-- slide: id -->` line, so the history
 * of the file reads slide by slide. A slide puts a block of the paper on itself with <lemma-block ref="label">
 * (see blockHtml.ts).
 */
import { ResultBlock, ResultPaper } from '../../types';
import { Labeller, partsOpened, refFor, results, shorten } from './deck';

export interface HtmlSlide {
  id: string;
  /** The slide's markup, a <section class="slide">…</section>. */
  html: string;
  /**
   * The blocks the slide was written from (those it puts on itself and those its data-from names), each with a hash
   * of its LaTeX when the slide was last written (see sources.ts): a block changed since is one to check.
   */
  seen?: Record<string, string>;
}

export interface HtmlDeck {
  title: string;
  /** The line at the foot of every slide, before the page number. */
  footer: string;
  /** What the talk is for: the occasion, its length, the audience, what to stress, the language. */
  brief: string;
  /** The deck's own style: a few variables, and overrides of the kit's. */
  css: string;
  slides: HtmlSlide[];
}

/* ------------------------------------------------------------------ text */

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const unescapeHtml = (text: string): string => text.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** Markup as the words it shows: tags dropped, entities read, spaces collapsed. */
export const textOf = (html: string): string => unescapeHtml(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** A slide's title: its first heading. */
export function slideTitle(html: string): string {
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html) ?? /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
  return heading ? textOf(heading[1]) : '';
}

/* ------------------------------------------------------------------ the file */

const MARKER = /^[ \t]*<!--\s*slide:\s*([^\s>]+?)(?:\s+from:\s*([^>]*?))?\s*-->[ \t]*$/gm;
/** Blank lines at both ends gone, the indentation inside kept. */
const trimBlock = (text: string): string => text.replace(/^\s*\n/, '').replace(/\s+$/, '');

/** The deck a file holds. What the file lacks is empty; a file without slide lines is one slide. */
export function parseDeck(text: string): HtmlDeck {
  const title = unescapeHtml(/<title>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim() ?? '');
  const footer = unescapeHtml(/<meta\s+name=["']footer["']\s+content=["']([^"']*)["']/i.exec(text)?.[1] ?? '');
  const css = trimBlock(/<style\s+id=["']deck["'][^>]*>([\s\S]*?)<\/style>/i.exec(text)?.[1] ?? '');
  const briefAt = /<!--\s*brief\b([\s\S]*?)-->/.exec(text);
  const brief = briefAt ? trimBlock(briefAt[1]).replace(/--&gt;/g, '-->') : '';
  const bodyAt = /<body[^>]*>/i.exec(text);
  const headEnd = /<\/head>/i.exec(text);
  let body = bodyAt ? text.slice(bodyAt.index + bodyAt[0].length) : headEnd ? text.slice(headEnd.index + headEnd[0].length) : text;
  body = body.replace(/<\/body>[\s\S]*$/i, '').replace(/<!--\s*brief\b[\s\S]*?-->/, '');

  const marks = [...body.matchAll(MARKER)];
  const slides: HtmlSlide[] = [];
  const taken = new Set<string>();
  const unique = (id: string): string => {
    let name = id;
    for (let n = 2; taken.has(name); n += 1) name = `${id}-${n}`;
    taken.add(name);
    return name;
  };
  if (marks.length === 0) {
    if (body.trim()) slides.push({ id: unique('s1'), html: body.trim() });
  } else {
    marks.forEach((mark, index) => {
      const from = (mark.index ?? 0) + mark[0].length;
      const to = index + 1 < marks.length ? marks[index + 1].index ?? body.length : body.length;
      const seen = Object.fromEntries((mark[2] ?? '').split(/\s+/).flatMap((pair) => (/^[^@\s]+@[0-9a-f]+$/.test(pair) ? [pair.split('@') as [string, string]] : [])));
      slides.push({ id: unique(mark[1]), html: body.slice(from, to).trim(), ...(Object.keys(seen).length > 0 ? { seen } : {}) });
    });
  }
  return { title, footer, brief, css, slides };
}

/** " from: blk-a@1a2b3c4d blk-b@…" on a slide's line: the blocks it was written from (HtmlSlide.seen). */
const fromOf = (slide: HtmlSlide): string => {
  const pairs = Object.entries(slide.seen ?? {}).map(([id, hash]) => `${id}@${hash}`);
  return pairs.length > 0 ? ` from: ${pairs.join(' ')}` : '';
};

/** The file for a deck: parseDeck reads back what this writes. */
export function serializeDeck(deck: HtmlDeck): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(deck.title)}</title>`,
    `<meta name="footer" content="${escapeHtml(deck.footer)}">`,
    '<style id="deck">',
    deck.css.trim(),
    '</style>',
    '</head>',
    '<body>',
    '<!-- brief',
    deck.brief.trim().replace(/-->/g, '--&gt;'),
    '-->',
    '',
    ...deck.slides.map((slide) => `<!-- slide: ${slide.id}${fromOf(slide)} -->\n${slide.html.trim()}\n`),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ editing the list of slides */

/** An id no slide of the deck has yet: s2, s3 … */
export function newSlideId(deck: HtmlDeck, prefix = 's'): string {
  let n = deck.slides.length + 1;
  while (deck.slides.some((slide) => slide.id === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** A new slide's markup: a title and room for what goes under it. */
export const blankSlide = (title = ''): string => `<section class="slide">\n  <h1 class="title">${escapeHtml(title)}</h1>\n  <div class="content">\n  </div>\n</section>`;

const replaced = (deck: HtmlDeck, slides: HtmlSlide[]): HtmlDeck => ({ ...deck, slides });

/** A slide put at `at` (the end when left out). */
export function withSlide(deck: HtmlDeck, slide: HtmlSlide, at = deck.slides.length): HtmlDeck {
  const slides = deck.slides.slice();
  slides.splice(Math.max(0, Math.min(at, slides.length)), 0, slide);
  return replaced(deck, slides);
}

export const withoutSlide = (deck: HtmlDeck, index: number): HtmlDeck => replaced(deck, deck.slides.filter((_, at) => at !== index));

/** A slide moved by `by` places (−1: one earlier), staying inside the deck. */
export function movedSlide(deck: HtmlDeck, index: number, by: number): HtmlDeck {
  const target = Math.max(0, Math.min(deck.slides.length - 1, index + by));
  if (target === index || !deck.slides[index]) return deck;
  const slides = deck.slides.slice();
  const [slide] = slides.splice(index, 1);
  slides.splice(target, 0, slide);
  return replaced(deck, slides);
}

/** A copy of a slide right after it, under a new id. */
export function duplicatedSlide(deck: HtmlDeck, index: number): HtmlDeck {
  const slide = deck.slides[index];
  return slide ? withSlide(deck, { ...slide, id: newSlideId(deck) }, index + 1) : deck;
}

export const withSlideHtml = (deck: HtmlDeck, index: number, html: string): HtmlDeck => replaced(deck, deck.slides.map((slide, at) => (at === index ? { ...slide, html } : slide)));

/* ------------------------------------------------------------------ the deck a paper starts from */

/** The words the starting deck needs, in the interface's language (the Chinese is not written here: see visualDeck). */
export interface StarterLabels {
  figure: (number: string | undefined) => string;
  table: (number: string | undefined) => string;
  /** A part's name in the list of parts, e.g. "Part 2". */
  part: (n: number) => string;
  /** What the brief starts as: a line each for the occasion, the length, the audience, what to stress and the language. */
  brief: string;
}

const authorLine = (authors: string[]): string => authors.map((name) => name.replace(/\*\*/g, '')).join(', ');

/** "Ada Example et al. · Made-up Conf 2027": who and where, for the foot of every slide. */
function footerOf(paper: ResultPaper): string {
  const names = paper.authors.map((name) => name.replace(/\*\*/g, ''));
  const who = names.length > 1 ? `${names[0]} et al.` : (names[0] ?? '');
  return [who, paper.venue ?? ''].filter(Boolean).join(' · ');
}

const STYLE = `/* This deck's own style: a few variables, and overrides of the kit's. */
:root {
  --accent: #23509a;
}`;

/** The title slide, the slide before each part and one slide for each figure and table, in the order the paper's logic gives. */
export function starterHtmlDeck(paper: ResultPaper, labels: StarterLabels, number: (blocks: ResultBlock[], index: number) => string | undefined): HtmlDeck {
  const labeller: Labeller = (kind, n) => (kind === 'figure' ? labels.figure(n) : labels.table(n));
  const shown = results(paper, labeller, number);
  const opened = partsOpened(
    paper,
    shown.map(({ block }) => block),
  );
  const topParts = shown.flatMap(({ block }) => (opened[block.id] ?? []).filter((part) => part.depth === 0).map((part) => part.title));

  const slides: HtmlSlide[] = [
    {
      id: 'cover',
      html: `<section class="slide cover">\n  <h1 class="title">${escapeHtml(paper.title)}</h1>\n  <p class="authors">${escapeHtml(authorLine(paper.authors))}</p>${paper.venue ? `\n  <p class="venue">${escapeHtml(paper.venue)}</p>` : ''}\n</section>`,
    },
  ];
  let part = 0;
  let sub = 0;
  let result = 0;
  for (const { block, label, caption } of shown) {
    for (const opening of opened[block.id] ?? []) {
      if (opening.depth === 0) {
        part += 1;
        const nav = topParts.map((name, at) => `    <li${at + 1 === part ? ' class="cur"' : ''}><span class="n">${escapeHtml(labels.part(at + 1))}</span>${escapeHtml(name)}</li>`).join('\n');
        slides.push({ id: `part-${part}`, html: `<section class="slide divider">\n  <p class="part">${escapeHtml(labels.part(part))}</p>\n  <h1 class="title">${escapeHtml(opening.title)}</h1>\n  <ol class="nav">\n${nav}\n  </ol>\n</section>` });
      } else {
        sub += 1;
        slides.push({ id: `sub-${sub}`, html: `<section class="slide divider sub">\n  <h1 class="title">${escapeHtml(opening.title)}</h1>\n</section>` });
      }
    }
    result += 1;
    // The title gives the gist in one line; the caption under a table has the rest (a figure's compiled PDF has its own).
    const gist = shorten(caption.split(/\.\s/)[0], 70);
    const text = caption && block.kind === 'table' ? `\n    <p class="caption"><b>${escapeHtml(label)}.</b> ${escapeHtml(caption)}</p>` : '';
    slides.push({
      id: `res-${result}`,
      html: `<section class="slide">\n  <h1 class="title">${escapeHtml(gist || label)}</h1>\n  <div class="content">\n    <lemma-block ref="${escapeHtml(refFor(block))}"></lemma-block>${text}\n  </div>\n</section>`,
    });
  }
  return { title: paper.title, footer: footerOf(paper), brief: labels.brief, css: STYLE, slides };
}
