/**
 * A LaTeX project (an Overleaf download, a zipped folder) as a paper: its main .tex's preamble becomes the
 * paper's, its text is cut into blocks at sections, the abstract, figures and tables (with \input files taken
 * in), its \title and \author become the paper's, and its other files become attachments, the .bib files also
 * as the references.bib Lemma typesets.
 */
import { ResultBlockKind } from '../../types';
import { attachmentName } from './actions';
import { REFERENCES_FILE } from './compile';
import { MAX_UPLOAD } from './uploads';

const decode = (data: Uint8Array): string => new TextDecoder().decode(data);

/** Where a line's comment starts (a % not escaped by an odd number of backslashes), or its length. */
export function commentAt(line: string): number {
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] !== '%') continue;
    let slashes = 0;
    for (let back = at - 1; back >= 0 && line[back] === '\\'; back -= 1) slashes += 1;
    if (slashes % 2 === 0) return at;
  }
  return line.length;
}

/** The text with every comment blanked out, character for character, so positions in it are the text's. */
export const maskComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => {
      const at = commentAt(line);
      return line.slice(0, at) + ' '.repeat(line.length - at);
    })
    .join('\n');

/** Where the argument in braces starting at `open` ends (the index after its closing brace), or -1. */
function closing(masked: string, open: number): number {
  let depth = 0;
  for (let at = open; at < masked.length; at += 1) {
    const char = masked[at];
    if (char === '\\') {
      at += 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/** The argument of the first \command{…} (after an optional [short form]), or null. */
export function argumentOf(source: string, command: string): string | null {
  const masked = maskComments(source);
  const match = new RegExp(`\\\\${command}\\s*(\\[[^\\]]*\\]\\s*)?\\{`).exec(masked);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const end = closing(masked, open);
  return end < 0 ? null : source.slice(open + 1, end - 1);
}

/** The text with every \command{…} (and what is in its braces) taken out. */
function withoutCommand(source: string, command: string): string {
  let out = source;
  for (;;) {
    const masked = maskComments(out);
    const match = new RegExp(`\\\\${command}\\s*(\\[[^\\]]*\\]\\s*)?\\{`).exec(masked);
    if (!match) return out;
    const end = closing(masked, match.index + match[0].length - 1);
    if (end < 0) return out;
    out = out.slice(0, match.index) + out.slice(end);
  }
}

/** Words of LaTeX as they read: no notes, commands, braces or ties. */
export function plainText(source: string): string {
  let text = maskComments(source);
  for (const note of ['thanks', 'footnote', 'footnotemark', 'thanksref', 'label']) text = withoutCommand(text, note);
  return text
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}$]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A main .tex: its preamble (from \documentclass) and its body (between \begin{document} and \end{document}). */
export function splitDocument(source: string): { preamble: string; body: string } | null {
  const masked = maskComments(source);
  const begin = /\\begin\s*\{document\}/.exec(masked);
  if (!begin) return null;
  const start = begin.index + begin[0].length;
  const end = /\\end\s*\{document\}/.exec(masked.slice(start));
  return { preamble: `${source.slice(0, begin.index).replace(/\s+$/, '')}\n`, body: source.slice(start, end ? start + end.index : undefined) };
}

/** The .tex files that are whole documents, the likeliest main one first: least deep, then main.tex, then by name. */
export function mainCandidates(files: Record<string, Uint8Array>): string[] {
  const depth = (path: string) => path.split('/').length;
  const isMain = (path: string) => (/(^|\/)main\.tex$/i.test(path) ? 0 : 1);
  return Object.keys(files)
    .filter((path) => path.toLowerCase().endsWith('.tex'))
    .filter((path) => {
      const masked = maskComments(decode(files[path]));
      return /\\documentclass/.test(masked) && /\\begin\s*\{document\}/.test(masked);
    })
    .sort((a, b) => depth(a) - depth(b) || isMain(a) - isMain(b) || a.localeCompare(b));
}

/** The project file \input{name} reads: TeX looks next to the main file, adding .tex when there is no extension. */
function resolve(name: string, base: string, files: Record<string, Uint8Array>, extension: string): string | null {
  const clean = name.trim().replace(/^\.\//, '');
  for (const path of [`${base}${clean}`, `${base}${clean}${extension}`]) if (files[path]) return path;
  return null;
}

/** The text with each \input{…} and \include{…} of a project file replaced by that file's text, nested ones too. */
export function inlineInputs(source: string, files: Record<string, Uint8Array>, base: string, inlined: Set<string>, depth = 0): string {
  if (depth > 8) return source;
  const masked = maskComments(source);
  let out = '';
  let last = 0;
  for (const match of masked.matchAll(/\\(input|include)\s*\{([^}]*)\}/g)) {
    const at = match.index ?? 0;
    const path = resolve(match[2], base, files, '.tex');
    if (!path || inlined.has(path)) continue;
    inlined.add(path);
    out += source.slice(last, at) + inlineInputs(decode(files[path]), files, base, inlined, depth + 1).replace(/\s+$/, '');
    last = at + match[0].length;
  }
  return out + source.slice(last);
}

/** The paper's title and authors from \title{…} and \author{…}: names before each author's first line break. */
export function metadataOf(source: string): { title: string; authors: string[] } {
  const title = argumentOf(source, 'title');
  const author = argumentOf(source, 'author');
  const authors = (author ?? '')
    .split(/\\(?:and|And|AND)\b/)
    .map((part) => plainText(part.split(/\\\\/)[0]))
    .filter(Boolean);
  return { title: title ? plainText(title) : '', authors };
}

/** The .bib files a project typesets its references from (\bibliography{a,b}, \addbibresource{a.bib}). */
export function bibliographyOf(source: string): string[] {
  const masked = maskComments(source);
  const names: string[] = [];
  for (const match of masked.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) names.push(...match[1].split(',').map((name) => name.trim()));
  for (const match of masked.matchAll(/\\addbibresource\s*(\[[^\]]*\]\s*)?\{([^}]*)\}/g)) names.push(match[2].trim());
  return names.filter(Boolean);
}

