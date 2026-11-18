import { describe, expect, it } from 'vitest';
import { fullDocument } from './document';
import { cleanBuild, filesRead, splitForFormat } from './preambleFormat';

describe('splitForFormat', () => {
  it('keeps the class and preamble for the format and their line numbers in main.tex', () => {
    const doc = fullDocument('\\documentclass{article}\n\\usepackage{amsmath}', 'Hello.', null);
    const { source, main } = splitForFormat(doc);
    expect(source).toBe('\\documentclass{article}\n\\usepackage{amsmath}');
    const lines = main.split('\n');
    expect(lines.length).toBe(doc.main.split('\n').length);
    expect(lines[0]).toBe('%');
    expect(lines[1]).toContain('\\pdfcolorstack');
    expect(lines.slice(2)).toEqual(doc.main.split('\n').slice(2));
    expect(main).toContain('\\begin{document}');
    expect(main).toContain('\\openout\\galley@marks');
  });

  it('puts the class the view adds into the format too', () => {
    const doc = fullDocument('\\usepackage{amsmath}', 'Hello.', null);
    expect(splitForFormat(doc).source).toBe('\\documentclass{article}\n\\usepackage{amsmath}');
  });
});

describe('filesRead', () => {
  const files = { 'macros.tex': 'x', 'sty/acl.sty': 'y', 'fig.pdf': new Uint8Array(1) };

  it('finds the working directory files a run opened', () => {
    expect(filesRead('(./macros.tex) (/tex/amsmath.sty (./sty/acl.sty))', files).sort()).toEqual(['macros.tex', 'sty/acl.sty']);
  });

  it('reads names the log broke across lines', () => {
    expect(filesRead('(./sty/a\ncl.sty)', files)).toEqual(['sty/acl.sty']);
  });

  it('ignores files that are not the paper’s', () => {
    expect(filesRead('(./other.sty)', files)).toEqual([]);
  });
});

describe('cleanBuild', () => {
  it('rejects a build with an error or a file opened for writing', () => {
    expect(cleanBuild('Beginning to dump on file pdflatex.fmt')).toBe(true);
    expect(cleanBuild('! Undefined control sequence.')).toBe(false);
    expect(cleanBuild("\\openout3 = `pdflatex.idx'.")).toBe(false);
  });
});
