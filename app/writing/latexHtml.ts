/**
 * A paper's LaTeX read as a web page: headings, paragraphs, lists, equations, figures and tables, and in the text
 * emphasis, math, citations and cross-references. Every character shown remembers the source it came from, so
 * typing on the page can change the source; what cannot be shown as a page is marked unsupported, and its block
 * shows its own compiled PDF instead. This is not TeX: lines break where the browser breaks them.
 */

export type Style = 'em' | 'bf' | 'tt' | 'sc' | 'sf' | 'ul' | 'sup' | 'sub';

/** Characters in a row with the same style; each one's source range. */
export interface TextRun {
  kind: 'text';
  text: string;
  starts: number[];
  ends: number[];
  styles: Style[];
}

export type Inline =
  | TextRun
  | { kind: 'math'; tex: string; display: boolean; from: number; to: number }
  | { kind: 'cite'; command: string; keys: string[]; pre?: string; post?: string; from: number; to: number }
  | { kind: 'ref'; command: string; labels: string[]; from: number; to: number }
  | { kind: 'link'; href: string; text: string; from: number; to: number }
  | { kind: 'footnote'; content: Inline[]; from: number; to: number }
  | { kind: 'break'; from: number; to: number }
  /** A command shown as the text it stands for, not editable here. */
  | { kind: 'raw'; text: string; from: number; to: number };

export interface Caption {
  content: Inline[];
  from: number;
  to: number;
}

export interface TableCell {
  content: Inline[];
  span: number;
  align?: 'l' | 'c' | 'r';
  from: number;
  to: number;
}

export interface TableRow {
  cells: TableCell[];
  /** Rules: booktabs' \toprule and \bottomrule are thick, the others thin. */
  above?: 'thick' | 'thin';
  below?: 'thick' | 'thin';
}

export interface Graphic {
  path: string;
  /** A share of the line (0–1), from width=…\linewidth, or a length in points. */
  width?: { share: number } | { points: number };
  from: number;
  to: number;
}

export type Element =
  | { kind: 'heading'; level: number; starred: boolean; title: Inline[]; from: number; to: number }
  | { kind: 'paragraph'; content: Inline[]; noindent: boolean; from: number; to: number }
  | { kind: 'list'; ordered: boolean; items: { children: Element[]; from: number; to: number }[]; from: number; to: number }
  | { kind: 'equation'; tex: string; numbered: boolean; labels: string[]; from: number; to: number }
  | { kind: 'figure'; wide: boolean; graphics: Graphic[]; caption?: Caption; captionFirst: boolean; labels: string[]; from: number; to: number }
  | { kind: 'table'; wide: boolean; rows: TableRow[]; caption?: Caption; captionFirst: boolean; labels: string[]; from: number; to: number }
  | { kind: 'environment'; name: string; title?: Inline[]; children: Element[]; labels: string[]; from: number; to: number }
  | { kind: 'appendix'; from: number; to: number }
  | { kind: 'unsupported'; name: string; from: number; to: number };

/** Labels set in running text (after a heading, say): where, for the numbering to give them to what came before. */
export interface LooseLabel {
  label: string;
  at: number;
}

export interface Parsed {
  elements: Element[];
  labels: LooseLabel[];
}

/** What the preamble defines: text macros (no arguments) and math macros, for KaTeX. */
export interface Definitions {
  text: Record<string, string>;
  math: Record<string, string>;
  /** \newtheorem names: environment → title ("Theorem"), and the counter it shares. */
  theorems: Record<string, { title: string; counter: string; numbered: boolean }>;
}

/* ------------------------------------------------------------------ reading LaTeX */

const isLetter = (char: string | undefined) => char !== undefined && /[A-Za-z@]/.test(char);

