import { ATTACHMENT_TYPES, IMAGE_TYPES, extensionOf } from '../../editor/results/actions';

/** The writing view's key for an attachment, apart from its own main.tex, preamble.tex and references.bib. */
export const ATTACHED = 'files/';
export const attachedKey = (name: string): string => `${ATTACHED}${name}`;
export const attachedName = (key: string): string | null => (key.startsWith(ATTACHED) ? key.slice(ATTACHED.length) : null);

/** Attachments written as text: a template's .sty and .cls, .tex it inputs, .bib and .bst. */
export const TEXT_TYPES = ATTACHMENT_TYPES.filter((type) => !IMAGE_TYPES.includes(type));

/** Files the writing view makes itself when it compiles, which an attachment of that name never reaches. */
export const SHADOWED = ['main.tex', 'main.aux', 'main.bbl'];

/**
 * An attachment's text, when it is one the editor can change and save as it was: a text type, and UTF-8 (a
 * file in another encoding would come back changed). Null for images, PDFs and the rest.
 */
export function editableText(name: string, data: Uint8Array): string | null {
  if (!TEXT_TYPES.includes(extensionOf(name))) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return null;
  }
}

/** Whether the editor colours a file as LaTeX: not a .bib or .bst. */
export const isLatex = (name: string): boolean => !['.bib', '.bst'].includes(extensionOf(name));
