/**
 * The writing view: the paper as one LaTeX document, edited in place of the page's separate blocks.
 *
 * main.tex holds every block under a marker comment naming it, so edits go back to the blocks they belong to.
 * The whole document is compiled with marks at the start of its lines (pdfTeX's \pdfsavepos) that write where
 * those lines landed in the PDF; a double click in the PDF finds the nearest mark before it, then the clicked
 * word near that line. The engine has no SyncTeX, so this is its own, coarser version of it.
 */
import { passOptionsLines, stripComments } from '../../editor/tex/document';
import { ResultBlock, ResultBlockKind } from '../../types';

/* ------------------------------------------------------------------ main.tex and the blocks */

const MARKER = /^%% galley-block (\S+) (text|figure|table)\s*$/;

export const markerLine = (id: string, kind: ResultBlockKind): string => `%% galley-block ${id} ${kind}`;

export function readMarker(line: string): { id: string; kind: ResultBlockKind } | null {
  const match = MARKER.exec(line);
  return match ? { id: match[1], kind: match[2] as ResultBlockKind } : null;
}

// The visual table editor's cache line (editor/results/table/latex.ts) is not the owner's code.
const CACHE = /(^|\n)% portfolio-table:v1 [^\n]*/g;

/** A block's code as the writing view shows it. */
export const editableSource = (source: string): string => source.replace(CACHE, '$1').replace(/^\n+/, '').replace(/\s+$/, '');

/** main.tex for the writing view: each block under its marker line, in the page's order. */
export function bodyOf(blocks: ResultBlock[]): string {
  return `${blocks.map((block) => `${markerLine(block.id, block.kind)}\n${editableSource(block.source ?? '')}`).join('\n\n')}\n`;
}

export interface BodyBlock {
  id: string;
  kind: ResultBlockKind;
  source: string;
}

/** The blocks of an edited main.tex: what follows each marker line, up to the next. A repeated id is a new block. */
export function blocksOf(body: string): BodyBlock[] {
  const blocks: { id: string; kind: ResultBlockKind; lines: string[] }[] = [];
  const before: string[] = [];
  const seen = new Set<string>();
  for (const line of body.split('\n')) {
    const marker = readMarker(line);
    if (marker) {
      blocks.push({ id: seen.has(marker.id) ? '' : marker.id, kind: marker.kind, lines: [] });
      seen.add(marker.id);
    } else if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
    else before.push(line);
  }
  const result = blocks.map((block) => ({ id: block.id, kind: block.kind, source: block.lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '') }));
  // Text typed above the first marker belongs to the first block.
  const lead = before.join('\n').trim();
  if (lead) {
    if (result.length > 0) result[0] = { ...result[0], source: `${lead}\n${result[0].source}`.replace(/\s+$/, '') };
    else result.push({ id: '', kind: 'text', source: lead });
  }
  return result;
}

/** The kind a new block gets from what it holds. */
export const kindOf = (source: string): ResultBlockKind =>
  /\\begin\{table\*?\}/.test(stripComments(source)) ? 'table' : /\\begin\{figure\*?\}/.test(stripComments(source)) ? 'figure' : 'text';

/** What changed between the page's blocks and an edited main.tex, block by block. */
export interface BlockChanges {
  /** Existing blocks whose code changed, and new blocks with where they go. */
  put: { block: ResultBlock; at?: number }[];
  deleted: ResultBlock[];
  /** The new order of the blocks, when it changed. */
  order?: string[];
}

export function blockChanges(stored: ResultBlock[], edited: BodyBlock[], newId: () => string): BlockChanges {
  const byId = new Map(stored.map((block) => [block.id, block]));
  const put: BlockChanges['put'] = [];
  const kept: string[] = [];
  edited.forEach((item, index) => {
    if (!item.source.trim()) return;
    const existing = item.id ? byId.get(item.id) : undefined;
    if (existing) {
      kept.push(existing.id);
      if (editableSource(existing.source ?? '') !== item.source) put.push({ block: { ...existing, source: item.source } });
      return;
    }
    // A block started in the writing view already has its id in its marker line.
    const block: ResultBlock = { id: item.id || newId(), kind: kindOf(item.source), source: item.source };
    kept.push(block.id);
    put.push({ block, at: index });
  });
  const deleted = stored.filter((block) => !kept.includes(block.id));
  const before = stored.map((block) => block.id).filter((id) => kept.includes(id));
  const after = kept.filter((id) => byId.has(id));
  const added = put.some((change) => change.at !== undefined);
  const order = added || before.join() !== after.join() ? kept : undefined;
  return { put, deleted, ...(order ? { order } : {}) };
}

