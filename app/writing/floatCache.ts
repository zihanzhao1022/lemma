/**
 * Tables set once and reused while the paper is typed. Typesetting a large table (colortbl, \resizebox) costs
 * far more than a page of text, and a paper's tables rarely change while its text is being written. Each table
 * float's tabulars ("units") are typeset in a document of their own, in the float's own setting, each shipped as
 * a page exactly its size, with its width, height and depth written down; the article then sets that page in a box
 * of the same size in place of the unit (\lemmacached), so nothing on the page moves. Every other line of the
 * float (\centering, \small, the caption, the label) stays in the article. A table whose code changes is set
 * as code again until it is cached anew, when typing pauses.
 *
 * The units are replaced line for line (the lines a unit took become comment lines before its box), so main.tex
 * keeps its line numbers and the position marks keep their meaning.
 */
import { hashText } from '../../editor/results/numbering';
import type { TexEngine } from '../../editor/tex/engine';
import { documentHead } from './document';

interface Span {
  from: number;
  to: number;
}

export interface CacheableFloat {
  /** table* spans the text width, table the column. */
  wide: boolean;
  /** Inside the float, after \begin{table}[…], up to \end{table}. */
  inner: Span;
  /** The tabulars (or the \resizebox, \scalebox or adjustbox around them) set as boxes, in order. */
  units: Span[];
}

interface Entry {
  file: string;
  pdf: Uint8Array;
  /** Width, height and depth of each unit, as TeX writes them (exact to the scaled point). */
  dims: [string, string, string][];
}

const UNIT_COMMANDS: Record<string, number> = { resizebox: 3, 'resizebox*': 3, scalebox: 2, adjustbox: 2 };
const UNIT_ENVIRONMENTS = new Set(['tabular', 'tabular*', 'tabularx', 'tabulary', 'adjustbox']);
// What a cached unit must not hold: labels and notes go to the aux file, and the page keeps no links of its own.
const UNSAFE = /\\(label|caption|footnote|tablefootnote|footnotemark|footnotetext|verb|includegraphics|index|input|include|galley)(?![A-Za-z@])/;
const REFERENCES = /\\(ref|eqref|autoref|cref|Cref|pageref|nameref|cite[a-zA-Z]*|Cite[a-zA-Z]*)(?![A-Za-z@])/;

/** The index after the {…} or […] group at `at` (spaces before it skipped), or -1. */
function group(src: string, at: number, to: number, open: '{' | '['): number {
  let start = at;
  while (start < to && /\s/.test(src[start])) start += 1;
  if (src[start] !== open) return -1;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < to; i += 1) {
    const char = src[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '%') {
      const end = src.indexOf('\n', i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (open === '{' && depth === 0) return i + 1;
    }
    if (open === '[' && char === close && depth === 0) return i + 1;
  }
  return -1;
}

/** Where the \end{name} closing the environment whose content starts at `from` ends, or -1. */
function environmentEnd(src: string, name: string, from: number, to: number): { start: number; end: number } | null {
  const pattern = /\\(begin|end)\s*\{([^}]*)\}/g;
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(src); match && match.index < to; match = pattern.exec(src)) {
    if (match[2].trim() !== name) continue;
    if (commentedOut(src, match.index)) continue;
    depth += match[1] === 'begin' ? 1 : -1;
    if (depth === 0) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

/** Whether `at` is in a comment. */
function commentedOut(src: string, at: number): boolean {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1;
  for (let i = lineStart; i < at; i += 1) {
    if (src[i] === '\\') i += 1;
    else if (src[i] === '%') return true;
  }
  return false;
}

/** The units of a float's inside: the outermost tabulars and the boxes scaling them. */
function unitsIn(src: string, inner: Span): Span[] | null {
  const units: Span[] = [];
  for (let at = inner.from; at < inner.to; ) {
    const char = src[at];
    if (char === '%') {
      const end = src.indexOf('\n', at);
      at = end < 0 ? inner.to : end + 1;
      continue;
    }
    if (char !== '\\') {
      at += 1;
      continue;
    }
    const command = /^\\([A-Za-z@]+\*?)/.exec(src.slice(at, at + 40));
    if (!command) {
      at += 2;
      continue;
    }
    const name = command[1];
    if (UNIT_COMMANDS[name] !== undefined) {
      let end = at + command[0].length;
      for (let n = 0; n < UNIT_COMMANDS[name] && end > 0; n += 1) {
        // \scalebox{2}[1]{…}: an optional argument between.
        const optional = group(src, end, inner.to, '[');
        if (optional > 0) end = optional;
        end = group(src, end, inner.to, '{');
      }
      if (end < 0) return null;
      units.push({ from: at, to: end });
      at = end;
      continue;
    }
    if (name === 'begin') {
      const env = /^\\begin\s*\{([^}]*)\}/.exec(src.slice(at, at + 60));
      const envName = env?.[1].trim() ?? '';
      if (env && UNIT_ENVIRONMENTS.has(envName)) {
        const close = environmentEnd(src, envName, at + env[0].length, inner.to);
        if (!close) return null;
        units.push({ from: at, to: close.end });
        at = close.end;
        continue;
      }
    }
    at += command[0].length;
  }
  return units;
}

