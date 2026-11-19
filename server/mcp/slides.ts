/**
 * The MCP tools for a paper's HTML slides: the deck is the file results/<paper>/slides.html (app/slides/htmlDeck.ts
 * reads and writes it) and the paper keeps only its hash; a change writes both in one commit, as OnizukaTex's slide
 * page does. The guide (slides_guide) tells whoever writes the slides what a slide can hold and how much may move.
 */
import { BLOCK_TAG, CHART_TAG, attributes, findBlock } from '../../app/slides/blockTags';
import { HtmlDeck, StarterLabels, newSlideId, parseDeck, serializeDeck, slideTitle, starterHtmlDeck, withSlide, withSlideHtml, withoutSlide } from '../../app/slides/htmlDeck';
import { changedSources, checkedSlide, stamped } from '../../app/slides/sources';
import { hashText } from '../../editor/results/numbering';
import { slidesPath } from '../../editor/results/slidesFile';
import { blockNumber } from '../../lib/headings';
import { ResultPaper, SlideDeck } from '../../types';
import { Library, ToolError } from './library';
import { MAX_TEXT, PAPER, Schema, Tool, given, message, object, optional, paperIn } from './shared';

const SLIDE: Schema = { type: 'string', description: 'A slide ID, as get_slides lists them.' };
const SLIDE_HTML: Schema = { type: 'string', description: 'The slide: one <section class="slide">…</section> (see slides_guide).' };

/** The deck's words in English: Claude Code writes the deck in the language its brief asks for. */
const LABELS: StarterLabels = {
  figure: (number) => `Figure${number ? ` ${number}` : ''}`,
  table: (number) => `Table${number ? ` ${number}` : ''}`,
  part: (n) => `Part ${n}`,
  brief: 'Occasion:\nLength:\nAudience:\nFocus:\nLanguage:',
};

export const SLIDES_GUIDE = `How to write a paper's HTML slides in OnizukaTex.

THE DECK
A deck has a title, a footer line (shown on every slide with the page number), a brief (the occasion, length,
audience, what to stress and the language, written by the person: follow it), its own style (CSS: a few variables,
e.g. :root { --accent: #23509a; }) and its slides. Each slide is one <section class="slide">…</section>, 16:9.
Sizes are in cqw (1cqw = 1% of the slide's width); never px. The kit gives a white, academic look; keep it.

A SLIDE
  <section class="slide">
    <h1 class="title">EM: Ours is 5.8 points above the strongest baseline</h1>
    <div class="content">
      <lemma-block ref="tab:main"></lemma-block>
      <p class="caption"><b>Table 2.</b> Average results over 8 datasets. Best in bold, second best underlined.</p>
    </div>
  </section>
- The title is the slide's one message, stated as a finding, in one line (about 60 characters at most).
- .content holds paragraphs (2.2cqw), <ul>/<ol>, a <dl class="facts"> (<dt> name, <dd> text), blocks and charts.
- A title slide: <section class="slide cover"> with h1.title, p.authors, p.venue. Before a part:
  <section class="slide divider"> with p.part, h1.title and <ol class="nav"> (the current part's <li class="cur">).
- Numbers and claims come from the paper: read the blocks (read_blocks) and never invent a result.
- A slide whose words sum up blocks of the paper says which: data-from="blk-… blk-…" on its <section>. A slide
  remembers the blocks it was written from; when one changes, get_slides says so and the slide is to be checked.
- Speaker's notes go in <aside class="notes">…</aside> inside the slide: shown only in the speaker's view.
- Scripts, event handlers, iframes and outside resources are stripped or blocked; images must be data: URLs.
  Do not write animations, transitions or keyframes of your own.

BLOCKS OF THE PAPER
<lemma-block ref="tab:main"></lemma-block> puts a block on the slide (ref: a \\label of the block or its ID, as
get_paper shows). A table becomes a real table set as the paper sets it (rules, bold best, underlined second);
every cell carries data-row (the text of its row's first cell), data-col (the header over it), data-r and data-c.
A figure, a text block or a table that cannot be read becomes a picture of the compiled block.

FOCUS ON A TABLE
focus="selector; selector" on a table's <lemma-block>: each selector is one click, pointing at rows or cells; what
is in focus keeps its ink, the rest goes grey and a pale band moves to it. E.g.
  focus='tr[data-row="Ours"]; td[data-col="EM"]:is([data-row="Ours"],[data-row="Method E"])'

STEPS
data-step="1" on an element: it fades in at that click.

CHARTS
<lemma-chart ref="tab:main" col="EM" base="Method E"></lemma-chart> draws a bar chart of one column of a table
block. col: the header's text (or its number, 1 = the first after the row names). Optional: rows="A; B; Ours"
(which rows, in this order), ours="Ours" (the row in the accent colour; the bold one by default), base="Method E"
(a dashed line at that row's number and the gain over it, shown at a step), step="1" (which click), max="50" (axis end).
Put the chart on the slide right after (or before) the slide with that table: the numbers of ours and base travel
from the table into the chart and its bars grow to meet them. That move is the only thing that travels in a deck.

HOW MUCH MOVES (the person wants the motion quiet and academic)
- By default nothing moves: a slide changes by fading out and in.
- One thing per click. At most two steps on a slide.
- Steps on a minority of slides (about a third at most).
- The table-to-chart move two or three times in a talk at most, never on two pairs in a row.
- No big lone numbers, counting numbers, items flying in one after another, bounces or loops.

WORKING
get_slides shows the deck and checks it (missing blocks, too many steps, scripts). Change it slide by slide with
update_slide, add_slide, move_slide and delete_slide, and the rest with update_deck. Each change is a commit; the
person sees it on the paper's Slides page in OnizukaTex.`;