/* ------------------------------------------------------------------ the whole document, with position marks */

const TEXT_ENVIRONMENTS = new Set([
  'document', 'abstract', 'itemize', 'enumerate', 'description', 'quote', 'quotation', 'verse', 'center', 'flushleft',
  'flushright', 'minipage', 'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'example', 'proof',
  'claim', 'conjecture', 'assumption', 'note',
]);
const FLOATS = new Set(['figure', 'figure*', 'table', 'table*']);
const VERBATIM = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment']);
// A line that starts a word of running text: it would start a paragraph, or go on with one.
const TEXT_START = /^\s*[\p{L}\p{N}(`'"]/u;
const FLOAT_BEGIN = /^\s*\\begin\s*\{(figure|table)(\*?)\}/;
// A heading at a line's start, up to the brace its title opens with.
const HEADING_START = /^\s*\\(?:section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]{}]*\]\s*)?\{/;

/** A placement option can follow a float opening on a later line; the mark must come after that option. */
function floatContentStart(lines: string[], line: number, offset: number): { line: number; offset: number } {
  const opening = { line, offset };
  let option = false;
  for (let row = line; row < lines.length; row += 1) {
    for (let column = row === line ? offset : 0; column < lines[row].length; column += 1) {
      const char = lines[row][column];
      if (char === '%') break;
      if (!option) {
        if (/\s/.test(char)) continue;
        if (char !== '[') return opening;
        option = true;
      } else if (char === ']') return { line: row, offset: column + 1 };
    }
  }
  return opening;
}

/**
 * main.tex with marks at the start of lines of running text (\galleytext) and inside floats at their beginning
 * and end (\galleyfloat, \galleyend), each naming its line. Marks go only where they cannot change the output:
 * in text environments, outside braces, math and verbatim, and never where a line goes on from a % comment.
 * Lines stay where they were, so TeX's line numbers still match main.tex.
 */
export function withMarks(body: string, file = 0): string {
  const mark = (kind: string, line: number) => file === 0 ? `\\galley${kind}{${line}}` : `\\galley${kind}at{${file}}{${line}}`;
  const lines = body.split('\n');
  const environments: string[] = ['document'];
  let depth = 0;
  let math = false;
  let verbatim: string | null = null;
  let glued = false;
  const delayed = new Map<number, { offset: number; text: string }[]>();
  return lines
    .map((line, index) => {
      const n = index + 1;
      if (verbatim) {
        if (line.includes(`\\end{${verbatim}}`)) {
          verbatim = null;
          environments.pop();
        }
        glued = false;
        return line;
      }
      const top = environments[environments.length - 1];
      const calm = depth === 0 && !math && !glued;
      const insertions = delayed.get(index) ?? [];
      const heading = calm && TEXT_ENVIRONMENTS.has(top) ? HEADING_START.exec(line) : null;
      if (heading) {
        // Inside the title, where the heading's text is set.
        insertions.push({ offset: heading[0].length, text: mark('text', n) });
      } else if (calm && TEXT_ENVIRONMENTS.has(top) && TEXT_START.test(line)) {
        insertions.push({ offset: /^\s*/.exec(line)![0].length, text: `\\leavevmode${mark('text', n)}` });
      } else if (calm && TEXT_ENVIRONMENTS.has(top)) {
        const begin = FLOAT_BEGIN.exec(line);
        if (begin) {
          const content = floatContentStart(lines, index, begin[0].length);
          const insertion = { offset: content.offset, text: mark('float', n) };
          if (content.line === index) insertions.push(insertion);
          else delayed.set(content.line, [...(delayed.get(content.line) ?? []), insertion]);
        }
      }
      // The closing command can share a line with the opening, caption, label or table body.
      ({ depth, math, verbatim, glued } = scan(line, environments, depth, math, (offset) => {
        insertions.push({ offset, text: mark('end', n) });
      }));
      let marked = line;
      for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
        marked = `${marked.slice(0, insertion.offset)}${insertion.text}${marked.slice(insertion.offset)}`;
      }
      return marked;
    })
    .join('\n');
}

/** Follows braces, math, environments and comments through one line of LaTeX. */
function scan(line: string, environments: string[], depth: number, math: boolean, floatEnd?: (offset: number) => void): { depth: number; math: boolean; verbatim: string | null; glued: boolean } {
  let verbatim: string | null = null;
  let glued = false;
  for (let i = 0; i < line.length; ) {
    const char = line[i];
    if (char === '\\') {
      const rest = line.slice(i);
      const begin = /^\\begin\s*\{([^}]*)\}/.exec(rest);
      if (begin) {
        const name = begin[1].trim();
        environments.push(name);
        i += begin[0].length;
        if (VERBATIM.has(name)) {
          if (rest.includes(`\\end{${name}}`)) environments.pop();
          else verbatim = name;
          break;
        }
        continue;
      }
      const end = /^\\end\s*\{([^}]*)\}/.exec(rest);
      if (end) {
        const top = environments[environments.length - 1];
        if (depth === 0 && !math && FLOATS.has(top) && end[1].trim() === top) floatEnd?.(i);
        const at = environments.lastIndexOf(end[1].trim());
        if (at > 0) environments.length = at;
        i += end[0].length;
        continue;
      }
      const verb = /^\\verb\*?([^A-Za-z\s])/.exec(rest);
      if (verb) {
        const close = line.indexOf(verb[1], i + verb[0].length);
        i = close < 0 ? line.length : close + 1;
        continue;
      }
      if (rest.startsWith('\\(') || rest.startsWith('\\[')) math = true;
      else if (rest.startsWith('\\)') || rest.startsWith('\\]')) math = false;
      i += 2;
      continue;
    }
    if (char === '%') {
      // A comment glued to a word joins the next line to that word.
      glued = i > 0 && !/\s/.test(line[i - 1]);
      break;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === '$') {
      if (line[i + 1] === '$') i += 1;
      math = !math;
    }
    i += 1;
  }
  return { depth, math, verbatim, glued };
}

interface InputUse {
  name: string;
  safe: boolean;
}

/**
 * Files whose input sites are known to be ordinary text. A .tex attachment may instead be a fragment of
 * an equation, table or macro argument; forcing horizontal mode in such a fragment changes the document.
 * Unknown input syntax is deliberately left to the text-search fallback.
 */
export function markableInputs(body: string, files: Record<string, string>, unsafeSources: string[] = []): Set<string> {
  const resolve = (raw: string): string | null => {
    const parts: string[] = [];
    if (/[\\#{}]/.test(raw) || raw.startsWith('/')) return null;
    for (const part of raw.trim().split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
    const name = parts.join('/');
    if (!name) return null;
    if (Object.prototype.hasOwnProperty.call(files, name) && name.endsWith('.tex')) return name;
    return Object.prototype.hasOwnProperty.call(files, `${name}.tex`) ? `${name}.tex` : null;
  };

  let ambiguous = false;
  const usesOf = (source: string): InputUse[] => {
    const uses: InputUse[] = [];
    const environments = ['document'];
    let depth = 0;
    let math = false;
    let verbatim: string | null = null;
    let glued = false;
    for (const line of source.split('\n')) {
      if (verbatim) {
        if (line.includes(`\\end{${verbatim}}`)) {
          verbatim = null;
          environments.pop();
        }
        glued = false;
        continue;
      }
      const calm = depth === 0 && !math && !glued && TEXT_ENVIRONMENTS.has(environments[environments.length - 1]);
      for (let i = 0; i < line.length; ) {
        if (line[i] === '%') break;
        if (line[i] !== '\\') {
          i += 1;
          continue;
        }
        const rest = line.slice(i);
        const verb = /^\\verb\*?([^A-Za-z\s])/.exec(rest);
        if (verb) {
          const close = line.indexOf(verb[1], i + verb[0].length);
          i = close < 0 ? line.length : close + 1;
          continue;
        }
        const begin = /^\\begin\s*\{([^}]*)\}/.exec(rest);
        if (begin && VERBATIM.has(begin[1].trim())) break;
        const command = /^\\(?:input|include)(?![A-Za-z@])/.exec(rest);
        if (command) {
          const argument = /^\s*(?:\{([^{}\r\n]+)\}|([^\s{}%]+))/.exec(rest.slice(command[0].length));
          if (!argument) ambiguous = true;
          else {
            const raw = argument[1] ?? argument[2];
            if (/[\\#{}]/.test(raw)) ambiguous = true;
            const name = resolve(raw);
            const end = i + command[0].length + argument[0].length;
            if (name) uses.push({ name, safe: calm && !line.slice(0, i).trim() && !stripComments(line.slice(end)).trim() });
            i = end;
            continue;
          }
        }
        // Consume escaped backslashes and percent signs, so they cannot become input commands/comments.
        i += 2;
      }
      ({ depth, math, verbatim, glued } = scan(line, environments, depth, math));
    }
    return uses;
  };

  const roots = usesOf(body);
  const graph = new Map(Object.entries(files).map(([name, source]) => [name, usesOf(source)]));
  // The preamble and template definitions run before marks exist, or in an unknown expansion context.
  const external = unsafeSources.flatMap(usesOf);
  if (ambiguous) return new Set();
  const unsafe = new Set<string>();
  for (const use of [...roots, ...[...graph.values()].flat()]) if (!use.safe) unsafe.add(use.name);
  for (const use of external) unsafe.add(use.name);
  // An input inside an unsafe fragment inherits that fragment's unknown runtime context.
  const rejected = [...unsafe];
  for (let i = 0; i < rejected.length; i += 1) {
    for (const child of graph.get(rejected[i]) ?? []) {
      if (unsafe.has(child.name)) continue;
      unsafe.add(child.name);
      rejected.push(child.name);
    }
  }
  const allowed = new Set<string>();
  const pending = [...roots];
  for (let i = 0; i < pending.length; i += 1) {
    const use = pending[i];
    if (!use.safe || unsafe.has(use.name) || allowed.has(use.name)) continue;
    allowed.add(use.name);
    pending.push(...(graph.get(use.name) ?? []));
  }
  return allowed;
}

// Each mark writes "kind line sheet x y width" to main.gpos when its page is shipped out: the page's number
// among those shipped, and where the mark is, in scaled points from the page's bottom left. The width (of a
// float, for its box) is taken where the mark is, the rest when the page is shipped.
const MARK_SUPPORT = String.raw`\makeatletter
\RequirePackage{atbegshi}
\newwrite\galley@marks
\immediate\openout\galley@marks=main.gpos
\newcount\galley@sheet
\AtBeginShipout{\global\advance\galley@sheet\@ne}
\def\galley@mark#1#2#3{\pdfsavepos\edef\galley@width{\the\linewidth}\expandafter\galley@write\expandafter{\galley@width}{#1}{#2}{#3}}
\def\galley@write#1#2#3#4{\write\galley@marks{#2 #3 \the\galley@sheet\space\the\pdflastxpos\space\the\pdflastypos\space#1 #4}}
\protected\def\galleytext#1{\galleytextat{0}{#1}}
\protected\def\galleyfloat#1{\galleyfloatat{0}{#1}}
\protected\def\galleyend#1{\galleyendat{0}{#1}}
\protected\def\galleytextat#1#2{\ifhmode\galley@mark{L}{#2}{#1}\fi}
\protected\def\galleyfloatat#1#2{\galley@mark{B}{#2}{#1}}
\protected\def\galleyendat#1#2{\par\galley@mark{E}{#2}{#1}}
\protected\def\galleyreferences{\par\galley@mark{R}{0}{0}}
\makeatother`;

export interface FullDocument {
  main: string;
  /** Lines of main.tex where the preamble and the writing view's main.tex begin (1-based). */
  preambleStart: number;
  preambleLines: number;
  bodyStart: number;
  bodyLines: number;
}

/** Marks at the start of the preamble's \title and \author, as input file `file`, so their text on the page finds its line. */
export function withTitleMarks(preamble: string, file: number): string {
  return preamble
    .split('\n')
    .map((line, index) => line.replace(/^(\s*\\(?:title|author)\s*(?:\[[^\]{}]*\]\s*)?\{)/, `$1\\leavevmode\\galleytextat{${file}}{${index + 1}}`))
    .join('\n');
}

/**
 * The paper as one document: its preamble, every block in order and, when it cites, its bibliography. `titleFile`
 * marks the title and the authors (withTitleMarks), the preamble being that input file.
 */
export function fullDocument(preamble: string, body: string, bibliography: { style: string | null; file: string } | null, { titleFile }: { titleFile?: number } = {}): FullDocument {
  const own = (titleFile ? withTitleMarks(preamble, titleFile) : preamble).replace(/\s+$/, '');
  const head = passOptionsLines(own);
  if (!/\\documentclass/.test(stripComments(own))) head.push('\\documentclass{article}');
  const text = body.replace(/\s+$/, '');
  // The page shows the paper's title itself, so the blocks leave \maketitle out; the whole paper opens with it,
  // as the paper does, when the preamble gives a title the text does not set itself.
  const titled = /\\title\s*(?:\[[^\]]*\]\s*)?\{/.test(stripComments(own)) && !/\\maketitle(?![A-Za-z@])/.test(stripComments(text));
  const before = [...head, own, MARK_SUPPORT, '\\begin{document}', ...(titled ? ['\\maketitle'] : [])];
  // A null style: the template sets it itself (packageSetsStyle).
  const after = [
    ...(bibliography ? ['\\galleyreferences', ...(bibliography.style ? [`\\bibliographystyle{${bibliography.style}}`] : []), `\\bibliography{${bibliography.file.replace(/\.bib$/, '')}}`] : []),
    '\\end{document}',
    '',
  ];
  const opening = before.join('\n');
  return {
    main: `${opening}\n${withMarks(text)}\n${after.join('\n')}`,
    preambleStart: head.length + 1,
    preambleLines: own.split('\n').length,
    bodyStart: opening.split('\n').length + 1,
    bodyLines: text.split('\n').length,
  };
}

/* ------------------------------------------------------------------ from the PDF back to the source */

export interface Mark {
  /** A line of text, a float's beginning and end, and where the bibliography starts (line 0). */
  kind: 'L' | 'B' | 'E' | 'R';
  /** Index into the compile's file names; absent for main.tex. */
  file?: number;
  line: number;
  /** 1-based page of the PDF. */
  page: number;
  /** In PDF points from the page's bottom left. */
  x: number;
  y: number;
  width: number;
}

// \pdflastxpos and \pdflastypos are scaled points; PDF points (big points) are 72 to TeX's 72.27 per inch.
const SP_TO_BP = 72 / 72.27 / 65536;

export function parseMarks(text: string): Mark[] {
  const marks: Mark[] = [];
  for (const row of text.split('\n')) {
    const match = /^([LBER]) (\d+) (\d+) (-?\d+) (-?\d+) (-?[\d.]+)pt(?: (\d+))?$/.exec(row.trim());
    if (!match) continue;
    marks.push({
      kind: match[1] as Mark['kind'],
      ...(Number(match[7]) > 0 ? { file: Number(match[7]) } : {}),
      line: Number(match[2]),
      page: Number(match[3]),
      x: Number(match[4]) * SP_TO_BP,
      y: Number(match[5]) * SP_TO_BP,
      width: Number(match[6]) * (72 / 72.27),
    });
  }
  return marks;
}

export interface Hit {
  page: number;
  /** In PDF points from the page's bottom left; `baseline` is the clicked text's, when the click was on text. */
  x: number;
  y: number;
  baseline?: number;
  pageWidth: number;
}

export interface Located {
  file?: number;
  line: number;
  /** Where to look for the clicked word: up to the next marked line, or across a float. */
  until: number;
  /** A verified containing float is a strict source-search boundary. */
  scope?: 'float';
}

/** The source line a click in the PDF came from: inside a float, its first line; else the nearest mark before it. */
export function locate(marks: Mark[], hit: Hit): Located | null {
  const onPage = marks.filter((mark) => mark.page === hit.page);
  // Floats: a begin mark, the end mark after it, and the box between them.
  for (let index = 0; index < onPage.length; index += 1) {
    const begin = onPage[index];
    if (begin.kind !== 'B') continue;
    let end: Mark | undefined;
    for (const candidate of onPage.slice(index + 1)) {
      if ((candidate.file ?? 0) !== (begin.file ?? 0)) continue;
      // An unclosed float must not borrow a later float's closing mark.
      if (candidate.kind === 'B') break;
      if (candidate.kind === 'E' && candidate.line >= begin.line) {
        end = candidate;
        break;
      }
    }
    if (!end) continue;
    if (hit.x >= begin.x - 6 && hit.x <= begin.x + begin.width + 6 && hit.y <= begin.y + 6 && hit.y >= end.y - 6) return { ...(begin.file ? { file: begin.file } : {}), line: begin.line, until: end.line, scope: 'float' };
  }
  const text = marks.filter((mark) => mark.kind === 'L');
  if (text.length === 0) return null;
  const half = hit.pageWidth / 2;
  const twoColumns = text.some((mark) => mark.page === hit.page && mark.width < half * 0.9 && mark.x > half);
  const column = (x: number) => (twoColumns && x > half ? 1 : 0);
  const base = hit.baseline ?? hit.y - 3;
  // Reading order: page, then column, then down the page, then along the line.
  const before = (mark: Mark): boolean => {
    if (mark.page !== hit.page) return mark.page < hit.page;
    const a = column(mark.x);
    const b = column(hit.x);
    if (a !== b) return a < b;
    if (Math.abs(mark.y - base) <= 2) return mark.x <= hit.x + 1;
    return mark.y > base;
  };
  const order = (a: Mark, b: Mark): number => a.page - b.page || column(a.x) - column(b.x) || b.y - a.y || a.x - b.x;
  const sorted = [...text].sort(order);
  const earlier = sorted.filter(before);
  const found = earlier.length > 0 ? earlier[earlier.length - 1] : sorted[0];
  const next = text.filter((mark) => (mark.file ?? 0) === (found.file ?? 0) && mark.line > found.line).sort((a, b) => a.line - b.line)[0];
  return { ...(found.file ? { file: found.file } : {}), line: found.line, until: next ? next.line - 1 : found.line + 20 };
}

export { findSourceWord as findWord } from './sourceSearch';

/** Where a source line lands in the PDF: its own mark, or the nearest marked line before it. */
export function placeOf(marks: Mark[], line: number, file = 0): Mark | null {
  marks = marks.filter((mark) => (mark.file ?? 0) === file);
  const placed = marks.filter((mark) => mark.kind === 'L' || mark.kind === 'B');
  const candidates = placed.filter((mark) => mark.line <= line).sort((a, b) => b.line - a.line);
  return candidates[0] ?? placed.sort((a, b) => a.line - b.line)[0] ?? null;
}

/** \section-level headings of main.tex, for the outline. */
export function headingsOf(body: string): { line: number; level: number; title: string }[] {
  const levels: Record<string, number> = { section: 0, subsection: 1, subsubsection: 2 };
  const found: { line: number; level: number; title: string }[] = [];
  body.split('\n').forEach((line, index) => {
    const match = /^\s*\\(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{(.*)\}/.exec(stripComments(line));
    if (match) found.push({ line: index + 1, level: levels[match[1]], title: match[2].replace(/\\[A-Za-z]+\s*/g, '').replace(/[{}$~]/g, ' ').replace(/\s+/g, ' ').trim() });
  });
  return found;
}
