import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMIT } from './actions';
import { MAX_UPLOAD, planUpload } from './uploads';

const picked = (path: string, size = 10) => ({ path, file: new File([new Uint8Array(size)], path.split('/').pop()!) });

describe('planUpload', () => {
  it('names the files with their folders, notes what they replace and leaves out what compiles cannot use', async () => {
    const plan = await planUpload(
      [picked('figs/a.pdf'), picked('figs/sub/b.png'), picked('refs.bib'), picked('figs/notes.svg'), picked('run.py'), picked('big.pdf', ATTACHMENT_LIMIT + 1)],
      ['refs.bib', 'figs/a.pdf', 'other.sty'],
    );
    expect(Object.keys(plan.files)).toEqual(['figs/a.pdf', 'figs/sub/b.png', 'refs.bib']);
    expect(plan.files['figs/a.pdf']).toHaveLength(10);
    expect(plan.replaced).toEqual(['figs/a.pdf', 'refs.bib']);
    expect(plan.skipped).toEqual({ type: ['figs/notes.svg', 'run.py'], size: ['big.pdf'], count: [] });
  });

  it('notes a .zip that is a LaTeX project, which can become the paper itself', async () => {
    const zip = new JSZip();
    zip.file('paper/main.tex', '\\documentclass{article}\n\\begin{document}\nMade up.\n\\end{document}\n');
    zip.file('paper/figs/a.pdf', 'pdf');
    zip.file('paper/run.py', 'print()');
    const project = await planUpload([{ path: 'paper.zip', file: new File([(await zip.generateAsync({ type: 'uint8array' })).slice()], 'paper.zip') }], []);
    expect(project.project?.archive).toBe('paper.zip');
    expect(Object.keys(project.project?.files ?? {}).sort()).toEqual(['figs/a.pdf', 'main.tex']);
    expect(project.project?.skipped).toEqual(['run.py']);
    // The plain upload stays possible: the same files as attachments.
    expect(Object.keys(project.files).sort()).toEqual(['figs/a.pdf', 'main.tex']);
    const figures = new JSZip();
    figures.file('a.pdf', 'pdf');
    const plain = await planUpload([{ path: 'figs.zip', file: new File([(await figures.generateAsync({ type: 'uint8array' })).slice()], 'figs.zip') }], []);
    expect(plain.project).toBeUndefined();
  });

  it(`takes at most ${MAX_UPLOAD} files at once`, async () => {
    const many = Array.from({ length: MAX_UPLOAD + 2 }, (_, index) => picked(`f${index}.pdf`));
    const plan = await planUpload(many, []);
    expect(Object.keys(plan.files)).toHaveLength(MAX_UPLOAD);
    expect(plan.skipped.count).toEqual([`f${MAX_UPLOAD}.pdf`, `f${MAX_UPLOAD + 1}.pdf`]);
  });
});