/* ------------------------------------------------------------------ reading and saving the deck */

interface Opened {
  deck: HtmlDeck;
  /** The paper's deck as it was read: a save stops when it changed meanwhile. */
  seen: SlideDeck;
}

const KIND_NAMES = { visual: 'visual slides (drawn in OnizukaTex)', beamer: 'Beamer slides' } as const;

async function openDeck(library: Library, paper: ResultPaper): Promise<Opened> {
  const seen = paper.slides;
  if (!seen) throw new ToolError(`"${paper.title}" has no slides yet: make them with create_slides.`);
  if (seen.kind !== 'html') {
    throw new ToolError(`"${paper.title}" has ${KIND_NAMES[seen.kind]}; these tools work on HTML slides. create_slides with replace: true replaces them (the repository's history keeps the old ones).`);
  }
  const text = await library.readText(slidesPath(paper.id));
  if (text === null) throw new ToolError(`The slides of "${paper.title}" are missing from the repository (${slidesPath(paper.id)}). create_slides with replace: true starts them again.`);
  return { deck: parseDeck(text), seen };
}

const same = (a: SlideDeck | null | undefined, b: SlideDeck | null | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Saves the deck's file and its hash in one commit, unless the paper's slides changed since `seen`. A slide written
 * since `before` records the blocks it is written from (sources.ts).
 */
async function saveDeck(library: Library, paper: ResultPaper, seen: SlideDeck | null, changed: HtmlDeck, before: HtmlDeck | null): Promise<HtmlDeck> {
  const deck = stamped(changed, before, paper);
  const text = serializeDeck(deck);
  const slides: SlideDeck = { kind: 'html', slides: [], html: { hash: hashText(text) } };
  const check = (latest: ResultPaper[]) => {
    const now = latest.find((item) => item.id === paper.id);
    if (!now) throw new ToolError('The paper was deleted meanwhile.');
    if (!same(now.slides, seen)) throw new ToolError('The slides were changed meanwhile (in OnizukaTex or by another change); look at them again with get_slides.');
  };
  await library.save({ kind: 'patchPaper', id: paper.id, fields: { slides } }, message('update slides of', paper), [], check, [{ path: slidesPath(paper.id), content: text }]);
  return deck;
}

/* ------------------------------------------------------------------ checks */

/** How many clicks a slide has: its last data-step, its tables' focus steps, its charts' steps. */
export function stepsIn(html: string): number {
  let steps = 0;
  for (const match of html.matchAll(/\bdata-step\s*=\s*["']?(\d+)/g)) steps = Math.max(steps, Number(match[1]));
  for (const match of html.matchAll(BLOCK_TAG)) {
    const focus = attributes(match[1]).focus ?? '';
    steps = Math.max(steps, focus.split(';').filter((part) => part.trim()).length);
  }
  for (const match of html.matchAll(CHART_TAG)) {
    const given = attributes(match[1]);
    if (given.base) steps = Math.max(steps, Math.round(Number(given.step) || 1));
  }
  return steps;
}

const refsOf = (html: string, tag: RegExp): string[] => [...html.matchAll(tag)].map((match) => (attributes(match[1]).ref ?? '').trim());

/** Whether two slides side by side make the table-to-chart move: a table on one, a chart of it on the other. */
const moves = (a: string, b: string): boolean => {
  const tables = (html: string) => new Set(refsOf(html, BLOCK_TAG));
  return refsOf(b, CHART_TAG).some((ref) => tables(a).has(ref)) || refsOf(a, CHART_TAG).some((ref) => tables(b).has(ref));
};

/** What does not work, or goes against the guide, slide by slide and for the whole deck. */
export function checkDeck(deck: HtmlDeck, paper: ResultPaper): string[] {
  const notes: string[] = [];
  deck.slides.forEach((slide) => {
    const where = `Slide ${slide.id}`;
    const missing = [...refsOf(slide.html, BLOCK_TAG), ...refsOf(slide.html, CHART_TAG)].filter((ref) => !findBlock(paper, ref));
    if (missing.length > 0) notes.push(`${where}: no block ${[...new Set(missing)].map((ref) => `"${ref || '(empty)'}"`).join(', ')} in the paper.`);
    for (const ref of refsOf(slide.html, CHART_TAG)) {
      const block = findBlock(paper, ref);
      if (block && block.kind !== 'table') notes.push(`${where}: the chart's block ${ref} is a ${block.kind}, not a table.`);
    }
    const changed = changedSources(slide, paper);
    if (changed.length > 0) {
      notes.push(`${where}: ${changed.join(', ')} changed since the slide was written (or ${changed.length > 1 ? 'are' : 'is'} gone); check its numbers and words against ${changed.length > 1 ? 'them' : 'it'}. update_slide marks it checked, even with the same HTML.`);
    }
    const steps = stepsIn(slide.html);
    if (steps > 2) notes.push(`${where}: ${steps} steps; keep it to two.`);
    if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(slide.html)) notes.push(`${where}: scripts and event handlers do not run on a slide; take them out.`);
    if (/@keyframes|\banimation\s*:|\btransition\s*:/i.test(slide.html)) notes.push(`${where}: animations of its own; the kit's motion is all a slide should have.`);
    if (/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(slide.html)) notes.push(`${where}: outside resources do not load on a slide; use data: URLs.`);
  });
  if (/@keyframes|\banimation\s*:/i.test(deck.css)) notes.push("The deck's style has animations of its own; the kit's motion is all a deck should have.");
  const stepped = deck.slides.filter((slide) => stepsIn(slide.html) > 0).length;
  if (deck.slides.length >= 4 && stepped > Math.ceil(deck.slides.length / 3)) notes.push(`${stepped} of ${deck.slides.length} slides have steps; keep steps to about a third of them.`);
  const pairs: number[] = [];
  deck.slides.forEach((slide, index) => {
    if (index > 0 && moves(deck.slides[index - 1].html, slide.html)) pairs.push(index);
  });
  if (pairs.length > 3) notes.push(`The table-to-chart move happens ${pairs.length} times; two or three in a talk at most.`);
  if (pairs.some((at, index) => index > 0 && at - pairs[index - 1] <= 2)) notes.push('Two table-to-chart moves come one right after the other; space them out.');
  return notes;
}

/* ------------------------------------------------------------------ describing it */

function outline(deck: HtmlDeck): string[] {
  return deck.slides.map((slide, index) => {
    const steps = stepsIn(slide.html);
    return `${index + 1}. ${slide.id} — ${slideTitle(slide.html) || '(no title)'}${steps ? ` (${steps} step${steps > 1 ? 's' : ''})` : ''}`;
  });
}

function afterChange(deck: HtmlDeck, paper: ResultPaper, done: string): string {
  const notes = checkDeck(deck, paper);
  return [done, '', `Slides (${deck.slides.length}):`, ...outline(deck), ...(notes.length > 0 ? ['', 'To look at:', ...notes.map((note) => `- ${note}`)] : [])].join('\n');
}

/* ------------------------------------------------------------------ what a tool is given */

const MARKER = /<!--\s*slide:/i;

/** A slide's markup as given: one <section class="slide">. */
function slideHtml(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError('Give the slide: <section class="slide">…</section>.');
  const html = value.trim();
  if (!/^<section\b[^>]*\bclass\s*=\s*["'][^"']*\bslide\b/i.test(html) || !/<\/section>$/i.test(html)) {
    throw new ToolError('A slide is one <section class="slide">…</section>, nothing before or after it.');
  }
  if (MARKER.test(html)) throw new ToolError('Leave out "<!-- slide: … -->" lines: the file puts them between slides itself.');
  if (/<\/?(?:body|html|head)\b/i.test(html)) throw new ToolError('A slide has no <html>, <head> or <body>: just its <section>.');
  return html;
}

function slideIndex(deck: HtmlDeck, ref: unknown): number {
  const id = given(ref, 'a slide ID (get_slides lists them)');
  const index = deck.slides.findIndex((slide) => slide.id === id);
  if (index < 0) throw new ToolError(`No slide ${id}. The slides: ${deck.slides.map((slide) => slide.id).join(', ') || 'none'}.`);
  return index;
}

/** Where a slide goes: right after or before another, at the end when neither is given. */
function placeOf(deck: HtmlDeck, args: Record<string, unknown>): number {
  const after = optional(args.after);
  const before = optional(args.before);
  if (after && before) throw new ToolError('Give after or before, not both.');
  if (after) return slideIndex(deck, after) + 1;
  if (before) return slideIndex(deck, before);
  return deck.slides.length;
}

const POSITION = {
  after: { ...SLIDE, description: 'Put it right after this slide.' },
  before: { ...SLIDE, description: 'Put it right before this slide.' },
};

/* ------------------------------------------------------------------ the tools */

export const SLIDE_TOOLS: Tool[] = [
  {
    name: 'slides_guide',
    title: 'How to write HTML slides',
    description: "How to write a paper's HTML slides: what a slide holds, how to put the paper's tables and figures on it, focus steps, charts from tables, and how much may move. Read it before writing slides.",
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async () => SLIDES_GUIDE,
  },
  {
    name: 'get_slides',
    title: 'Look at the slides',
    description: "A paper's HTML slides: the brief (what the talk is for), title, footer, style and every slide's HTML, with a check of what does not work or goes against the guide (slides_guide).",
    inputSchema: object({ paper: PAPER }, ['paper']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const { deck } = await openDeck(library, paper);
      const notes = checkDeck(deck, paper);
      const text = [
        `HTML slides of "${paper.title}" (${deck.slides.length} slides)`,
        `Title: ${deck.title}`,
        `Footer: ${deck.footer}`,
        '',
        'Brief (from the person; follow it):',
        deck.brief.trim() || '(empty)',
        '',
        'Style:',
        deck.css.trim() || '(none)',
        '',
        ...deck.slides.flatMap((slide, index) => [`--- ${index + 1}. slide ${slide.id}`, slide.html, '']),
        notes.length > 0 ? `To look at:\n${notes.map((note) => `- ${note}`).join('\n')}` : 'Check: nothing to look at.',
      ].join('\n');
      return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[Cut here: the deck is longer.]` : text;
    },
  },
  {
    name: 'create_slides',
    title: 'Start the slides',
    description:
      "Start a paper's HTML slides from the paper: a title slide, a slide before each part of its logic, and one for each figure and table. Then write them out slide by slide. A paper that has slides already keeps them unless replace is true.",
    inputSchema: object(
      {
        paper: PAPER,
        brief: { type: 'string', description: "What the talk is for, if the person said: the occasion, length, audience, what to stress, the language." },
        replace: { type: 'boolean', description: 'Replace the slides the paper has (the repository keeps the old ones in its history).' },
      },
      ['paper'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      if (paper.slides && args.replace !== true) {
        const kind = paper.slides.kind === 'html' ? 'HTML slides' : KIND_NAMES[paper.slides.kind];
        throw new ToolError(`"${paper.title}" has ${kind} already: change them (get_slides), or give replace: true to start again.`);
      }
      const start = starterHtmlDeck(paper, LABELS, blockNumber);
      const brief = optional(args.brief);
      const deck = brief ? { ...start, brief } : start;
      const saved = await saveDeck(library, paper, paper.slides ?? null, deck, null);
      return afterChange(saved, paper, `Started the HTML slides of "${paper.title}". Read slides_guide, then write each slide out with update_slide.`);
    },
  },
  {
    name: 'update_deck',
    title: 'Change the deck',
    description: "Change what is not a slide: the deck's title, its footer line, its brief, or its style (CSS overriding the kit, e.g. :root { --accent: #23509a; }). Give only what changes.",
    inputSchema: object(
      {
        paper: PAPER,
        title: { type: 'string', description: "The deck's title." },
        footer: { type: 'string', description: 'The line at the foot of every slide.' },
        brief: { type: 'string', description: 'What the talk is for.' },
        style: { type: 'string', description: "The deck's style, in full." },
      },
      ['paper'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const { deck, seen } = await openDeck(library, paper);
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
      const next: HtmlDeck = { ...deck, title: text(args.title) ?? deck.title, footer: text(args.footer) ?? deck.footer, brief: text(args.brief) ?? deck.brief, css: text(args.style) ?? deck.css };
      if (/<\/style/i.test(next.css)) throw new ToolError('The style is CSS only, without <style> tags.');
      if (serializeDeck(next) === serializeDeck(deck)) return 'Nothing changed.';
      const saved = await saveDeck(library, paper, seen, next, deck);
      return afterChange(saved, paper, `Saved the deck of "${paper.title}".`);
    },
  },
  {
    name: 'update_slide',
    title: 'Change a slide',
    description: 'Replace the HTML of one slide (one <section class="slide">…</section>; see slides_guide).',
    inputSchema: object({ paper: PAPER, slide: SLIDE, html: SLIDE_HTML }, ['paper', 'slide', 'html']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const { deck, seen } = await openDeck(library, paper);
      const index = slideIndex(deck, args.slide);
      const html = slideHtml(args.html);
      const id = deck.slides[index].id;
      if (deck.slides[index].html === html) {
        // The same slide again: it was checked against its blocks as they are now.
        if (changedSources(deck.slides[index], paper).length === 0) return `Slide ${id} already has this HTML; nothing changed.`;
        const saved = await saveDeck(library, paper, seen, checkedSlide(deck, index, paper), deck);
        return afterChange(saved, paper, `Marked slide ${id} as checked against its blocks.`);
      }
      const saved = await saveDeck(library, paper, seen, withSlideHtml(deck, index, html), deck);
      return afterChange(saved, paper, `Saved slide ${id}.`);
    },
  },
  {
    name: 'add_slide',
    title: 'Add a slide',
    description: 'Add a slide: after or before another, or at the end.',
    inputSchema: object(
      { paper: PAPER, html: SLIDE_HTML, ...POSITION, id: { type: 'string', description: 'An ID for it (letters, digits, - and _); one is made when left out.' } },
      ['paper', 'html'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const { deck, seen } = await openDeck(library, paper);
      const html = slideHtml(args.html);
      const at = placeOf(deck, args);
      const wanted = optional(args.id);
      if (wanted && !/^[A-Za-z0-9][\w-]*$/.test(wanted)) throw new ToolError('A slide ID is letters, digits, - and _.');
      if (wanted && deck.slides.some((slide) => slide.id === wanted)) throw new ToolError(`There is a slide ${wanted} already.`);
      const id = wanted ?? newSlideId(deck);
      const saved = await saveDeck(library, paper, seen, withSlide(deck, { id, html }, at), deck);
      return afterChange(saved, paper, `Added slide ${id} as slide ${at + 1}.`);
    },
  },
  {
    name: 'move_slide',
    title: 'Move a slide',
    description: 'Move a slide to right after or right before another.',
    inputSchema: object({ paper: PAPER, slide: SLIDE, ...POSITION }, ['paper', 'slide']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const { deck, seen } = await openDeck(library, paper);
      const index = slideIndex(deck, args.slide);
      if (!optional(args.after) && !optional(args.before)) throw new ToolError('Give after or before: the slide to put it next to.');
      const slide = deck.slides[index];
      const rest = withoutSlide(deck, index);
      if ([optional(args.after), optional(args.before)].includes(slide.id)) throw new ToolError('Give another slide to put it next to.');
      const next = withSlide(rest, slide, placeOf(rest, args));
      if (next.slides.every((item, at) => item.id === deck.slides[at].id)) return `Slide ${slide.id} is there already; nothing changed.`;
      const saved = await saveDeck(library, paper, seen, next, deck);
      return afterChange(saved, paper, `Moved slide ${slide.id}.`);
    },
  },
  {
    name: 'delete_slide',
    title: 'Delete a slide',
    description: "Delete a slide. The repository's history keeps it.",
    inputSchema: object({ paper: PAPER, slide: SLIDE }, ['paper', 'slide']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (args, library) => {
      const paper = await paperIn(library, args);
      const { deck, seen } = await openDeck(library, paper);
      const index = slideIndex(deck, args.slide);
      const saved = await saveDeck(library, paper, seen, withoutSlide(deck, index), deck);
      return afterChange(saved, paper, `Deleted slide ${deck.slides[index].id}. The repository's history keeps it.`);
    },
  },
];
