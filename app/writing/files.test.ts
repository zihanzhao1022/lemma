import { describe, expect, it } from 'vitest';
import { attachedKey, attachedName, editableText, isLatex } from './files';

describe('attachments in the writing view', () => {
  it('opens text files written in UTF-8, nothing else', () => {
    expect(editableText('acl.sty', new TextEncoder().encode('\\ProvidesPackage{acl}'))).toBe('\\ProvidesPackage{acl}');
    expect(editableText('sections/intro.tex', new TextEncoder().encode('Grüße'))).toBe('Grüße');
    // Latin-1 bytes would not come back the same once saved.
    expect(editableText('old.sty', new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]))).toBeNull();
    expect(editableText('figs/a.pdf', new TextEncoder().encode('%PDF-1.5'))).toBeNull();
    expect(editableText('notes.txt', new TextEncoder().encode('x'))).toBeNull();
  });

  it('keeps the byte order mark a file has', () => {
    const text = editableText('a.tex', new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
    expect(new TextEncoder().encode(text ?? '')).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
  });

  it('keys attachments apart from the paper’s own main.tex', () => {
    expect(attachedKey('main.tex')).not.toBe('main.tex');
    expect(attachedName(attachedKey('figs/x.tex'))).toBe('figs/x.tex');
    expect(attachedName('preamble.tex')).toBeNull();
    expect([isLatex('acl.sty'), isLatex('acl_natbib.bst'), isLatex('refs.bib')]).toEqual([true, false, false]);
  });
});
