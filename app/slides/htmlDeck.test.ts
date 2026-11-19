import { describe, expect, it } from 'vitest';
import { ResultPaper } from '../../types';
import {
  HtmlDeck,
  StarterLabels,
  blankSlide,
  duplicatedSlide,
  escapeHtml,
  movedSlide,
  newSlideId,
  parseDeck,
  serializeDeck,
  slideTitle,
  starterHtmlDeck,
  textOf,
  withSlide,
  withSlideHtml,
  withoutSlide,
} from './htmlDeck';

const deck: HtmlDeck = {
  title: 'Made-up & "quoted" study',
  footer: 'Ada Example et al. · Made-up Conf 2027',
  brief: 'Occasion: group meeting\nLength: 15 minutes --> not the end',
  css: ':root {\n  --accent: #23509a;\n}',
  slides: [
    { id: 'cover', html: '<section class="slide cover">\n  <h1 class="title">Made-up</h1>\n</section>' },
    { id: 'res-1', html: '<section class="slide">\n  <h1 class="title">Accuracy</h1>\n  <lemma-block ref="tab:main"></lemma-block>\n</section>' },
  ],
};

describe('the deck file', () => {
  it('reads back what it wrote', () => {
    expect(parseDeck(serializeDeck(deck))).toEqual(deck);
  });

  it('puts each slide after its own line, so a change to one slide is a change to its lines', () => {
    const text = serializeDeck(deck);
    expect(text).toContain('<!-- slide: cover -->\n<section class="slide cover">');
    expect(text).toContain('<!-- slide: res-1 -->');
    expect(text.indexOf('<!-- slide: cover -->')).toBeLessThan(text.indexOf('<!-- slide: res-1 -->'));
    expect(text).toContain('<style id="deck">\n:root {');
  });

  it('reads a file with nothing but slides, and one without any slide line', () => {
    expect(parseDeck('<!-- slide: a -->\n<section class="slide">A</section>\n<!-- slide: b -->\n<section class="slide">B</section>').slides).toEqual([
      { id: 'a', html: '<section class="slide">A</section>' },
      { id: 'b', html: '<section class="slide">B</section>' },
    ]);
    expect(parseDeck('<section class="slide">Only</section>').slides).toEqual([{ id: 's1', html: '<section class="slide">Only</section>' }]);
    expect(parseDeck('')).toEqual({ title: '', footer: '', brief: '', css: '', slides: [] });
  });

  it('gives a slide whose id is taken another one', () => {
    const slides = parseDeck('<!-- slide: a -->\nOne\n<!-- slide: a -->\nTwo').slides;
    expect(slides.map((slide) => slide.id)).toEqual(['a', 'a-2']);
    expect(slides.map((slide) => slide.html)).toEqual(['One', 'Two']);
  });

  it('keeps a brief that mentions the end of a comment', () => {
    const text = serializeDeck(deck);
    expect(text).not.toContain('not the end -->');
    expect(parseDeck(text).brief).toBe(deck.brief);
  });
});

describe('slides in the list', () => {
  it('know their title', () => {
    expect(slideTitle(deck.slides[1].html)).toBe('Accuracy');
    expect(slideTitle('<section class="slide"><h2>Second <b>kind</b> &amp; more</h2></section>')).toBe('Second kind & more');
    expect(slideTitle('<section class="slide">None</section>')).toBe('');
    expect(textOf('<p>A  <i>b</i>\n c</p>')).toBe('A b c');
  });

  it('are added, copied, moved and dropped', () => {
    expect(newSlideId(deck)).toBe('s3');
    expect(newSlideId({ ...deck, slides: [...deck.slides, { id: 's3', html: '' }] })).toBe('s4');
    const added = withSlide(deck, { id: 'x', html: blankSlide('New <one>') }, 1);
    expect(added.slides.map((slide) => slide.id)).toEqual(['cover', 'x', 'res-1']);
    expect(slideTitle(added.slides[1].html)).toBe('New <one>');
    expect(added.slides[1].html).toContain('New &lt;one&gt;');
    const copy = duplicatedSlide(deck, 1);
    expect(copy.slides.map((slide) => slide.id)).toEqual(['cover', 'res-1', 's3']);
    expect(copy.slides[2].html).toBe(deck.slides[1].html);
    expect(movedSlide(deck, 1, -1).slides.map((slide) => slide.id)).toEqual(['res-1', 'cover']);
    expect(movedSlide(deck, 0, -1)).toBe(deck);
    expect(movedSlide(deck, 1, 5)).toBe(deck);
    expect(withoutSlide(deck, 0).slides.map((slide) => slide.id)).toEqual(['res-1']);
    expect(withSlideHtml(deck, 0, 'changed').slides[0]).toEqual({ id: 'cover', html: 'changed' });
    expect(deck.slides[0].html).not.toBe('changed');
  });

  it('escape what goes into markup', () => {
    expect(escapeHtml('A & B < C "D"')).toBe('A &amp; B &lt; C &quot;D&quot;');
  });
});