/** The index after the group opening at `open` ("{" or "["), or -1. */
function closing(src: string, open: number, to = src.length): number {
  const left = src[open];
  let depth = 0;
  for (let at = open; at < to; at += 1) {
    const char = src[at];
    if (char === '\\') {
      at += 1;
      continue;
    }
    if (char === '%') {
      const end = src.indexOf('\n', at);
      at = end < 0 ? to : end;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (left === '[' && char === ']' && depth === 0) return at + 1;
    if (left === '{' && char === '}' && depth === 0) return at + 1;
  }
  return -1;
}

const skipSpace = (src: string, at: number, to: number) => {
  while (at < to && /[ \t\n\r]/.test(src[at]) && !(src[at] === '\n' && /^\n[ \t]*\n/.test(src.slice(at, at + 40)))) at += 1;
  return at;
};

/** A {…} argument at `at` (spaces before it allowed): its inside and where it ends. */
function argument(src: string, at: number, to: number): { from: number; to: number; end: number } | null {
  const start = skipSpace(src, at, to);
  if (src[start] !== '{') return null;
  const end = closing(src, start, to);
  return end < 0 ? null : { from: start + 1, to: end - 1, end };
}

/** An optional […] argument at `at`. */
function optional(src: string, at: number, to: number): { from: number; to: number; end: number } | null {
  const start = skipSpace(src, at, to);
  if (src[start] !== '[') return null;
  const end = closing(src, start, to);
  return end < 0 ? null : { from: start + 1, to: end - 1, end };
}

/** The \end{name} that closes the \begin{name} whose content starts at `from`: its start and its end. */
function environmentEnd(src: string, name: string, from: number, to: number): { start: number; end: number } | null {
  const pattern = /\\(begin|end)\s*\{([^}]*)\}/g;
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(src); match && match.index < to; match = pattern.exec(src)) {
    if (src[match.index - 1] === '\\') continue;
    if (match[2].trim() !== name) continue;
    depth += match[1] === 'begin' ? 1 : -1;
    if (depth === 0) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

/** Text a command stands for, read plainly: braces and commands dropped. */
export const plainText = (tex: string): string =>
  tex
    .replace(/\\[A-Za-z@]+\*?\s*/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const SYMBOLS: Record<string, string> = {
  ldots: '…', dots: '…', textellipsis: '…', textendash: '–', textemdash: '—', textquoteleft: '‘', textquoteright: '’',
  textquotedblleft: '“', textquotedblright: '”', S: '§', P: '¶', copyright: '©', textcopyright: '©', textregistered: '®',
  texttrademark: '™', dag: '†', ddag: '‡', textdagger: '†', textdaggerdbl: '‡', textbullet: '•', textasciitilde: '~',
  textbackslash: '\\', textbar: '|', textless: '<', textgreater: '>', ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø',
  O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', textdegree: '°', pounds: '£', euro: '€', textasciicircum: '^',
  textunderscore: '_', LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', checkmark: '✓', textsection: '§', quad: ' ',
  qquad: '  ', enspace: ' ', thinspace: ' ', textpm: '±', texttimes: '×',
};
// Commands that print nothing here.
const SILENT = new Set([
  'noindent', 'indent', 'centering', 'raggedright', 'raggedleft', 'small', 'footnotesize', 'scriptsize', 'tiny', 'large',
  'Large', 'LARGE', 'huge', 'Huge', 'normalsize', 'xspace', 'protect', 'relax', 'hfill', 'vfill', 'par', 'medskip',
  'smallskip', 'bigskip', 'clearpage', 'newpage', 'pagebreak', 'nopagebreak', 'allowbreak', 'maketitle', 'null', 'unskip',
  'ignorespaces', 'leavevmode', 'sloppy', 'fussy', 'strut', 'nobreak', 'frenchspacing', 'selectfont', 'normalfont',
  'upshape', 'mdseries', 'rmfamily', 'tableofcontents', 'FloatBarrier',
]);
// Commands whose arguments print nothing.
const SILENT_ARGS: Record<string, number> = { vspace: 1, hspace: 1, color: 1, label: 1, setlength: 2, addtolength: 2, addvspace: 1, phantom: 1, hphantom: 1, vphantom: 1, rule: 2, index: 1, bibliographystyle: 1, nocite: 1, thispagestyle: 1, pagestyle: 1, enlargethispage: 1, linespread: 1, fontsize: 2, newcounter: 1, setcounter: 2, addtocounter: 2, stepcounter: 1 };
const STYLE_OF: Record<string, Style | null> = {
  emph: 'em', textit: 'em', textsl: 'em', textbf: 'bf', texttt: 'tt', textsc: 'sc', textsf: 'sf', underline: 'ul', uline: 'ul',
  textsuperscript: 'sup', textsubscript: 'sub', textrm: null, textnormal: null, textup: null, textmd: null, mbox: null,
  hbox: null, text: null, makebox: null, fbox: null, hl: null, textcolor: null, colorbox: null, highlight: null,
};
const SWITCH_OF: Record<string, Style> = { bfseries: 'bf', itshape: 'em', em: 'em', slshape: 'em', ttfamily: 'tt', scshape: 'sc', sffamily: 'sf', bf: 'bf', it: 'em', tt: 'tt', sc: 'sc' };
const CITES = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar', 'parencite', 'textcite', 'autocite', 'Cite', 'Citep', 'Citet', 'citenum']);
const REFS = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref', 'vref', 'Autoref', 'cpageref', 'subref']);
const ACCENTS: Record<string, string> = { "'": '́', '`': '̀', '"': '̈', '^': '̂', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', b: '̱', d: '̣' };
const ESCAPED = new Set(['%', '&', '$', '#', '_', '{', '}', ' ', ',', ';', ':', '!', '@', '/', '-', '>', '<']);

export interface Context {
  definitions: Definitions;
  labels: LooseLabel[];
}

/** Running text from `from` to `to`, as styled runs and atoms. */
export function parseInline(src: string, from: number, to: number, context: Context, inherited: Style[] = []): Inline[] {
  const out: Inline[] = [];
  let styles = [...inherited];
  const key = (list: Style[]) => [...new Set(list)].sort().join();
  const push = (char: string, start: number, end: number) => {
    const last = out[out.length - 1];
    if (last?.kind === 'text' && key(last.styles) === key(styles)) {
      last.text += char;
      last.starts.push(start);
      last.ends.push(end);
    } else out.push({ kind: 'text', text: char, starts: [start], ends: [end], styles: [...new Set(styles)] });
  };
  const nested = (inner: { from: number; to: number }, extra: Style | null) => {
    for (const item of parseInline(src, inner.from, inner.to, context, extra ? [...styles, extra] : styles)) {
      const last = out[out.length - 1];
      if (item.kind === 'text' && last?.kind === 'text' && key(last.styles) === key(item.styles)) {
        last.text += item.text;
        last.starts.push(...item.starts);
        last.ends.push(...item.ends);
      } else out.push(item);
    }
  };
  let at = from;
  while (at < to) {
    const char = src[at];
    if (char === '%') {
      // A comment eats the end of its line and the next line's leading spaces.
      let end = src.indexOf('\n', at);
      end = end < 0 || end > to ? to : end + 1;
      while (end < to && /[ \t]/.test(src[end])) end += 1;
      at = end;
      continue;
    }
    if (/[ \t\n\r]/.test(char)) {
      let end = at;
      while (end < to && /[ \t\n\r]/.test(src[end])) end += 1;
      push(' ', at, end);
      at = end;
      continue;
    }
    if (char === '~') {
      push(' ', at, at + 1);
      at += 1;
      continue;
    }
    if (char === '{') {
      const end = closing(src, at, to);
      if (end < 0) {
        at += 1;
        continue;
      }
      // A group keeps style switches (\bfseries) inside it.
      const saved = styles;
      nested({ from: at + 1, to: end - 1 }, null);
      styles = saved;
      at = end;
      continue;
    }
    if (char === '}') {
      at += 1;
      continue;
    }
    if (char === '$' || (char === '\\' && (src[at + 1] === '(' || src[at + 1] === '['))) {
      const display = src[at + 1] === '$' || src[at + 1] === '[';
      const open = char === '$' ? (display ? '$$' : '$') : src.slice(at, at + 2);
      const close = open === '$$' ? '$$' : open === '$' ? '$' : open === '\\(' ? '\\)' : '\\]';
      let end = at + open.length;
      while (end < to && !(src.startsWith(close, end) && src[end - 1] !== '\\')) end += 1;
      out.push({ kind: 'math', tex: src.slice(at + open.length, end), display, from: at, to: Math.min(to, end + close.length) });
      at = Math.min(to, end + close.length);
      continue;
    }
    if (char === '-' && src[at + 1] === '-') {
      const em = src[at + 2] === '-';
      push(em ? '—' : '–', at, at + (em ? 3 : 2));
      at += em ? 3 : 2;
      continue;
    }
    if (char === '`' || char === "'") {
      const double = src[at + 1] === char;
      push(char === '`' ? (double ? '“' : '‘') : double ? '”' : '’', at, at + (double ? 2 : 1));
      at += double ? 2 : 1;
      continue;
    }
    if (char !== '\\') {
      push(char, at, at + 1);
      at += 1;
      continue;
    }
    // A command.
    const next = src[at + 1];
    if (next === '\\') {
      let end = at + 2;
      if (src[end] === '*') end += 1;
      const option = optional(src, end, to);
      if (option && src[skipSpace(src, end, to)] === '[') end = option.end;
      out.push({ kind: 'break', from: at, to: end });
      at = end;
      continue;
    }
    if (next !== undefined && ACCENTS[next] !== undefined && (!isLetter(next) || !isLetter(src[at + 2]) || src[at + 2] === '{')) {
      // \'e, \'{e}, \c{c}: a letter with its accent.
      let end = at + 2;
      let base = '';
      if (src[end] === '{') {
        const close = closing(src, end, to);
        base = plainText(src.slice(end + 1, close - 1)).replace(/\\i/, 'ı');
        end = close;
      } else if (/\s/.test(src[end] ?? '') && isLetter(next)) {
        end = skipSpace(src, end, to);
        base = src[end] ?? '';
        end += 1;
      } else {
        base = src[end] === '\\' && src[end + 1] === 'i' ? 'ı' : src[end] ?? '';
        end += src[end] === '\\' ? 2 : 1;
      }
      push(`${base}${ACCENTS[next]}`.normalize('NFC'), at, end);
      at = end;
      continue;
    }
    if (next !== undefined && !isLetter(next)) {
      if (ESCAPED.has(next)) {
        const shown = next === ',' || next === ';' || next === ':' ? ' ' : next === ' ' ? ' ' : next === '-' || next === '/' || next === '@' || next === '!' ? '' : next;
        if (shown) push(shown, at, at + 2);
        at += 2;
        continue;
      }
      push(next, at, at + 2);
      at += 2;
      continue;
    }
    let end = at + 1;
    while (isLetter(src[end])) end += 1;
    const name = src.slice(at + 1, end);
    if (src[end] === '*') end += 1;
    // A control word eats the spaces after it.
    const after = (position: number) => {
      let spaced = position;
      while (spaced < to && /[ \t]/.test(src[spaced])) spaced += 1;
      if (src[spaced] === '\n' && !/^\n[ \t]*\n/.test(src.slice(spaced, spaced + 40))) {
        spaced += 1;
        while (spaced < to && /[ \t]/.test(src[spaced])) spaced += 1;
      }
      return spaced;
    };
    if (SYMBOLS[name] !== undefined) {
      const text = SYMBOLS[name];
      const stop = src[end] === '{' && src[end + 1] === '}' ? end + 2 : after(end);
      // Each character of the word stands for the whole command: deleting one deletes it.
      for (const piece of text) push(piece, at, stop);
      at = stop;
      continue;
    }
    if (SWITCH_OF[name]) {
      styles = [...styles, SWITCH_OF[name]];
      at = after(end);
      continue;
    }
    if (SILENT.has(name)) {
      at = after(end);
      continue;
    }
    if (SILENT_ARGS[name] !== undefined) {
      let stop = end;
      const option = optional(src, stop, to);
      if (option) stop = option.end;
      for (let n = 0; n < SILENT_ARGS[name]; n += 1) {
        const arg = argument(src, stop, to);
        if (!arg) break;
        if (name === 'label') context.labels.push({ label: src.slice(arg.from, arg.to).trim(), at });
        stop = arg.end;
      }
      at = name === 'label' ? after(stop) : stop;
      continue;
    }
    if (name in STYLE_OF) {
      let stop = end;
      // \textcolor{red}{…} and \colorbox{…}{…}: the colour is not shown.
      if (name === 'textcolor' || name === 'colorbox') stop = argument(src, stop, to)?.end ?? stop;
      if (name === 'makebox') stop = optional(src, stop, to)?.end ?? stop;
      const arg = argument(src, stop, to);
      if (!arg) {
        at = stop;
        continue;
      }
      nested(arg, STYLE_OF[name]);
      at = arg.end;
      continue;
    }
    if (CITES.has(name)) {
      let stop = end;
      const first = optional(src, stop, to);
      if (first) stop = first.end;
      const second = first ? optional(src, stop, to) : null;
      if (second) stop = second.end;
      const arg = argument(src, stop, to);
      if (arg) {
        const keys = src.slice(arg.from, arg.to).split(',').map((item) => item.trim()).filter(Boolean);
        const notes = second ? { pre: src.slice(first!.from, first!.to), post: src.slice(second.from, second.to) } : first ? { post: src.slice(first.from, first.to) } : {};
        out.push({ kind: 'cite', command: name, keys, ...notes, from: at, to: arg.end });
        at = arg.end;
        continue;
      }
    }
    if (REFS.has(name)) {
      const arg = argument(src, end, to);
      if (arg) {
        out.push({ kind: 'ref', command: name, labels: src.slice(arg.from, arg.to).split(',').map((item) => item.trim()), from: at, to: arg.end });
        at = arg.end;
        continue;
      }
    }
    if (name === 'url' || name === 'nolinkurl') {
      const arg = argument(src, end, to);
      if (arg) {
        const href = src.slice(arg.from, arg.to);
        out.push({ kind: 'link', href, text: href, from: at, to: arg.end });
        at = arg.end;
        continue;
      }
    }
    if (name === 'href') {
      const url = argument(src, end, to);
      const text = url ? argument(src, url.end, to) : null;
      if (url && text) {
        out.push({ kind: 'link', href: src.slice(url.from, url.to), text: plainText(src.slice(text.from, text.to)), from: at, to: text.end });
        at = text.end;
        continue;
      }
    }
    if (name === 'footnote' || name === 'footnotetext' || name === 'thanks') {
      const option = optional(src, end, to);
      const arg = argument(src, option ? option.end : end, to);
      if (arg) {
        out.push({ kind: 'footnote', content: parseInline(src, arg.from, arg.to, context), from: at, to: arg.end });
        at = arg.end;
        continue;
      }
    }
    if (name === 'newline' || name === 'linebreak') {
      out.push({ kind: 'break', from: at, to: end });
      at = after(end);
      continue;
    }
    // A macro of the preamble, or one this does not know: shown as what its arguments say.
    let stop = src[end] === '[' ? optional(src, end, to)?.end ?? end : end;
    const parts: string[] = [];
    for (let arg = argument(src, stop, to); arg && src[stop] === '{'; arg = argument(src, stop, to)) {
      parts.push(src.slice(arg.from, arg.to));
      stop = arg.end;
    }
    const defined = context.definitions.text[name];
    const text = defined !== undefined ? plainText(defined) : parts.length > 0 ? plainText(parts[parts.length - 1]) : '';
    out.push({ kind: 'raw', text, from: at, to: parts.length > 0 ? stop : after(stop) });
    at = parts.length > 0 ? stop : after(stop);
  }
  return out;
}

/** Drops the spaces a paragraph starts or ends with. */
function trimmed(items: Inline[]): Inline[] {
  const result = items.map((item) => (item.kind === 'text' ? { ...item, starts: [...item.starts], ends: [...item.ends] } : item));
  const first = result[0];
  if (first?.kind === 'text') {
    while (first.text.startsWith(' ')) {
      first.text = first.text.slice(1);
      first.starts.shift();
      first.ends.shift();
    }
  }
  const last = result[result.length - 1];
  if (last?.kind === 'text') {
    while (last.text.endsWith(' ')) {
      last.text = last.text.slice(0, -1);
      last.starts.pop();
      last.ends.pop();
    }
  }
  return result.filter((item) => item.kind !== 'text' || item.text.length > 0);
}

/* ------------------------------------------------------------------ blocks of text */

const HEADINGS: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const MATH_ENVIRONMENTS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'alignat', 'alignat*']);
const TEXT_ENVIRONMENTS = new Set(['abstract', 'quote', 'quotation', 'center', 'flushleft', 'flushright', 'proof', 'verse', 'minipage', 'small', 'footnotesize']);
const DEFAULT_THEOREMS = ['theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'example', 'claim', 'conjecture', 'assumption', 'observation', 'hypothesis', 'fact', 'note', 'problem'];
const LISTS = new Set(['itemize', 'enumerate', 'description']);
// Commands that end a paragraph where they start a line.
const BLOCK_COMMAND = /^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|appendix|\[|item\b|maketitle|bibliography|printbibliography)/;

const isBlank = (src: string, at: number, to: number) => /^\n[ \t]*\n/.test(src.slice(at, Math.min(to, at + 80)));

/** Where a paragraph starting at `from` ends: a blank line, or a block command at a line's start, at brace depth 0. */
function paragraphEnd(src: string, from: number, to: number): number {
  let depth = 0;
  for (let at = from; at < to; at += 1) {
    const char = src[at];
    if (char === '\\') {
      if (depth === 0 && at > from && BLOCK_COMMAND.test(src.slice(at, at + 20))) {
        // Display math (\[) and environments end the paragraph wherever they are; the rest only at a line's start.
        const lineStart = !src.slice(src.lastIndexOf('\n', at - 1) + 1, at).trim();
        const env = /^\\begin\s*\{([^}]*)\}/.exec(src.slice(at, at + 40));
        const inline = env && !BLOCK_ENVIRONMENT(env[1].trim());
        if (!inline && (lineStart || src[at + 1] === '[' || env)) return at;
      }
      at += 1;
      continue;
    }
    if (char === '%') {
      const end = src.indexOf('\n', at);
      at = end < 0 ? to : end - 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === '$' && src[at + 1] === '$' && depth === 0 && at > from) return at;
    else if (char === '\n' && depth === 0 && isBlank(src, at, to)) return at;
  }
  return to;
}

/** Environments that stand as blocks; others (tabular in text, small) are part of a paragraph. */
const BLOCK_ENVIRONMENT = (name: string) => !['tabular', 'small', 'footnotesize', 'scriptsize', 'tabular*', 'array', 'math'].includes(name);

const lengthPoints: Record<string, number> = { pt: 1, bp: 72.27 / 72, in: 72.27, cm: 72.27 / 2.54, mm: 72.27 / 25.4, em: 10, ex: 4.3, pc: 12 };

function graphicWidth(options: string): Graphic['width'] {
  const width = /(?:^|,)\s*width\s*=\s*([^,]+)/.exec(options)?.[1]?.trim();
  if (width) {
    const share = /^([\d.]*)\s*\\(?:linewidth|columnwidth|textwidth|hsize)$/.exec(width);
    if (share) return { share: share[1] ? Number(share[1]) : 1 };
    const length = /^([\d.]+)\s*(pt|bp|in|cm|mm|em|ex|pc)$/.exec(width);
    if (length) return { points: Number(length[1]) * lengthPoints[length[2]] };
  }
  const scale = /(?:^|,)\s*scale\s*=\s*([\d.]+)/.exec(options)?.[1];
  return scale ? { share: Math.min(1, Number(scale)) } : undefined;
}

/** The labels in a stretch of source, and the stretch without them (for math). */
function labelsIn(src: string, from: number, to: number): string[] {
  return [...src.slice(from, to).matchAll(/\\label\s*\{([^}]*)\}/g)].map((match) => match[1].trim());
}

