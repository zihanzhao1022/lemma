/**
 * A paper's slides, without the interface: the page and its default layout, decks made from the paper's figures
 * and tables, moving and resizing what is on a slide, and Beamer decks whose \lemmablock{label} puts a compiled
 * block of the paper on a frame.
 */
import { stripComments } from '../../editor/tex/document';
import { ResultBlock, ResultPaper, Slide, SlideBlock, SlideBox, SlideDeck, SlideElement, SlideText } from '../../types';

/** The page, in slide units (16:9). An exported .pptx is 13.333 × 7.5 in, a PDF 960 × 540 pt. */
export const SLIDE_WIDTH = 1600;
export const SLIDE_HEIGHT = 900;
const MARGIN = 80;
/** Where the default layout puts a slide's title, and its content under it. */
export const TITLE_BOX = { x: MARGIN, y: 56, w: SLIDE_WIDTH - 2 * MARGIN, h: 110 };
export const CONTENT_BOX = { x: MARGIN, y: 200, w: SLIDE_WIDTH - 2 * MARGIN, h: SLIDE_HEIGHT - 200 - 70 };

export type Area = Omit<SlideBox, 'id'>;
export type NewId = (prefix: string) => string;

let made = 0;
export const newId: NewId = (prefix) => `${prefix}-${Date.now().toString(36)}${(made++).toString(36)}`;

export const titleText = (text: string, id: string, box: Area = TITLE_BOX): SlideText => ({ id, type: 'text', ...box, text, size: 56, bold: true, role: 'title' });
export const bodyText = (text: string, id: string, box: Area = CONTENT_BOX): SlideText => ({ id, type: 'text', ...box, text, size: 34, role: 'body' });

/** A box of the given width:height inside an area, as large as fits and centered in it. */
export function fit(aspect: number, area: Area): Area {
  const byWidth = { w: area.w, h: area.w / aspect };
  const size = byWidth.h <= area.h ? byWidth : { w: area.h * aspect, h: area.h };
  return { x: area.x + (area.w - size.w) / 2, y: area.y + (area.h - size.h) / 2, ...size };
}

/** A block's width over its height, as compiled now (4:3 until it is compiled). */
export const aspectOf = (block: ResultBlock): number => (block.output && block.output.height > 0 ? block.output.width / block.output.height : 4 / 3);

/** A block of the paper on a slide, fitted into an area (the content area under a title by default). */
export const blockElement = (block: ResultBlock, id: string, area: Area = CONTENT_BOX): SlideBlock => ({ id, type: 'block', blockId: block.id, ...fit(aspectOf(block), area) });

/** What a block's first \caption says, as plain text. */
export function captionOf(source = ''): string {
  const text = stripComments(source);
  const at = text.search(/\\caption\s*(\[[^\]]*\])?\s*\{/);
  if (at < 0) return '';
  let depth = 0;
  let start = -1;
  for (let i = text.indexOf('{', at); i < text.length; i += 1) {
    if (text[i] === '{' && text[i - 1] !== '\\') {
      depth += 1;
      if (start < 0) start = i + 1;
    } else if (text[i] === '}' && text[i - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) return plain(text.slice(start, i));
    }
  }
  return '';
}

/** LaTeX as words: commands dropped (their arguments kept), braces, ties and math signs gone. */
export const plain = (latex: string): string =>
  latex
    .replace(/\\(?:label|ref|cite[a-z]*)\s*\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+\*?\s*/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}$]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    // What stood before a dropped citation leaves no space before the punctuation after it.
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim();

/** "表 1" / "图 2" for a figure or table, in the interface's language (given by the caller). */
export type Labeller = (kind: 'figure' | 'table', number: string | undefined) => string;

/** The figures and tables a deck can show, with their labels and captions. */
export function results(paper: ResultPaper, label: Labeller, number: (blocks: ResultBlock[], index: number) => string | undefined): { block: ResultBlock; label: string; caption: string }[] {
  return paper.blocks.flatMap((block, index) =>
    (block.kind === 'figure' || block.kind === 'table') && block.output && !block.hidden
      ? [{ block, label: label(block.kind, number(paper.blocks, index)), caption: captionOf(block.source) }]
      : [],
  );
}

