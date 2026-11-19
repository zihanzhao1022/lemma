import { describe, expect, it } from 'vitest';
import { parseDeck } from '../../app/slides/htmlDeck';
import { ResultsOp, applyResultsOp } from '../../editor/results/ops';
import { hashText } from '../../editor/results/numbering';
import { ResultPaper } from '../../types';
import { Library, TextWrite, ToolError } from './library';
import { SLIDE_TOOLS, checkDeck, stepsIn } from './slides';

const TABLE = String.raw`\begin{table}\caption{Accuracy of the made-up methods. Higher is better.}\label{tab:acc}
\begin{tabular}{lr}\toprule & EM \\ \midrule A & 30.1 \\ Ours & \textbf{42.2} \\ \bottomrule\end{tabular}\end{table}`;

const paper = (): ResultPaper => ({
  id: 'res-a',
  slug: 'made-up',
  title: 'A Made-up Study',
  authors: ['Ada Example', 'Bo Sample'],
  venue: 'Made-up Conf 2027',
  blocks: [
    { id: 'exps', kind: 'text', source: '\\section{Experiments}', output: { pdf: 'results/res-a/exps.pdf', width: 1, height: 1 } },
    { id: 't1', kind: 'table', source: TABLE, output: { pdf: 'results/res-a/t1.pdf', width: 1, height: 1, labels: { 'tab:acc': '{1}{1}{}{table.1}{}' }, counters: { table: 1 } } },
  ],
  logic: { t1: 'exps' },
});

interface Commit {
  op: ResultsOp;
  message: string;
  writes: TextWrite[];
}

/** The papers and files in memory, saved as the repository would: the op and the files in one commit. */
function fakeLibrary(papers: ResultPaper[] = [paper()]) {
  const state = { papers, files: {} as Record<string, string>, commits: [] as Commit[] };
  const library: Library = {
    repo: 'ada-example/lemma-papers',
    papers: async () => state.papers,
    save: async (op, message, _deletes = [], check, writes = []) => {
      check?.(state.papers);
      state.papers = applyResultsOp(state.papers, op);
      for (const write of writes) state.files[write.path] = write.content;
      state.commits.push({ op, message, writes });
      return state.papers;
    },
    readText: async (path) => state.files[path] ?? null,
  };
  return { library, state };
}

const tool = (name: string) => {
  const found = SLIDE_TOOLS.find((item) => item.name === name);
  if (!found) throw new Error(name);
  return (args: Record<string, unknown>, library: Library) => found.run(args, library);
};

const PATH = 'results/res-a/slides.html';
const slide = (title: string, more = '') => `<section class="slide">\n  <h1 class="title">${title}</h1>${more}\n</section>`;

async function started() {
  const made = fakeLibrary();
  await tool('create_slides')({ paper: 'res-a', brief: 'Occasion: lab meeting\nLength: 10 minutes' }, made.library);
  return made;
}

describe('starting the slides', () => {
  it('writes the deck file and keeps its hash in the paper, in one commit', async () => {
    const { state } = await started();
    const text = state.files[PATH];
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0].message).toBe('results: update slides of "A Made-up Study" (Claude Code)');
    expect(state.papers[0].slides).toEqual({ kind: 'html', slides: [], html: { hash: hashText(text) } });
    const deck = parseDeck(text);
    expect(deck.slides.map((item) => item.id)).toEqual(['cover', 'res-1']);
    expect(deck.brief).toBe('Occasion: lab meeting\nLength: 10 minutes');
    expect(deck.slides[1].html).toContain('<lemma-block ref="tab:acc"></lemma-block>');
    expect(deck.slides[1].html).toContain('<b>Table 1.</b>');
  });

  it('keeps slides a paper has unless asked to replace them', async () => {
    const { library, state } = await started();
    await expect(tool('create_slides')({ paper: 'res-a' }, library)).rejects.toThrow(/has HTML slides already/);
    await tool('create_slides')({ paper: 'res-a', replace: true }, library);
    expect(parseDeck(state.files[PATH]).brief).toBe('Occasion:\nLength:\nAudience:\nFocus:\nLanguage:');
  });

  it('works on HTML slides only', async () => {
    const { library } = fakeLibrary([{ ...paper(), slides: { kind: 'beamer', slides: [], beamer: '' } }]);
    await expect(tool('get_slides')({ paper: 'res-a' }, library)).rejects.toThrow(/has Beamer slides; these tools work on HTML slides/);
    await expect(tool('get_slides')({ paper: 'res-a' }, fakeLibrary().library)).rejects.toThrow(/no slides yet/);
  });
});