function parseCaption(src: string, from: number, to: number, context: Context, labels: string[]): Caption | undefined {
  const match = /\\caption(?![A-Za-z])/.exec(src.slice(from, to));
  if (!match) return undefined;
  let at = from + match.index + '\\caption'.length;
  const option = optional(src, at, to);
  if (option) at = option.end;
  const arg = argument(src, at, to);
  if (!arg) return undefined;
  const inner: Context = { definitions: context.definitions, labels: [] };
  const content = trimmed(parseInline(src, arg.from, arg.to, inner));
  labels.push(...inner.labels.map((item) => item.label));
  return { content, from: arg.from, to: arg.to };
}

/** Splits at `&` or `\\` at brace depth 0 (not inside math). */
function splitTop(src: string, from: number, to: number, separator: '&' | '\\\\'): { from: number; to: number }[] {
  const parts: { from: number; to: number }[] = [];
  let depth = 0;
  let math = false;
  let start = from;
  for (let at = from; at < to; at += 1) {
    const char = src[at];
    if (char === '\\') {
      if (separator === '\\\\' && src[at + 1] === '\\' && depth === 0 && !math) {
        parts.push({ from: start, to: at });
        at += 2;
        // \\[2pt] after a row.
        const option = src[skipSpace(src, at, to)] === '[' ? optional(src, at, to) : null;
        if (option) at = option.end;
        start = at;
        at -= 1;
        continue;
      }
      at += 1;
      continue;
    }
    if (char === '%') {
      const end = src.indexOf('\n', at);
      at = end < 0 ? to : end;
      continue;
    }
    if (char === '$') math = !math;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (separator === '&' && char === '&' && depth === 0 && !math) {
      parts.push({ from: start, to: at });
      start = at + 1;
    }
  }
  parts.push({ from: start, to });
  return parts;
}

