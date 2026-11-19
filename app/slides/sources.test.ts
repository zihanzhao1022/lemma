import { describe, expect, it } from 'vitest';
import { ResultBlock, ResultPaper } from '../../types';
import { HtmlDeck, parseDeck, serializeDeck } from './htmlDeck';
import { changedSources, checkedSlide, sourceHash, sourceIds, sourcesOf, stamped } from './sources';

const out = { pdf: 'x.pdf', width: 1, height: 1 };
const table = (source: string): ResultBlock => ({ id: 't1', kind: 'table', source, output: { ...out, labels: { 'tab:acc': '{1}{1}{}{table.1}{}' } } });
const paper = (tableSource = '\\begin{table}A 1\\end{table}'): ResultPaper => ({
  id: 'p',
  slug: 'p',
  title: 'Made-up',
  authors: [],
  blocks: [table(tableSource), { id: 'e1', kind: 'text', source: '\\subsection{Result} Higher.', output: out }],
});
const deck = (...html: string[]): HtmlDeck => ({ title: '', footer: '', brief: '', css: '', slides: html.map((item, index) => ({ id: `s${index + 1}`, html: item })) });
const onTable = '<section class="slide"><lemma-block ref="tab:acc"></lemma-block></section>';
const summing = '<section class="slide" data-from="e1 gone"><p>Higher.</p><lemma-chart ref="t1" col="1"></lemma-chart></section>';

describe('what a slide is written from', () => {
  it('is the blocks it puts on itself and those its data-from names, as they are', () => {
    expect(sourceIds(onTable, paper())).toEqual(['t1']);
    expect(sourceIds(summing, paper())).toEqual(['t1', 'e1']);
    expect(sourcesOf(summing, paper())).toEqual({ t1: sourceHash(paper().blocks[0]), e1: sourceHash(paper().blocks[1]) });
    expect(sourceHash(paper().blocks[0])).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is recorded when a slide is written, and kept while its markup stays', () => {
    const first = stamped(deck(onTable, summing), null, paper());
    expect(first.slides[0].seen).toEqual({ t1: sourceHash(paper().blocks[0]) });
    // The table changes; the slide on it is not written again: it keeps what it was written from.
    const later = paper('\\begin{table}A 2\\end{table}');
    const kept = stamped(first, first, later);
    expect(kept.slides[0].seen).toEqual(first.slides[0].seen);
    expect(changedSources(kept.slides[0], later)).toEqual(['t1']);
    expect(changedSources(kept.slides[1], later)).toEqual(['t1']);
    // Writing the slide again, or saying it was checked, takes the block as it is now.
    const rewritten = stamped({ ...kept, slides: [{ ...kept.slides[0], html: onTable.replace('</section>', '<p>New</p></section>') }, kept.slides[1]] }, kept, later);
    expect(changedSources(rewritten.slides[0], later)).toEqual([]);
    expect(changedSources(checkedSlide(kept, 1, later).slides[1], later)).toEqual([]);
  });

  it('counts a block that is gone as changed', () => {
    const first = stamped(deck(summing), null, paper());
    expect(changedSources(first.slides[0], { ...paper(), blocks: paper().blocks.slice(0, 1) })).toEqual(['e1']);
  });

  it('is kept on the slide line of the file', () => {
    const first = stamped(deck(onTable, '<section class="slide">Plain</section>'), null, paper());
    const text = serializeDeck(first);
    expect(text).toContain(`<!-- slide: s1 from: t1@${sourceHash(paper().blocks[0])} -->`);
    expect(text).toContain('<!-- slide: s2 -->');
    expect(parseDeck(text).slides).toEqual([{ id: 's1', html: onTable, seen: first.slides[0].seen }, { id: 's2', html: '<section class="slide">Plain</section>' }]);
  });
});