/** At most `length` characters, cut at a word where there is one, with an ellipsis; a trailing period goes. */
export function shorten(text: string, length: number): string {
  const plainText = text.replace(/\.$/, '');
  if (plainText.length <= length) return plainText;
  const cut = plainText.slice(0, length);
  const space = cut.lastIndexOf(' ');
  return `${(space > length * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
}

/** Authors as the page writes them, without the bold marks around one's own name. */
const authorLine = (authors: string[]): string => authors.map((name) => name.replace(/\*\*/g, '')).join(', ');

/** A visual deck to start from: a title slide, then each figure and table under its label and caption. */
export function visualDeck(paper: ResultPaper, label: Labeller, number: (blocks: ResultBlock[], index: number) => string | undefined, make: NewId = newId): SlideDeck {
  const opening: Slide = {
    id: make('slide'),
    elements: [
      { ...titleText(paper.title, make('el'), { x: 160, y: 270, w: 1280, h: 190 }), size: 68, align: 'center' },
      { ...bodyText([authorLine(paper.authors), paper.venue ?? ''].filter(Boolean).join('\n'), make('el'), { x: 160, y: 500, w: 1280, h: 140 }), size: 32, align: 'center' },
    ],
  };
  // The block carries its whole caption; the title gives the gist on one line.
  const slides = results(paper, label, number).map(({ block, label: name, caption }): Slide => ({
    id: make('slide'),
    elements: [titleText(caption ? `${name}  ${shorten(caption, 40)}` : name, make('el')), blockElement(block, make('el'))],
  }));
  return { kind: 'visual', slides: [opening, ...slides] };
}

export type Layout = 'title-content' | 'title' | 'blank';

export function newSlide(layout: Layout, make: NewId = newId): Slide {
  if (layout === 'blank') return { id: make('slide'), elements: [] };
  if (layout === 'title') return { id: make('slide'), elements: [{ ...titleText('', make('el'), { x: 160, y: 340, w: 1280, h: 200 }), size: 64, align: 'center' }] };
  return { id: make('slide'), elements: [titleText('', make('el')), bodyText('', make('el'))] };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Moved by (dx, dy), staying on the page. */
export function moved<T extends SlideElement>(element: T, dx: number, dy: number): T {
  return { ...element, x: clamp(element.x + dx, 0, SLIDE_WIDTH - element.w), y: clamp(element.y + dy, 0, SLIDE_HEIGHT - element.h) };
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Resized by dragging a corner by (dx, dy). A block keeps its shape (the drag's larger change decides);
 * nothing gets smaller than 40 units or leaves the page.
 */
export function resized<T extends SlideElement>(element: T, corner: Corner, dx: number, dy: number, aspect?: number): T {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  let w = Math.max(40, element.w + (west ? -dx : dx));
  let h = Math.max(40, element.h + (north ? -dy : dy));
  if (aspect) {
    if (Math.abs(w - element.w) / element.w >= Math.abs(h - element.h) / element.h) h = w / aspect;
    else w = h * aspect;
  }
  const right = element.x + element.w;
  const bottom = element.y + element.h;
  let x = west ? right - w : element.x;
  let y = north ? bottom - h : element.y;
  // Back inside the page, shrinking (and keeping the shape) where it would run off.
  const room = { w: west ? right : SLIDE_WIDTH - x, h: north ? bottom : SLIDE_HEIGHT - y };
  const shrink = Math.min(1, room.w / w, room.h / h);
  if (shrink < 1) {
    w *= shrink;
    h *= shrink;
    if (west) x = right - w;
    if (north) y = bottom - h;
  }
  x = Math.max(0, x);
  y = Math.max(0, y);
  return { ...element, x, y, w, h };
}

/** A position pulled to the page's center line or edges, and to a grid of 10, when it is close. */
export function snapped(position: number, size: number, page: number): { value: number; guide?: number } {
  const center = (page - size) / 2;
  if (Math.abs(position - center) <= 8) return { value: center, guide: page / 2 };
  for (const edge of [MARGIN, page - MARGIN - size]) if (Math.abs(position - edge) <= 6) return { value: edge, guide: edge === MARGIN ? MARGIN : page - MARGIN };
  return { value: Math.round(position / 10) * 10 };
}

/* ------------------------------------------------------------------ Beamer */

const LATEX_SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '\u2026': '\\dots{}',
};

/** LaTeX's special characters (and an ellipsis), escaped in one pass for a title or an author list. */
export const escapeLatex = (text: string): string => text.replace(/[\\{}&%$#_~^\u2026]/g, (char) => LATEX_SPECIAL[char]);

/**
 * What LaTeX's default UTF-8 setup sets with Beamer's fonts: ASCII, Latin-1, Latin Extended-A (but for the few
 * letters only T1 fonts have) and the usual dashes, quotes and ellipsis. Chinese, Greek, ≤ and the like need
 * packages the deck does not load.
 */
const SETTABLE = /^[\u0020-\u007e\u00a0-\u010f\u0112-\u0149\u014c-\u017f\u2013\u2014\u2018\u2019\u201c\u201d\u2026]*$/;

/** A line of the title frame, on one line; commented out when pdfTeX could not set it here. */
function metaLine(command: string, text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return SETTABLE.test(line) ? `\\${command}{${escapeLatex(line)}}` : `% \\${command}{${line}}  % left out: pdfTeX here cannot set some of these characters`;
}

/** What \lemmablock can name: each block's own LaTeX labels (fig:acc) and its id. */
export function blockRefs(paper: ResultPaper): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const block of paper.blocks) {
    if (!block.output) continue;
    refs[block.id] = block.id;
    for (const name of Object.keys(block.output.labels ?? {})) refs[name] ??= block.id;
  }
  return refs;
}

/** The name \lemmablock should use for a block: its first label, or its id. */
export function refFor(block: ResultBlock): string {
  return Object.keys(block.output?.labels ?? {})[0] ?? block.id;
}

/** Figures and tables named in English: pdfTeX here sets Latin script only, whatever the interface's language. */
const latinLabel: Labeller = (kind, number) => `${kind === 'figure' ? 'Figure' : 'Table'}${number ? ` ${number}` : ''}`;

/** A Beamer deck to start from: a title frame, then a frame for each figure and table. */
export function beamerDeck(paper: ResultPaper, number: (blocks: ResultBlock[], index: number) => string | undefined): SlideDeck {
  const frames = results(paper, latinLabel, number).map(
    ({ block, label: name, caption }) => `\\begin{frame}{${escapeLatex(caption && SETTABLE.test(caption) ? `${name}: ${shorten(caption, 40)}` : name)}}
  \\centering
  \\lemmablock{${refFor(block)}}
\\end{frame}`,
  );
  const beamer = [
    '\\documentclass[aspectratio=169]{beamer}',
    '\\usetheme{default}',
    '\\setbeamertemplate{navigation symbols}{}',
    metaLine('title', paper.title),
    metaLine('author', authorLine(paper.authors)),
    ...(paper.venue ? [metaLine('date', paper.venue)] : []),
    '',
    '\\begin{document}',
    '',
    '\\begin{frame}',
    '  \\titlepage',
    '\\end{frame}',
    '',
    ...frames.flatMap((frame) => [frame, '']),
    '\\end{document}',
    '',
  ].join('\n');
  return { kind: 'beamer', slides: [], beamer };
}

const LEMMABLOCK = /\\lemmablock\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

/** The labels and ids a Beamer source puts on its frames with \lemmablock[options]{name}. */
export const usedRefs = (source: string): string[] => [...new Set([...stripComments(source).matchAll(LEMMABLOCK)].map((match) => match[1].trim()))];

/** The line of a Beamer source where \lemmablock first names `name`, if it does. */
export function lemmablockLine(source: string, name: string): number | undefined {
  const text = stripComments(source);
  const at = [...text.matchAll(LEMMABLOCK)].find((match) => match[1].trim() === name)?.index;
  return at === undefined ? undefined : text.slice(0, at).split('\n').length;
}

/** Where a block's compiled PDF goes next to the Beamer deck's main.tex. */
export const blockFile = (blockId: string): string => `lemma-blocks/${blockId}.pdf`;

/**
 * A Beamer deck ready to compile: \lemmablock[options]{name} defined on one line put before the source (so TeX's
 * line numbers are the source's plus one), drawing the named block's PDF from lemma-blocks/ as large as fits the
 * frame. A name the paper has not got is a clear error.
 */
export function beamerMain(source: string, refs: Record<string, string>): string {
  const names = Object.entries(refs)
    .filter(([name]) => /^[^\\{}%#\s]+$/.test(name))
    .map(([name, id]) => `\\@namedef{lemma@block@${name}}{${id}}`)
    .join('');
  const support =
    '\\makeatletter' +
    '\\providecommand\\lemmablock[2][]{\\@ifundefined{lemma@block@#2}{\\PackageError{lemma}{This paper has no block or label "#2"}{Use a label of one of its figures or tables, or a block id.}}{\\includegraphics[width=\\linewidth,height=0.8\\textheight,keepaspectratio,#1]{lemma-blocks/\\csname lemma@block@#2\\endcsname.pdf}}}' +
    names +
    '\\makeatother';
  return `${support}\n${source}`;
}

/** TeX's line in a compiled Beamer deck, as a line of its source (see beamerMain). */
export const beamerLine = (line: number): number => line - 1;

/** Slides with elements of a block that no longer exists taken off, e.g. after the block was deleted. */
export const withoutMissing = (deck: SlideDeck, paper: ResultPaper): SlideDeck => ({
  ...deck,
  slides: deck.slides.map((slide) => ({ ...slide, elements: slide.elements.filter((element) => element.type !== 'block' || paper.blocks.some((block) => block.id === element.blockId)) })),
});