const RULE = /^\s*\\(toprule|midrule|bottomrule|hline|cmidrule|cline|specialrule|addlinespace|morecmidrules|hhline|rowcolor)\b\s*(\([^)]*\))?(\[[^\]]*\])?(\{[^}]*\})*\s*/;

function parseTabular(src: string, from: number, to: number, context: Context): { rows: TableRow[] } | null {
  const begin = /\\begin\s*\{(tabular\*?|tabularx|tabulary)\}/.exec(src.slice(from, to));
  if (!begin) return null;
  let at = from + begin.index + begin[0].length;
  const name = begin[1];
  if (name !== 'tabular') at = argument(src, at, to)?.end ?? at; // the width
  const option = optional(src, at, to);
  if (option) at = option.end;
  const spec = argument(src, at, to);
  if (!spec) return null;
  const end = environmentEnd(src, name, spec.end, to);
  if (!end) return null;
  const aligns = [...src.slice(spec.from, spec.to).replace(/[@>p<m]\{[^}]*\}|\{[^}]*\}|\*\{[^}]*\}/g, '').replace(/[^lcrXL CR]/g, '')].map((char) =>
    /[cC]/.test(char) ? 'c' : /[rR]/.test(char) ? 'r' : 'l',
  ) as ('l' | 'c' | 'r')[];
  const rows: TableRow[] = [];
  let pending: TableRow['above'];
  for (const part of splitTop(src, spec.end, end.start, '\\\\')) {
    let start = part.from;
    // Rules before the row's cells.
    for (let rule = RULE.exec(src.slice(start, part.to)); rule; rule = RULE.exec(src.slice(start, part.to))) {
      const kind = rule[1];
      if (kind === 'toprule' || kind === 'bottomrule') pending = 'thick';
      else if (kind !== 'addlinespace' && kind !== 'rowcolor') pending = pending ?? 'thin';
      start += rule[0].length;
    }
    if (!src.slice(start, part.to).replace(/%[^\n]*/g, '').trim()) {
      if (pending && rows.length > 0) rows[rows.length - 1].below = pending;
      else if (pending) continue;
      pending = undefined;
      continue;
    }
    const cells: TableCell[] = [];
    let column = 0;
    for (const cell of splitTop(src, start, part.to, '&')) {
      let span = 1;
      let align = aligns[column];
      let inner = cell;
      const multi = /^\s*\\multicolumn\s*\{(\d+)\}\s*\{([^}]*)\}\s*/.exec(src.slice(cell.from, cell.to));
      if (multi) {
        span = Number(multi[1]);
        align = /c/.test(multi[2]) ? 'c' : /r/.test(multi[2]) ? 'r' : 'l';
        const arg = argument(src, cell.from + multi[0].length, cell.to);
        if (arg) inner = arg;
      }
      const row = /^\s*\\multirow\s*(\[[^\]]*\])?\s*\{[^}]*\}\s*(\[[^\]]*\])?\s*\{[^}]*\}\s*/.exec(src.slice(inner.from, inner.to));
      if (row) {
        const arg = argument(src, inner.from + row[0].length, inner.to);
        if (arg) inner = arg;
      }
      const made = /^\s*\\makecell\s*(\[[^\]]*\])?\s*/.exec(src.slice(inner.from, inner.to));
      if (made) {
        const arg = argument(src, inner.from + made[0].length, inner.to);
        if (arg) inner = arg;
      }
      cells.push({ content: trimmed(parseInline(src, inner.from, inner.to, context)), span, align, from: inner.from, to: inner.to });
      column += span;
    }
    rows.push({ cells, ...(pending ? { above: pending } : {}) });
    pending = undefined;
  }
  return { rows };
}