/** The body without what Lemma shows itself: \maketitle (the paper's title), and the bibliography commands. */
export function withoutPageParts(body: string): string {
  let out = body;
  for (const command of ['bibliography', 'bibliographystyle', 'nocite']) out = withoutCommand(out, command);
  return out.replace(/^[ \t]*\\(maketitle|printbibliography)\b(\[[^\]]*\])?[ \t]*$/gm, '');
}

/** Commands that print nothing: a block of only these would compile to an empty page. */
const SILENT = /\\(appendix|clearpage|newpage|cleardoublepage|pagebreak|FloatBarrier|noindent|bigskip|medskip|smallskip|centering)\b|\\(label|vspace\*?|hspace\*?)\s*\{[^}]*\}/g;

const hasContent = (source: string): boolean => maskComments(source).replace(SILENT, '').trim() !== '';

const FLOAT = /\\begin\s*\{(figure|table)(\*?)\}/;
const VERBATIM = /\\begin\s*\{(verbatim|Verbatim|lstlisting|minted|comment)\*?\}/;

const count = (text: string, pattern: string): number => text.split(pattern).length - 1;

/**
 * The body cut into blocks: a figure or table environment is a block of its own; text is cut where a
 * \section or \subsection starts and around the abstract. Text that prints nothing on its own (\appendix, a
 * \clearpage) goes on with what follows.
 */