const out = (name: string) => ({ pdf: `results/res-b/${name}.pdf`, width: 400, height: 300 });
const paper: ResultPaper = {
  id: 'res-b',
  slug: 'b',
  title: 'Made-up study: 50% fewer parameters & more',
  authors: ['**Ada Example**', 'Bo Sample'],
  venue: 'Made-up Conf 2027',
  blocks: [
    { id: 'meth', kind: 'text', source: '\\section{Method}', output: out('meth') },
    { id: 'm1', kind: 'text', source: '\\subsection{Made-up gate}', output: out('m1') },
    { id: 'exps', kind: 'text', source: '\\section{Experiments}', output: out('exps') },
    { id: 'e1', kind: 'text', source: '\\subsection{Cache results}', output: out('e1') },
    {
      id: 't1',
      kind: 'table',
      source: '\\begin{table}\\caption{Accuracy of the \\textbf{made-up} methods on five benchmarks. Higher is better.}\\label{tab:acc}\\end{table}',
      output: { ...out('t1'), labels: { 'tab:acc': '{1}{1}{}{table.1}{}' }, counters: { table: 1 } },
    },
    { id: 'f1', kind: 'figure', source: '\\begin{figure}\\end{figure}', output: out('f1') },
    { id: 'h1', kind: 'table', hidden: true, source: '\\begin{table}\\caption{Hidden}\\end{table}', output: out('h1') },
    { id: 'n1', kind: 'table', source: '\\begin{table}\\caption{Not compiled}\\end{table}' },
  ],
  logic: { m1: 'meth', e1: 'exps', t1: 'e1', f1: 'e1' },
};
const labels: StarterLabels = {
  figure: (number) => `Figure${number ? ` ${number}` : ''}`,
  table: (number) => `Table${number ? ` ${number}` : ''}`,
  part: (n) => `Part ${n}`,
  brief: 'Occasion:\nLength:',
};
const numberOf = (_blocks: unknown, index: number) => (index === 4 ? '1' : undefined);

describe('the deck a paper starts from', () => {
  const start = starterHtmlDeck(paper, labels, numberOf);

  it('opens with the title, the authors and the venue', () => {
    expect(start.slides[0].id).toBe('cover');
    expect(start.slides[0].html).toContain('<h1 class="title">Made-up study: 50% fewer parameters &amp; more</h1>');
    expect(start.slides[0].html).toContain('<p class="authors">Ada Example, Bo Sample</p>');
    expect(start.slides[0].html).toContain('<p class="venue">Made-up Conf 2027</p>');
    expect(start.title).toBe(paper.title);
    expect(start.footer).toBe('Ada Example et al. · Made-up Conf 2027');
    expect(start.brief).toBe('Occasion:\nLength:');
    expect(start.css).toContain('--accent');
  });

  it('has a slide before each part, listing the parts with the current one marked, and one for each shown figure and table', () => {
    // The tree leaves nothing under Method but its subsection, which has no figure or table: only Experiments opens a part.
    expect(start.slides.map((slide) => slide.id)).toEqual(['cover', 'part-1', 'res-1', 'res-2']);
    const divider = start.slides[1].html;
    expect(divider).toContain('class="slide divider"');
    expect(divider).toContain('<p class="part">Part 1</p>');
    expect(divider).toContain('<h1 class="title">Experiments</h1>');
    expect(divider).toContain('<li class="cur"><span class="n">Part 1</span>Experiments</li>');
  });

  it('puts each block on a slide with its label and caption, titled by the first sentence of the caption', () => {
    const table = start.slides[2].html;
    expect(table).toContain('<h1 class="title">Accuracy of the made-up methods on five benchmarks</h1>');
    expect(table).toContain('<lemma-block ref="tab:acc"></lemma-block>');
    expect(table).toContain('<p class="caption"><b>Table 1.</b> Accuracy of the made-up methods on five benchmarks. Higher is better.</p>');
    // A figure without a caption is titled by its label and refers to the block by its id.
    const figure = start.slides[3].html;
    expect(figure).toContain('<h1 class="title">Figure</h1>');
    expect(figure).toContain('<lemma-block ref="f1"></lemma-block>');
    expect(figure).not.toContain('class="caption"');
  });

  it("leaves a figure's caption to the figure: its compiled PDF has it", () => {
    const withCaption = starterHtmlDeck(
      { ...paper, blocks: paper.blocks.map((block) => (block.id === 'f1' ? { ...block, source: '\\begin{figure}\\caption{Curves of the made-up methods. More words.}\\end{figure}' } : block)) },
      labels,
      numberOf,
    );
    const figure = withCaption.slides[3].html;
    expect(figure).toContain('<h1 class="title">Curves of the made-up methods</h1>');
    expect(figure).not.toContain('class="caption"');
  });

  it('leaves out blocks that are hidden or not compiled, and is a deck that reads back', () => {
    expect(start.slides.map((slide) => slide.html).join('')).not.toMatch(/Hidden|Not compiled/);
    expect(parseDeck(serializeDeck(start))).toEqual(start);
  });

  it('is only the title for a paper with nothing to show', () => {
    expect(starterHtmlDeck({ ...paper, blocks: [] }, labels, numberOf).slides.map((slide) => slide.id)).toEqual(['cover']);
  });
});