/**
 * The elements of a stretch of a paper's source (a block, or the inside of an environment). `from` and `to` are
 * offsets in `src`, which may hold more (the whole article), so every position is the article's.
 */
export function parseBlocks(src: string, from: number, to: number, context: Context): Element[] {
  const elements: Element[] = [];
  let at = from;
  let noindent = false;
  while (at < to) {
    // Spaces and comments between elements.
    if (/\s/.test(src[at])) {
      at += 1;
      continue;
    }
    if (src[at] === '%') {
      const end = src.indexOf('\n', at);
      at = end < 0 || end > to ? to : end + 1;
      continue;
    }
    const rest = src.slice(at, Math.min(to, at + 60));
    const heading = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)/.exec(rest);
    if (heading) {
      let stop = at + heading[0].length;
      const option = optional(src, stop, to);
      if (option) stop = option.end;
      const arg = argument(src, stop, to);
      if (arg) {
        const level = HEADINGS[heading[1]];
        const title = trimmed(parseInline(src, arg.from, arg.to, context));
        elements.push({ kind: 'heading', level, starred: heading[2] === '*', title, from: at, to: arg.end });
        at = arg.end;
        continue;
      }
    }
    if (/^\\appendix\b/.test(rest)) {
      elements.push({ kind: 'appendix', from: at, to: at + 9 });
      at += 9;
      continue;
    }
    if (/^\\noindent\b/.test(rest)) {
      noindent = true;
      at += 9;
      continue;
    }
    const label = /^\\label\s*\{([^}]*)\}/.exec(rest);
    if (label) {
      context.labels.push({ label: label[1].trim(), at });
      at += label[0].length;
      continue;
    }
    const silent = /^\\(centering|medskip|smallskip|bigskip|clearpage|newpage|maketitle|vspace\*?\s*\{[^}]*\}|vfill|FloatBarrier|bibliographystyle\s*\{[^}]*\}|bibliography\s*\{[^}]*\}|printbibliography|tableofcontents)/.exec(rest);
    if (silent) {
      at += silent[0].length;
      continue;
    }
    const display = /^(\\\[|\$\$)/.exec(rest);
    if (display) {
      const close = display[1] === '$$' ? '$$' : '\\]';
      const end = src.indexOf(close, at + 2);
      const stop = end < 0 || end > to ? to : end;
      const tex = src.slice(at + 2, stop);
      elements.push({ kind: 'equation', tex: tex.replace(/\\label\s*\{[^}]*\}/g, ''), numbered: false, labels: labelsIn(src, at, stop), from: at, to: Math.min(to, stop + 2) });
      at = Math.min(to, stop + 2);
      continue;
    }
    const begin = /^\\begin\s*\{([^}]*)\}/.exec(rest);
    if (begin && BLOCK_ENVIRONMENT(begin[1].trim())) {
      const name = begin[1].trim();
      const inner = at + begin[0].length;
      const end = environmentEnd(src, name, inner, to);
      if (!end) {
        elements.push({ kind: 'unsupported', name, from: at, to });
        break;
      }
      elements.push(environment(src, name, at, inner, end, context));
      at = end.end;
      noindent = false;
      continue;
    }
    // Running text, up to the end of its paragraph.
    const end = paragraphEnd(src, at, to);
    const content = trimmed(parseInline(src, at, end, context));
    if (content.length > 0) elements.push({ kind: 'paragraph', content, noindent, from: at, to: end });
    noindent = false;
    at = Math.max(end, at + 1);
  }
  return elements;
}