describe('changing the slides', () => {
  it('shows the deck with its brief and every slide', async () => {
    const { library } = await started();
    const shown = await tool('get_slides')({ paper: 'res-a' }, library);
    expect(shown).toContain('Occasion: lab meeting');
    expect(shown).toContain('--- 2. slide res-1\n<section class="slide">');
    expect(shown).toContain('Check: nothing to look at.');
  });

  it('changes, adds, moves and deletes slides, each a commit of the file and its hash', async () => {
    const { library, state } = await started();
    await tool('update_slide')({ paper: 'res-a', slide: 'res-1', html: slide('EM: Ours is 12.1 above A', '\n  <lemma-block ref="tab:acc" focus=\'tr[data-row="Ours"]\'></lemma-block>') }, library);
    const added = await tool('add_slide')({ paper: 'res-a', html: slide('Takeaways'), after: 'cover', id: 'take' }, library);
    expect(added).toContain('Added slide take as slide 2.');
    await tool('move_slide')({ paper: 'res-a', slide: 'take', after: 'res-1' }, library);
    await tool('add_slide')({ paper: 'res-a', html: slide('Spare') }, library);
    const removed = await tool('delete_slide')({ paper: 'res-a', slide: 's4' }, library);
    expect(removed).toContain('Deleted slide s4');
    const deck = parseDeck(state.files[PATH]);
    expect(deck.slides.map((item) => item.id)).toEqual(['cover', 'res-1', 'take']);
    expect(deck.slides[1].html).toContain('EM: Ours is 12.1 above A');
    expect(state.commits).toHaveLength(6);
    expect(state.papers[0].slides?.html?.hash).toBe(hashText(state.files[PATH]));
    expect(removed).toContain('2. res-1 — EM: Ours is 12.1 above A (1 step)');
  });

  it('changes the title, footer, brief and style', async () => {
    const { library, state } = await started();
    await tool('update_deck')({ paper: 'res-a', footer: 'Ada Example · Lab meeting', style: ':root { --accent: #8a1c1c; }' }, library);
    const deck = parseDeck(state.files[PATH]);
    expect(deck.footer).toBe('Ada Example · Lab meeting');
    expect(deck.css).toBe(':root { --accent: #8a1c1c; }');
    expect(deck.brief).toBe('Occasion: lab meeting\nLength: 10 minutes');
    expect(await tool('update_deck')({ paper: 'res-a', footer: 'Ada Example · Lab meeting' }, library)).toBe('Nothing changed.');
  });

  it('takes one <section class="slide"> and nothing else', async () => {
    const { library } = await started();
    const update = (html: string) => tool('update_slide')({ paper: 'res-a', slide: 'res-1', html }, library);
    await expect(update('<p>Loose text</p>')).rejects.toThrow(ToolError);
    await expect(update('<section class="slide">A</section>\n<!-- slide: x -->\n<section class="slide">B</section>')).rejects.toThrow(/Leave out/);
    await expect(update('<section class="slide"><body></body></section>')).rejects.toThrow(/no <html>/);
    await expect(tool('update_slide')({ paper: 'res-a', slide: 'nope', html: slide('X') }, library)).rejects.toThrow(/No slide nope\. The slides: cover, res-1/);
  });

  it('stops when the slides changed meanwhile', async () => {
    const { library, state } = await started();
    const stale = library.papers;
    const before = state.papers;
    library.papers = async () => before;
    await tool('update_slide')({ paper: 'res-a', slide: 'cover', html: slide('Changed in OnizukaTex') }, { ...library, papers: stale });
    await expect(tool('update_slide')({ paper: 'res-a', slide: 'res-1', html: slide('Mine') }, library)).rejects.toThrow(/changed meanwhile/);
  });
});

describe('slides and the blocks they come from', () => {
  it('says when a block a slide was written from changed, until the slide is checked', async () => {
    const { library, state } = await started();
    const line = parseDeck(state.files[PATH]).slides[1];
    expect(Object.keys(line.seen ?? {})).toEqual(['t1']);
    state.papers = applyResultsOp(state.papers, { kind: 'putBlock', paperId: 'res-a', block: { id: 't1', kind: 'table', source: TABLE.replace('42.2', '43.0') } });
    expect(await tool('get_slides')({ paper: 'res-a' }, library)).toContain('Slide res-1: t1 changed since the slide was written');
    const marked = await tool('update_slide')({ paper: 'res-a', slide: 'res-1', html: line.html }, library);
    expect(marked).toContain('Marked slide res-1 as checked against its blocks.');
    expect(marked).not.toContain('changed since');
    expect(await tool('update_slide')({ paper: 'res-a', slide: 'res-1', html: line.html }, library)).toContain('nothing changed');
  });
});

describe('checking a deck against the guide', () => {
  const deckOf = (...slides: string[]) => ({ title: '', footer: '', brief: '', css: '', slides: slides.map((html, index) => ({ id: `s${index + 1}`, html })) });

  it('counts the clicks of a slide', () => {
    expect(stepsIn(slide('A', '<p data-step="2">x</p>'))).toBe(2);
    expect(stepsIn('<lemma-block ref="t" focus="tr; td; th"></lemma-block>')).toBe(3);
    expect(stepsIn('<lemma-chart ref="t" col="EM" base="A"></lemma-chart>')).toBe(1);
    expect(stepsIn('<lemma-chart ref="t" col="EM"></lemma-chart>')).toBe(0);
  });

  it('finds what does not work and what moves too much', () => {
    const notes = checkDeck(
      deckOf(
        slide('A', '<lemma-block ref="tab:gone"></lemma-block><script>x()</script>'),
        slide('B', '<p data-step="3">x</p>'),
        slide('C', '<lemma-chart ref="exps" col="EM"></lemma-chart><p data-step="1" style="animation: spin 1s">x</p>'),
        slide('D', '<p data-step="1">x</p>'),
      ),
      paper(),
    );
    expect(notes).toEqual([
      'Slide s1: no block "tab:gone" in the paper.',
      'Slide s1: scripts and event handlers do not run on a slide; take them out.',
      'Slide s2: 3 steps; keep it to two.',
      "Slide s3: the chart's block exps is a text, not a table.",
      "Slide s3: animations of its own; the kit's motion is all a slide should have.",
      '3 of 4 slides have steps; keep steps to about a third of them.',
    ]);
  });

  it('counts the table-to-chart moves', () => {
    const table = '<lemma-block ref="tab:acc"></lemma-block>';
    const chart = '<lemma-chart ref="tab:acc" col="EM"></lemma-chart>';
    const pair = [slide('T', table), slide('C', chart)];
    expect(checkDeck(deckOf(...pair, slide('X'), ...pair), paper())).toEqual([]);
    expect(checkDeck(deckOf(...pair, ...pair), paper())).toEqual(['Two table-to-chart moves come one right after the other; space them out.']);
  });
});