/** The table floats of main.tex's body that can be cached, in order. */
export function cacheableFloats(body: string): CacheableFloat[] {
  const floats: CacheableFloat[] = [];
  const pattern = /\\begin\s*\{(table\*?)\}/g;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    if (commentedOut(body, match.index)) continue;
    const name = match[1];
    let from = match.index + match[0].length;
    const option = group(body, from, body.length, '[');
    if (option > 0) from = option;
    const close = environmentEnd(body, name, from, body.length);
    if (!close) continue;
    pattern.lastIndex = close.end;
    const inner = { from, to: close.start };
    const units = unitsIn(body, inner);
    if (!units || units.length === 0) continue;
    if (units.some((unit) => UNSAFE.test(body.slice(unit.from, unit.to)))) continue;
    if (/\\includegraphics(?![A-Za-z@])/.test(body.slice(inner.from, inner.to))) continue;
    floats.push({ wide: name.endsWith('*'), inner, units });
  }
  return floats;
}

/* ------------------------------------------------------------------ the cache */

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 300;

const labelsAndCitations = (aux: string | undefined) =>
  (aux ?? '')
    .split('\n')
    .filter((line) => /^\\(newlabel|bibcite)\{/.test(line))
    .join('\n');

/** What a float's boxes depend on: the preamble, its width and code, and the labels and citations it uses. */
function keyOf(body: string, float: CacheableFloat, preambleHash: string, aux: string | undefined): string {
  const inner = body.slice(float.inner.from, float.inner.to);
  const refs = float.units.some((unit) => REFERENCES.test(body.slice(unit.from, unit.to))) ? labelsAndCitations(aux) : '';
  return hashText(JSON.stringify([preambleHash, float.wide, inner, refs]));
}

/** The line breaks in `text`, as comment lines, so a replacement keeps the line count. */
const keptLines = (text: string) => '%\n'.repeat((text.match(/\n/g) ?? []).length);

/**
 * main.tex's body with every cached table set from its boxes, the PDFs that holds them, and the floats not cached
 * yet (or whose code changed).
 */
export function withCachedFloats(
  body: string,
  preamble: string,
  aux: string | undefined,
): { body: string; files: Record<string, Uint8Array>; missing: number } {
  const preambleHash = hashText(preamble);
  const files: Record<string, Uint8Array> = {};
  const replacements: { from: number; to: number; text: string }[] = [];
  let missing = 0;
  for (const float of cacheableFloats(body)) {
    const entry = entries.get(keyOf(body, float, preambleHash, aux));
    if (!entry || entry.dims.length !== float.units.length) {
      missing += 1;
      continue;
    }
    files[entry.file] = entry.pdf;
    float.units.forEach((unit, index) => {
      const [width, height, depth] = entry.dims[index];
      const text = `${keptLines(body.slice(unit.from, unit.to))}\\lemmacached{${entry.file}}{${index + 1}}{${width}}{${height}}{${depth}}`;
      replacements.push({ from: unit.from, to: unit.to, text });
    });
  }
  let out = body;
  for (const { from, to, text } of replacements.sort((a, b) => b.from - a.from)) out = out.slice(0, from) + text + out.slice(to);
  return { body: out, files, missing };
}

// Sets each unit in the float's own setting (LaTeX's float box: its width, \@parboxrestore, \@floatboxreset),
// ships it as a page exactly its size, and writes its size.
const CAPTURE = String.raw`\makeatletter
\newbox\lemma@unit
\newbox\lemma@float
\newwrite\lemma@dims
\immediate\openout\lemma@dims=lemma.dims
\def\lemma@ship{\ifdefined\RawShipout\expandafter\RawShipout\else\expandafter\shipout\fi}
\long\def\lemmacapture#1{\setbox\lemma@unit\hbox{#1}%
\immediate\write\lemma@dims{\the\wd\lemma@unit\space\the\ht\lemma@unit\space\the\dp\lemma@unit}%
\begingroup\pdfpagewidth\wd\lemma@unit\pdfpageheight\dimexpr\ht\lemma@unit+\dp\lemma@unit\relax
\pdfhorigin\z@\pdfvorigin\z@\hoffset\z@\voffset\z@\lemma@ship\copy\lemma@unit\endgroup
\leavevmode\hbox to\wd\lemma@unit{\vrule width\z@ height\ht\lemma@unit depth\dp\lemma@unit\hss}}
\long\def\lemmafloat#1#2{\setbox\lemma@float\vbox{\hsize#1\@parboxrestore\@floatboxreset#2}}
\makeatother`;

/** The float's inside with its caption and label taken out and each unit captured. */
export function captureSource(body: string, float: CacheableFloat): string {
  let out = '';
  let at = float.inner.from;
  for (const unit of float.units) {
    out += withoutCaptions(body.slice(at, unit.from));
    out += `\\lemmacapture{${body.slice(unit.from, unit.to)}}`;
    at = unit.to;
  }
  return out + withoutCaptions(body.slice(at, float.inner.to));
}

/** Text without \caption[…]{…} and \label{…}, which only make sense in the article. */
function withoutCaptions(text: string): string {
  let out = text;
  for (;;) {
    const match = /\\(caption|label)\s*(?=[[{])/.exec(out);
    if (!match) return out;
    let end = match.index + match[0].length;
    const optional = group(out, end, out.length, '[');
    if (optional > 0) end = optional;
    const arg = group(out, end, out.length, '{');
    if (arg < 0) return out.slice(0, match.index);
    out = out.slice(0, match.index) + out.slice(arg);
  }
}

/** Typesets one float's units and keeps them; false when it could not. */
async function cacheFloat(engine: TexEngine, body: string, float: CacheableFloat, preamble: string, files: Record<string, string | Uint8Array>, aux: string | undefined): Promise<boolean> {
  const key = keyOf(body, float, hashText(preamble), aux);
  if (entries.has(key)) return true;
  const { head, own } = documentHead(preamble);
  const width = float.wide ? '\\textwidth' : '\\columnwidth';
  const main = [...head, own, CAPTURE, '\\begin{document}', `\\lemmafloat{${width}}{${captureSource(body, float)}}`, '\\end{document}', ''].join('\n');
  const out = await engine.compile({ main, files: { ...files, ...(aux ? { 'main.aux': aux } : {}) }, read: ['lemma.dims'] });
  const dims = (out.written?.['lemma.dims'] ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/) as [string, string, string]);
  if (!out.pdf || dims.length !== float.units.length || dims.some((dim) => dim.length !== 3 || dim.some((value) => !/^-?[\d.]+pt$/.test(value)))) return false;
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  entries.set(key, { file: `lemma-float-${key.slice(0, 10)}.pdf`, pdf: out.pdf, dims });
  return true;
}

/* ------------------------------------------------------------------ filling it while typing pauses */

const IDLE_MS = 700;
let timer: ReturnType<typeof setTimeout> | undefined;
let latest: { engine: TexEngine; body: string; preamble: string; files: Record<string, string | Uint8Array>; aux: string | undefined } | null = null;
/** Keys tried and failed, not tried again. */
const failed = new Set<string>();

/**
 * Caches the tables of the article as last compiled, one at a time while nothing else is compiled: each call (one
 * per compile of the article) puts the work off until typing has paused.
 */
export function fillFloatCache(engine: TexEngine, body: string, preamble: string, files: Record<string, string | Uint8Array>, aux: string | undefined): void {
  latest = { engine, body, preamble, files, aux };
  clearTimeout(timer);
  timer = setTimeout(step, IDLE_MS);
}

async function step(): Promise<void> {
  const work = latest;
  if (!work) return;
  const preambleHash = hashText(work.preamble);
  const next = cacheableFloats(work.body).find((float) => {
    const key = keyOf(work.body, float, preambleHash, work.aux);
    return !entries.has(key) && !failed.has(key);
  });
  if (!next) return;
  const key = keyOf(work.body, next, preambleHash, work.aux);
  const ok = await cacheFloat(work.engine, work.body, next, work.preamble, work.files, work.aux).catch(() => false);
  if (!ok) failed.add(key);
  // Typing in the meantime called fillFloatCache again, which waits for its own pause.
  if (latest === work) timer = setTimeout(step, 0);
}