export function blocksOfBody(body: string): { kind: ResultBlockKind; source: string }[] {
  const blocks: { kind: ResultBlockKind; source: string }[] = [];
  let current: string[] = [];
  const flush = (kind: ResultBlockKind) => {
    const source = current.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (kind === 'text' && !hasContent(source)) return;
    if (source) blocks.push({ kind, source });
    current = [];
  };
  let float: { env: string; kind: ResultBlockKind; depth: number } | null = null;
  let verbatim: string | null = null;
  for (const line of body.split('\n')) {
    const code = line.slice(0, commentAt(line));
    if (verbatim) {
      current.push(line);
      if (line.includes(`\\end{${verbatim}`)) verbatim = null;
      continue;
    }
    if (float) {
      current.push(line);
      float.depth += count(code, `\\begin{${float.env}}`) - count(code, `\\end{${float.env}}`);
      if (float.depth <= 0) {
        flush(float.kind);
        float = null;
      }
      continue;
    }
    const begin = FLOAT.exec(code);
    if (begin) {
      flush('text');
      const env = `${begin[1]}${begin[2]}`;
      float = { env, kind: begin[1] === 'table' ? 'table' : 'figure', depth: count(code, `\\begin{${env}}`) - count(code, `\\end{${env}}`) };
      current.push(line);
      if (float.depth <= 0) {
        flush(float.kind);
        float = null;
      }
      continue;
    }
    if (/^\s*\\(section|subsection)\*?\s*[[{]/.test(code) || /^\s*\\begin\s*\{abstract\}/.test(code)) flush('text');
    const verb = VERBATIM.exec(code);
    if (verb) verbatim = verb[1];
    current.push(line);
    if (/\\end\s*\{abstract\}/.test(code)) flush('text');
  }
  flush(float ? float.kind : 'text');
  return blocks;
}

/** A project read as a paper, ready to save. */
export interface ProjectPaper {
  /** The main .tex, by its path in the project. */
  main: string;
  title: string;
  authors: string[];
  preamble: string;
  blocks: { kind: ResultBlockKind; source: string }[];
  /** By attachment name: the project's files next to the main .tex, folders kept, and references.bib. */
  attachments: Record<string, Uint8Array>;
  /** Files whose names had to change to be stored (spaces, other scripts), and what they became. */
  renamed: { from: string; to: string }[];
  /** Files past MAX_UPLOAD. */
  overflow: string[];
}

const replaceEvery = (text: string, from: string, to: string): string => text.split(from).join(to);

/** Reads a project as a paper, from `main` (one of mainCandidates). */
export async function projectPaper(files: Record<string, Uint8Array>, main: string): Promise<ProjectPaper | null> {
  const document = splitDocument(decode(files[main]));
  if (!document) return null;
  const base = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const inlined = new Set<string>([main]);
  const body = inlineInputs(document.body, files, base, inlined);
  const { title, authors } = metadataOf(`${document.preamble}\n${body}`);
  const bibs = bibliographyOf(`${document.preamble}\n${body}`)
    .map((name) => resolve(name, base, files, '.bib'))
    .filter((path): path is string => path !== null);
  let preamble = document.preamble;
  let blocks = blocksOfBody(withoutPageParts(body));

  // The files TeX reads, by their path next to the main .tex (where compiles put them), the parts taken into
  // the text left out.
  const attachments: Record<string, Uint8Array> = {};
  const renamed: ProjectPaper['renamed'] = [];
  const overflow: string[] = [];
  for (const [path, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (inlined.has(path)) continue;
    const relative = path.startsWith(base) ? path.slice(base.length) : path;
    const parts = relative.split('/');
    const name = await attachmentName(parts.pop() ?? relative, data, parts);
    if (Object.keys(attachments).length >= MAX_UPLOAD) {
      overflow.push(relative);
      continue;
    }
    attachments[name] = data;
    if (name !== relative) renamed.push({ from: relative, to: name });
  }
  // A renamed file is found under its new name, written with or without its extension.
  for (const { from, to } of renamed) {
    const strip = (name: string) => name.replace(/\.[^./]+$/, '');
    for (const [old, now] of [[from, to], [strip(from), strip(to)]]) {
      preamble = replaceEvery(preamble, old, now);
      blocks = blocks.map((block) => ({ ...block, source: replaceEvery(block.source, old, now) }));
    }
  }
  // Lemma typesets the bibliography from references.bib: the project's .bib files, one after another.
  if (bibs.length > 0) attachments[REFERENCES_FILE] = new TextEncoder().encode(bibs.map((path) => decode(files[path]).replace(/\s+$/, '')).join('\n\n') + '\n');
  return { main, title, authors, preamble, blocks, attachments, renamed, overflow };
}
