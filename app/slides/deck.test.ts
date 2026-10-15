import { describe, expect, it } from 'vitest';
import { ResultPaper, SlideBlock, SlideText } from '../../types';
import {
  CONTENT_BOX,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  beamerDeck,
  beamerMain,
  blockRefs,
  captionOf,
  escapeLatex,
  fit,
  lemmablockLine,
  moved,
  plain,
  resized,
  shorten,
  snapped,
  usedRefs,
  visualDeck,
  withoutMissing,
} from './deck';

const paper: ResultPaper = {
  id: 'res-a',
  slug: 'a',
  title: 'Made-up study: 50% fewer parameters',
  authors: ['**Ada Example**', 'Bo Sample'],
  venue: 'Made-up Conf 2027',
  blocks: [
    { id: 'blk-t', kind: 'text', source: '\\section{Results}\nWords.', output: { pdf: 'results/res-a/t.pdf', width: 550, height: 100 } },
    {
      id: 'blk-f',
      kind: 'figure',
      source: '\\begin{figure}[t]\n\\includegraphics{a.pdf}\n\\caption{Accuracy of the \\textbf{made-up} methods~\\cite{x}.}\\label{fig:acc}\n\\end{figure}',
      output: { pdf: 'results/res-a/f.pdf', width: 400, height: 300, labels: { 'fig:acc': '{1}{1}{}{figure.1}{}' }, counters: { figure: 1 } },
    },
    { id: 'blk-h', kind: 'table', hidden: true, source: '\\begin{table}\\caption{Hidden}\\end{table}', output: { pdf: 'results/res-a/h.pdf', width: 400, height: 100 } },
    { id: 'blk-n', kind: 'table', source: '\\begin{table}\\caption{Not compiled}\\end{table}' },
  ],
};
const label = (kind: 'figure' | 'table', number?: string) => `${kind === 'figure' ? 'Figure' : 'Table'}${number ? ` ${number}` : ''}`;
const longCaption = {
  id: 'blk-l',
  kind: 'table' as const,
  source: '\\begin{table}\\caption{Made-up results on five made-up benchmarks, three seeds each, with the standard deviation in brackets.}\\end{table}',
  output: { pdf: 'results/res-a/l.pdf', width: 400, height: 100 },
};
const number = (_blocks: unknown, index: number) => (index === 1 ? '1' : undefined);
let count = 0;
const make = (prefix: string) => `${prefix}-${(count += 1)}`;

describe('layout', () => {
  it('fits a shape inside an area, centered', () => {
    expect(fit(2, { x: 0, y: 0, w: 1000, h: 1000 })).toEqual({ x: 0, y: 250, w: 1000, h: 500 });
    expect(fit(0.5, { x: 100, y: 0, w: 1000, h: 400 })).toEqual({ x: 500, y: 0, w: 200, h: 400 });
  });

  it('moves and resizes within the page, keeping a block in shape', () => {
    const box = { id: 'b', type: 'block' as const, blockId: 'x', x: 100, y: 100, w: 400, h: 200 };
    expect(moved(box, -500, 2000)).toMatchObject({ x: 0, y: SLIDE_HEIGHT - 200 });
    expect(resized(box, 'se', 200, 0, 2)).toMatchObject({ x: 100, y: 100, w: 600, h: 300 });
    expect(resized(box, 'nw', 50, 50)).toMatchObject({ x: 150, y: 150, w: 350, h: 150 });
    const huge = resized(box, 'se', 5000, 0, 2);
    expect(huge.x + huge.w).toBeLessThanOrEqual(SLIDE_WIDTH);
    expect(huge.w / huge.h).toBeCloseTo(2);
  });

  it('snaps to the center line, the margins and a grid of ten', () => {
    expect(snapped(596, 400, SLIDE_WIDTH)).toEqual({ value: 600, guide: 800 });
    expect(snapped(84, 400, SLIDE_WIDTH)).toEqual({ value: 80, guide: 80 });
    expect(snapped(333, 400, SLIDE_WIDTH)).toEqual({ value: 330 });
  });
});

describe('decks from a paper', () => {
  it('read captions as plain words', () => {
    expect(captionOf(paper.blocks[1].source)).toBe('Accuracy of the made-up methods.');
    expect(plain('A~\\emph{b} $x$ \\ref{y}')).toBe('A b x');
  });

  it('start a visual deck with a title slide and a slide for each shown, compiled figure and table', () => {
    const deck = visualDeck(paper, label, number, make);
    expect(deck.kind).toBe('visual');
    expect(deck.slides).toHaveLength(2);
    expect((deck.slides[0].elements[0] as SlideText).text).toBe(paper.title);
    expect((deck.slides[0].elements[1] as SlideText).text).toBe('Ada Example, Bo Sample\nMade-up Conf 2027');
    const [title, block] = deck.slides[1].elements as [SlideText, SlideBlock];
    expect(title.text).toBe('Figure 1  Accuracy of the made-up methods');
    expect(block).toMatchObject({ type: 'block', blockId: 'blk-f' });
    // 4:3 inside the content area, as tall as it is.
    expect(block.h).toBe(CONTENT_BOX.h);
    expect(block.w / block.h).toBeCloseTo(4 / 3);
  });

  it('drop elements of blocks that are gone', () => {
    const deck = visualDeck(paper, label, number, make);
    const without = withoutMissing(deck, { ...paper, blocks: paper.blocks.filter((block) => block.id !== 'blk-f') });
    expect(without.slides[1].elements.map((element) => element.type)).toEqual(['text']);
  });
});

