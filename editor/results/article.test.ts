import { describe, expect, it } from 'vitest';
import type { ResultBlock, ResultPaper } from '../../types';
import { articleBody, articleHash, blockHeadingLines, bodyBlocks, packMarks, unpackMarks } from './article';

const block = (id: string, source: string, extra: Partial<ResultBlock> = {}): ResultBlock => ({ id, kind: 'text', source, ...extra });
const paper = (blocks: ResultBlock[], extra: Partial<ResultPaper> = {}): ResultPaper => ({ id: 'res-a', slug: 'a', title: 'A', authors: [], blocks, ...extra });

describe('articleBody', () => {
  it('puts the shown blocks under their marker lines and says which lines each holds', () => {
    const { body, blocks } = articleBody([block('b1', '\\section{Intro}\nText.'), block('b2', 'Hidden.', { hidden: true }), block('b3', 'More.')]);
    expect(body).toBe('%% galley-block b1 text\n\\section{Intro}\nText.\n\n%% galley-block b3 text\nMore.\n');
    expect(blocks).toEqual([
      { id: 'b1', from: 1, to: 3, heading: 'Intro' },
      { id: 'b3', from: 5, to: 6 },
    ]);
  });

  it('reads the blocks and their headings back from edited text', () => {
    const body = '%% galley-block a text\n\\section{The \\emph{Big} Idea}\nText.\n\\subsection{Later}\n\n\n%% galley-block b figure\n\\begin{figure}\n\\end{figure}\n';
    const blocks = bodyBlocks(body);
    expect(blocks).toEqual([
      { id: 'a', from: 1, to: 4, heading: 'The Big Idea' },
      { id: 'b', from: 7, to: 9 },
    ]);
    expect(blockHeadingLines(body, blocks[0])).toEqual([2, 4]);
  });

  it('can keep hidden blocks, for whoever edits the paper', () => {
    const { blocks } = articleBody([block('b1', 'One.'), block('b2', 'Two.', { hidden: true })], { hidden: true });
    expect(blocks.map((item) => item.id)).toEqual(['b1', 'b2']);
  });

  it('leaves out blocks with nothing in them', () => {
    expect(articleBody([block('b1', '  '), block('b2', 'Two.')]).blocks.map((item) => item.id)).toEqual(['b2']);
  });
});

describe('articleHash', () => {
  it('changes with what the article prints, and not with what it does not', () => {
    const base = paper([block('b1', 'One.'), block('b2', 'Two.')], { preamble: '\\documentclass{article}', fileHashes: { 'a.png': 'x' } });
    const same = articleHash(base);
    expect(articleHash({ ...base, title: 'Other title' })).toBe(same);
    expect(articleHash({ ...base, blocks: [block('b2', 'Two.'), block('b1', 'One.')] })).not.toBe(same);
    expect(articleHash({ ...base, blocks: [block('b1', 'One.'), block('b2', 'Two.', { hidden: true })] })).not.toBe(same);
    expect(articleHash({ ...base, preamble: '\\documentclass{report}' })).not.toBe(same);
    expect(articleHash({ ...base, fileHashes: { 'a.png': 'y' } })).not.toBe(same);
  });
});

describe('packMarks', () => {
  it('keeps marks compact and gives them back as they were', () => {
    const marks = [
      { kind: 'L' as const, line: 3, page: 1, x: 72.25, y: 700.5, width: 240 },
      { kind: 'B' as const, file: 2, line: 9, page: 2, x: 72, y: 650, width: 500 },
    ];
    const packed = packMarks(marks);
    expect(packed).toEqual([
      ['L', 3, 1, 72.25, 700.5, 240],
      ['B', 9, 2, 72, 650, 500, 2],
    ]);
    expect(unpackMarks(packed)).toEqual(marks);
  });
});