function environment(src: string, name: string, from: number, inner: number, end: { start: number; end: number }, context: Context): Element {
  const base = name.replace(/\*$/, '');
  if (MATH_ENVIRONMENTS.has(name)) {
    const body = src.slice(inner, end.start);
    const numbered = !name.endsWith('*') && name !== 'displaymath' && !/\\nonumber|\\notag/.test(body);
    let tex = body.replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
    if (base === 'align' || base === 'flalign' || base === 'eqnarray') tex = `\\begin{aligned}${tex}\\end{aligned}`;
    else if (base === 'alignat') tex = `\\begin{aligned}${tex.replace(/^\s*\{\d+\}/, '')}\\end{aligned}`;
    else if (base === 'gather') tex = `\\begin{gathered}${tex}\\end{gathered}`;
    else if (base === 'multline') tex = `\\begin{gathered}${tex}\\end{gathered}`;
    return { kind: 'equation', tex, numbered, labels: labelsIn(src, inner, end.start), from, to: end.end };
  }
  if (base === 'figure' || base === 'wrapfigure' || base === 'SCfigure') {
    if (/\\begin\s*\{(subfigure|tikzpicture|picture|pgfpicture|algorithmic)\}|\\subfloat|\\input\b/.test(src.slice(inner, end.start))) return { kind: 'unsupported', name, from, to: end.end };
    const labels: string[] = [];
    const caption = parseCaption(src, inner, end.start, context, labels);
    const graphics: Graphic[] = [];
    for (const match of src.slice(inner, end.start).matchAll(/\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      const start = inner + (match.index ?? 0);
      graphics.push({ path: match[2].trim(), width: graphicWidth(match[1]?.slice(1, -1) ?? ''), from: start, to: start + match[0].length });
    }
    labels.push(...labelsIn(src, inner, end.start).filter((item) => !labels.includes(item)));
    const captionAt = caption ? caption.from : end.start;
    return { kind: 'figure', wide: name.endsWith('*'), graphics, caption, captionFirst: graphics.length > 0 && captionAt < graphics[0].from, labels, from, to: end.end };
  }
  if (base === 'table') {
    const labels: string[] = [];
    const caption = parseCaption(src, inner, end.start, context, labels);
    const tabular = parseTabular(src, inner, end.start, context);
    if (!tabular) return { kind: 'unsupported', name, from, to: end.end };
    labels.push(...labelsIn(src, inner, end.start).filter((item) => !labels.includes(item)));
    const tabularAt = /\\begin\s*\{tabular/.exec(src.slice(inner, end.start))?.index ?? 0;
    return { kind: 'table', wide: name.endsWith('*'), rows: tabular.rows, caption, captionFirst: caption !== undefined && caption.from < inner + tabularAt, labels, from, to: end.end };
  }
  if (LISTS.has(name)) {
    const items: { children: Element[]; from: number; to: number }[] = [];
    const starts: number[] = [];
    const pattern = /\\item\b(\s*\[[^\]]*\])?/g;
    let depth = 0;
    for (let at = inner; at < end.start; at += 1) {
      if (src.startsWith('\\begin', at)) depth += 1;
      else if (src.startsWith('\\end', at)) depth -= 1;
      else if (depth === 0 && src.startsWith('\\item', at) && !isLetter(src[at + 5])) starts.push(at);
    }
    starts.forEach((start, index) => {
      pattern.lastIndex = start;
      const match = pattern.exec(src);
      const contentFrom = start + (match?.[0].length ?? 5);
      const contentTo = starts[index + 1] ?? end.start;
      items.push({ children: parseBlocks(src, contentFrom, contentTo, context), from: start, to: contentTo });
    });
    return { kind: 'list', ordered: name === 'enumerate', items, from, to: end.end };
  }
  const theorem = context.definitions.theorems[base] ?? (DEFAULT_THEOREMS.includes(base) ? { title: base[0].toUpperCase() + base.slice(1), counter: base, numbered: !name.endsWith('*') } : undefined);
  if (theorem || TEXT_ENVIRONMENTS.has(base)) {
    let contentFrom = inner;
    let title: Inline[] | undefined;
    const option = theorem || base === 'proof' ? optional(src, inner, end.start) : null;
    if (option && src[skipSpace(src, inner, end.start)] === '[') {
      title = trimmed(parseInline(src, option.from, option.to, context));
      contentFrom = option.end;
    }
    if (base === 'minipage') contentFrom = argument(src, optional(src, inner, end.start)?.end ?? inner, end.start)?.end ?? inner;
    return { kind: 'environment', name: base, title, children: parseBlocks(src, contentFrom, end.start, context), labels: labelsIn(src, inner, end.start), from, to: end.end };
  }
  return { kind: 'unsupported', name, from, to: end.end };
}

/** Whether anything in a list of elements cannot be shown as a page. */
export function hasUnsupported(elements: Element[]): boolean {
  return elements.some(
    (element) =>
      element.kind === 'unsupported' ||
      (element.kind === 'environment' && hasUnsupported(element.children)) ||
      (element.kind === 'list' && element.items.some((item) => hasUnsupported(item.children))),
  );
}

/* ------------------------------------------------------------------ the preamble */

/** Text macros, math macros and theorem environments the preamble defines. */
export function readDefinitions(preamble: string): Definitions {
  const definitions: Definitions = { text: {}, math: {}, theorems: {} };
  const src = preamble.replace(/(^|[^\\])%[^\n]*/g, '$1');
  const pattern = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?\s*(?:\[[^\]]*\])?\s*\{/g;
  for (const match of src.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const end = closing(src, open);
    if (end < 0) continue;
    const body = src.slice(open + 1, end - 1);
    definitions.math[`\\${match[1]}`] = body;
    if (!match[2]) definitions.text[match[1]] = body;
  }
  for (const match of src.matchAll(/\\def\s*\\([A-Za-z@]+)\s*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const end = closing(src, open);
    if (end < 0) continue;
    definitions.math[`\\${match[1]}`] = src.slice(open + 1, end - 1);
    definitions.text[match[1]] = src.slice(open + 1, end - 1);
  }
  for (const match of src.matchAll(/\\DeclareMathOperator(\*?)\s*\{\s*\\([A-Za-z]+)\s*\}\s*\{([^}]*)\}/g)) {
    definitions.math[`\\${match[2]}`] = match[1] ? `\\operatorname*{${match[3]}}` : `\\operatorname{${match[3]}}`;
  }
  for (const match of src.matchAll(/\\newtheorem(\*?)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g)) {
    const name = match[2].trim();
    definitions.theorems[name] = { title: match[4].trim(), counter: match[3]?.trim() || name, numbered: !match[1] };
  }
  return definitions;
}