describe('titles', () => {
  it('shorten at a word, with an ellipsis', () => {
    expect(shorten('Accuracy of the made-up methods in domain and under three shifts.', 40)).toBe('Accuracy of the made-up methods in…');
    expect(shorten('Short.', 40)).toBe('Short');
  });
});

describe('Beamer decks', () => {
  it('start from a title frame and a frame for each figure and table, by label', () => {
    const deck = beamerDeck({ ...paper, blocks: [...paper.blocks, longCaption] }, number);
    expect(deck.beamer).toContain('\\documentclass[aspectratio=169]{beamer}');
    expect(deck.beamer).toContain('\\title{Made-up study: 50\\% fewer parameters}');
    expect(deck.beamer).toContain('\\begin{frame}{Figure 1: Accuracy of the made-up methods}\n  \\centering\n  \\lemmablock{fig:acc}\n\\end{frame}');
    // In English whatever the interface's language, and short enough for one line.
    expect(deck.beamer).toContain('\\begin{frame}{Table: Made-up results on five made-up\\dots{}}');
    expect(usedRefs(deck.beamer ?? '')).toEqual(['fig:acc', 'blk-l']);
  });

  it('keep what pdfTeX cannot set here (Chinese, Greek, symbols) out of the source, as comments', () => {
    const chinese = '\u4e2d\u6587';
    const deck = beamerDeck(
      {
        ...paper,
        title: `${chinese} study\nof two lines`,
        authors: ['Ada M\u00fcller', 'Bo \u0141ukasz'],
        venue: '\u03b2-VAE \u2264 workshop',
        blocks: [{ ...longCaption, source: `\\begin{table}\\caption{${chinese}}\\end{table}` }],
      },
      number,
    );
    expect(deck.beamer).toContain(`% \\title{${chinese} study of two lines}  % left out: pdfTeX here cannot set some of these characters`);
    expect(deck.beamer).toContain('% \\date{\u03b2-VAE \u2264 workshop}  % left out');
    // Latin letters with accents stay: LaTeX sets them.
    expect(deck.beamer).toContain('\\author{Ada M\u00fcller, Bo \u0141ukasz}');
    expect(deck.beamer).toContain('\\begin{frame}{Table}');
    const typeset = deck.beamer?.split('\n').filter((line) => !line.startsWith('%')).join('\n');
    expect(typeset).not.toMatch(/[\u4e00-\u9fff\u03b2\u2264]/);
  });

  it('name blocks by their labels and ids, and define \\lemmablock on one line before the source', () => {
    expect(blockRefs(paper)).toEqual({ 'blk-t': 'blk-t', 'blk-f': 'blk-f', 'fig:acc': 'blk-f', 'blk-h': 'blk-h' });
    const main = beamerMain('\\documentclass{beamer}\n\\begin{document}\n\\lemmablock[width=5cm]{fig:acc}\n\\end{document}', blockRefs(paper));
    const lines = main.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('\\providecommand\\lemmablock[2][]');
    expect(lines[0]).toContain('\\@namedef{lemma@block@fig:acc}{blk-f}');
    expect(lines[1]).toBe('\\documentclass{beamer}');
    expect(usedRefs('% \\lemmablock{commented}\n\\lemmablock [x] {fig:acc} \\lemmablock{blk-t}')).toEqual(['fig:acc', 'blk-t']);
  });

  it('find the line that names a block, past comments', () => {
    const source = '\\begin{frame}\n% \\lemmablock{tab:x}\n  \\lemmablock[width=5cm]{ tab:x }\n\\end{frame}';
    expect(lemmablockLine(source, 'tab:x')).toBe(3);
    expect(lemmablockLine(source, 'tab:y')).toBeUndefined();
  });

  it('escapes what LaTeX treats specially', () => {
    expect(escapeLatex('A & B_1 #2 ~ ^ \\ {x} 50% $3 \u2026')).toBe('A \\& B\\_1 \\#2 \\textasciitilde{} \\textasciicircum{} \\textbackslash{} \\{x\\} 50\\% \\$3 \\dots{}');
  });
});
