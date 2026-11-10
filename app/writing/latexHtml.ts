/**
 * A paper's LaTeX read as a web page: headings, paragraphs, lists, equations, figures and tables, and in the text
 * emphasis, math, citations and cross-references. Every character shown remembers the source it came from, so
 * typing on the page can change the source; what cannot be shown as a page is marked unsupported, and its block
 * shows its own compiled PDF instead. This is not TeX: lines break where the browser breaks them.
 */

export type Style = 'em' | 'bf' | 'tt' | 'sc' | 'sf' | 'ul' | 'sup' | 'sub';

/** The colour the source set (a CSS colour) and the size (a share of the paper's normal size). */
export interface Look {
  color?: string;
  size?: number;
}

/** Characters in a row with the same style; each one's source range. */
export interface TextRun {
  kind: 'text';
  text: string;
  starts: number[];
  ends: number[];
  styles: Style[];
  look?: Look;
}

export type Inline =
  | TextRun
  | { kind: 'math'; tex: string; display: boolean; look?: Look; from: number; to: number }
  | { kind: 'cite'; command: string; keys: string[]; pre?: string; post?: string; from: number; to: number }
  | { kind: 'ref'; command: string; labels: string[]; from: number; to: number }
  | { kind: 'link'; href: string; text: string; from: number; to: number }
  | { kind: 'footnote'; content: Inline[]; from: number; to: number }
  | { kind: 'break'; from: number; to: number }
  /** A box \rule draws: its CSS width and height, how far it is raised, its colour. */
  | { kind: 'rule'; width: string; height: string; raise?: string; color?: string; from: number; to: number }
  /** A command shown as the text it stands for (and, read further, as `content`), not editable here. */
  | { kind: 'raw'; text: string; content?: Inline[]; from: number; to: number };

export interface Caption {
  content: Inline[];
  from: number;
  to: number;
}

export interface TableCell {
  content: Inline[];
  span: number;
  /** A paragraph column (p, m, b, X): its text wraps; the others keep to one line. */
  wrap?: boolean;
  /** \cellcolor, as a CSS colour. */
  background?: string;
  align?: 'l' | 'c' | 'r';
  from: number;
  to: number;
}

export interface TableRow {
  cells: TableCell[];
  /** \rowcolor, as a CSS colour. */
  background?: string;
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
  /** `fit`: set in \resizebox to the line's width ('scale'), or only shrunk to it (adjustbox's max width). */
  | { kind: 'table'; wide: boolean; rows: TableRow[]; fit?: 'scale' | 'shrink'; size?: number; caption?: Caption; captionFirst: boolean; labels: string[]; from: number; to: number }
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
  /** Every macro defined, with its number of arguments and the default of an optional first one. */
  macros?: Record<string, { args: number; optional?: string; body: string }>;
  /** \definecolor and \colorlet colours, as RGB from 0 to 1. */
  colors?: Record<string, RGB>;
  /** The paper's normal font size in points (10, 11, 12). */
  size?: number;
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
    // Accents first (\"a, {\"a}, \'{e}), while the commands are still there.
    .replace(/\\(['"`^~=.uvHckrbd])\s*\{?\s*(\\?[A-Za-z])\s*\}?/g, (match, accent: string, letter: string) =>
      /[A-Za-z]/.test(accent) && letter.startsWith('\\') ? match : `${letter.replace(/^\\i$/, 'ı').replace(/^\\/, '')}${ACCENTS[accent] ?? ''}`.normalize('NFC'),
    )
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
  qquad: '  ', and: '  ', AND: '  ', enspace: ' ', thinspace: ' ', textpm: '±', texttimes: '×',
};
// Commands that print nothing here.
const SILENT = new Set([
  'noindent', 'indent', 'centering', 'raggedright', 'raggedleft', 'xspace', 'protect', 'relax', 'hfill', 'vfill', 'par', 'medskip',
  'smallskip', 'bigskip', 'clearpage', 'newpage', 'pagebreak', 'nopagebreak', 'allowbreak', 'maketitle', 'null', 'unskip',
  'ignorespaces', 'leavevmode', 'sloppy', 'fussy', 'strut', 'nobreak', 'frenchspacing', 'selectfont', 'normalfont',
  'upshape', 'mdseries', 'rmfamily', 'tableofcontents', 'FloatBarrier',
]);
// Commands whose arguments print nothing.
const SILENT_ARGS: Record<string, number> = { vspace: 1, hspace: 1, definecolor: 3, colorlet: 2, label: 1, setlength: 2, addtolength: 2, addvspace: 1, phantom: 1, hphantom: 1, vphantom: 1, index: 1, bibliographystyle: 1, nocite: 1, thispagestyle: 1, pagestyle: 1, enlargethispage: 1, linespread: 1, newcounter: 1, setcounter: 2, addtocounter: 2, stepcounter: 1 };
const STYLE_OF: Record<string, Style | null> = {
  emph: 'em', textit: 'em', textsl: 'em', textbf: 'bf', texttt: 'tt', textsc: 'sc', textsf: 'sf', underline: 'ul', uline: 'ul',
  textsuperscript: 'sup', textsubscript: 'sub', textrm: null, textnormal: null, textup: null, textmd: null, mbox: null,
  hbox: null, text: null, makebox: null, fbox: null, hl: null, highlight: null,
};
const SWITCH_OF: Record<string, Style> = { bfseries: 'bf', itshape: 'em', em: 'em', slshape: 'em', ttfamily: 'tt', scshape: 'sc', sffamily: 'sf', bf: 'bf', it: 'em', tt: 'tt', sc: 'sc' };
const CITES = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar', 'parencite', 'textcite', 'autocite', 'Cite', 'Citep', 'Citet', 'citenum']);
const REFS = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref', 'vref', 'Autoref', 'cpageref', 'subref']);
const ACCENTS: Record<string, string> = { "'": '́', '`': '̀', '"': '̈', '^': '̂', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', b: '̱', d: '̣' };
const ESCAPED = new Set(['%', '&', '$', '#', '_', '{', '}', ' ', ',', ';', ':', '!', '@', '/', '-', '>', '<']);

/* ------------------------------------------------------------------ colours and sizes */

export type RGB = [number, number, number];

// xcolor's base colours.
const BASE_COLORS: Record<string, RGB> = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], cyan: [0, 1, 1], magenta: [1, 0, 1], yellow: [1, 1, 0], black: [0, 0, 0],
  white: [1, 1, 1], gray: [0.5, 0.5, 0.5], darkgray: [0.25, 0.25, 0.25], lightgray: [0.75, 0.75, 0.75], brown: [0.75, 0.5, 0.25],
  lime: [0.75, 1, 0], olive: [0.5, 0.5, 0], orange: [1, 0.5, 0], pink: [1, 0.75, 0.75], purple: [0.75, 0, 0.25], teal: [0, 0.5, 0.5],
  violet: [0.5, 0, 0.5],
};

/** A colour given in a model (rgb, RGB, HTML, gray, cmyk), or null. */
export function colorInModel(model: string, spec: string): RGB | null {
  const numbers = spec.split(/[\s,]+/).filter(Boolean).map(Number);
  const unit = (value: number) => Math.min(1, Math.max(0, value));
  switch (model.trim()) {
    case 'rgb':
      return numbers.length === 3 && numbers.every(Number.isFinite) ? (numbers.map(unit) as RGB) : null;
    case 'RGB':
      return numbers.length === 3 && numbers.every(Number.isFinite) ? (numbers.map((value) => unit(value / 255)) as RGB) : null;
    case 'HTML': {
      const hex = /^\s*#?([0-9a-fA-F]{6})\s*$/.exec(spec)?.[1];
      return hex ? [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as RGB : null;
    }
    case 'gray':
      return numbers.length === 1 && Number.isFinite(numbers[0]) ? [unit(numbers[0]), unit(numbers[0]), unit(numbers[0])] : null;
    case 'cmyk': {
      if (numbers.length !== 4 || !numbers.every(Number.isFinite)) return null;
      const [c, m, y, k] = numbers.map(unit);
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
    default:
      return null;
  }
}

/** An xcolor expression ("red", "blue!30", "heatred!40!heatredmid", "-red") as RGB, or null. */
export function colorOf(expression: string, colors: Record<string, RGB> = {}): RGB | null {
  let text = expression.trim();
  let complement = false;
  while (text.startsWith('-')) {
    complement = !complement;
    text = text.slice(1).trim();
  }
  const parts = text.split('!').map((part) => part.trim());
  const named = (name: string) => colors[name] ?? BASE_COLORS[name] ?? null;
  let color = named(parts[0]);
  if (!color) return null;
  for (let at = 1; at < parts.length; at += 2) {
    const share = Number(parts[at]);
    if (!Number.isFinite(share)) return null;
    const other = at + 1 < parts.length ? named(parts[at + 1]) : BASE_COLORS.white;
    if (!other) return null;
    const p = Math.min(100, Math.max(0, share)) / 100;
    color = color.map((value, index) => value * p + other[index] * (1 - p)) as RGB;
  }
  return complement ? (color.map((value) => 1 - value) as RGB) : color;
}

export const cssColor = ([r, g, b]: RGB): string => `#${[r, g, b].map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;

/** A colour command's colour: `\color[model]{spec}` or `\color{expression}`, as CSS. */
const commandColor = (model: string | null, spec: string, definitions: Definitions): string | undefined => {
  const color = model ? colorInModel(model, spec) : colorOf(spec, definitions.colors);
  return color ? cssColor(color) : undefined;
};

// The size commands, as shares of the normal size (LaTeX's at 10pt).
const SIZES: Record<string, number> = { tiny: 0.5, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, normalsize: 1, large: 1.2, Large: 1.44, LARGE: 1.728, huge: 2.074, Huge: 2.488 };

/** A TeX length as CSS, when it is one CSS can say. */
const cssLength = (tex: string): string | undefined => {
  const match = /^\s*(-?[\d.]+)\s*(pt|bp|mm|cm|in|ex|em|pc)\s*$/.exec(tex);
  if (!match || !Number.isFinite(Number(match[1]))) return undefined;
  return `${Number(match[1])}${match[2] === 'bp' ? 'pt' : match[2]}`;
};

export interface Context {
  definitions: Definitions;
  labels: LooseLabel[];
  /** How many macros deep the text being read is. */
  depth?: number;
}

/** Running text from `from` to `to`, as styled runs and atoms. */
export function parseInline(src: string, from: number, to: number, context: Context, inherited: Style[] = [], look: Look = {}): Inline[] {
  return parseRun(src, from, to, context, inherited, look).items;
}

/** The text a run of inlines shows, read plainly. */
const shownText = (items: Inline[]): string => items.map((item) => (item.kind === 'text' || item.kind === 'raw' || item.kind === 'link' ? item.text : '')).join('');

/** Running text, and the styles and look in force at its end (a macro's switches go on after it). */
function parseRun(src: string, from: number, to: number, context: Context, inherited: Style[], inheritedLook: Look): { items: Inline[]; styles: Style[]; look: Look } {
  const out: Inline[] = [];
  let styles = [...inherited];
  let look: Look = { ...inheritedLook };
  const key = (list: Style[], shown: Look = {}) => `${[...new Set(list)].sort().join()}|${shown.color ?? ''}|${shown.size ?? ''}`;
  const lookOf = () => (look.color !== undefined || look.size !== undefined ? { look: { ...look } } : {});
  const push = (char: string, start: number, end: number) => {
    const last = out[out.length - 1];
    if (last?.kind === 'text' && key(last.styles, last.look) === key(styles, look)) {
      last.text += char;
      last.starts.push(start);
      last.ends.push(end);
    } else out.push({ kind: 'text', text: char, starts: [start], ends: [end], styles: [...new Set(styles)], ...lookOf() });
  };
  const nested = (inner: { from: number; to: number }, extra: Style | null, extraLook: Look = {}) => {
    for (const item of parseInline(src, inner.from, inner.to, context, extra ? [...styles, extra] : styles, { ...look, ...extraLook })) {
      const last = out[out.length - 1];
      if (item.kind === 'text' && last?.kind === 'text' && key(last.styles, last.look) === key(item.styles, item.look)) {
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
      // $$…$$ and \[…\] are display math; "$[" is inline math that starts with a bracket.
      const display = char === '$' ? src[at + 1] === '$' : src[at + 1] === '[';
      const open = char === '$' ? (display ? '$$' : '$') : src.slice(at, at + 2);
      const close = open === '$$' ? '$$' : open === '$' ? '$' : open === '\\(' ? '\\)' : '\\]';
      let end = at + open.length;
      while (end < to && !(src.startsWith(close, end) && src[end - 1] !== '\\')) end += 1;
      out.push({ kind: 'math', tex: src.slice(at + open.length, end), display, ...lookOf(), from: at, to: Math.min(to, end + close.length) });
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
    if (SIZES[name] !== undefined) {
      look = { ...look, size: SIZES[name] };
      at = after(end);
      continue;
    }
    if (name === 'fontsize') {
      const size = argument(src, end, to);
      const skip = size ? argument(src, size.end, to) : null;
      const points = size ? parseFloat(src.slice(size.from, size.to)) : NaN;
      if (Number.isFinite(points) && points > 0) look = { ...look, size: points / (context.definitions.size ?? 10) };
      at = skip?.end ?? size?.end ?? end;
      continue;
    }
    if (name === 'color' || name === 'textcolor' || name === 'colorbox' || name === 'cellcolor' || name === 'rowcolor' || name === 'columncolor') {
      const model = src[skipSpace(src, end, to)] === '[' ? optional(src, end, to) : null;
      const spec = argument(src, model ? model.end : end, to);
      if (!spec) {
        at = after(end);
        continue;
      }
      const color = commandColor(model ? src.slice(model.from, model.to) : null, src.slice(spec.from, spec.to), context.definitions);
      if (name === 'color') {
        if (color) look = { ...look, color };
        at = spec.end;
        continue;
      }
      if (name === 'textcolor' || name === 'colorbox') {
        const arg = argument(src, spec.end, to);
        if (!arg) {
          at = spec.end;
          continue;
        }
        nested(arg, null, name === 'textcolor' && color ? { color } : {});
        at = arg.end;
        continue;
      }
      // \cellcolor and \rowcolor colour their cell and row, read with the table.
      at = spec.end;
      continue;
    }
    if (name === 'rule') {
      const raise = src[skipSpace(src, end, to)] === '[' ? optional(src, end, to) : null;
      const width = argument(src, raise ? raise.end : end, to);
      const height = width ? argument(src, width.end, to) : null;
      if (!width || !height) {
        at = after(end);
        continue;
      }
      const w = cssLength(src.slice(width.from, width.to));
      const h = cssLength(src.slice(height.from, height.to));
      const lift = raise ? cssLength(src.slice(raise.from, raise.to)) : undefined;
      if (w && h) out.push({ kind: 'rule', width: w, height: h, ...(lift ? { raise: lift } : {}), ...(look.color ? { color: look.color } : {}), from: at, to: height.end });
      at = height.end;
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
    const macro = context.definitions.macros?.[name];
    if (macro && (context.depth ?? 0) < 8) {
      // Read as what it is defined to be, its arguments put in; switches in it (\color) go on after it.
      let stop = end;
      const args: string[] = [];
      if (macro.optional !== undefined) {
        const option = src[skipSpace(src, stop, to)] === '[' ? optional(src, stop, to) : null;
        args.push(option ? src.slice(option.from, option.to) : macro.optional);
        if (option) stop = option.end;
      }
      while (args.length < macro.args) {
        const arg = argument(src, stop, to);
        if (!arg) break;
        args.push(src.slice(arg.from, arg.to));
        stop = arg.end;
      }
      if (macro.args === 0 && src[stop] === '{' && src[stop + 1] === '}') stop += 2;
      const body = macro.body.replace(/#(\d)/g, (_, n: string) => args[Number(n) - 1] ?? '');
      const read = parseRun(body, 0, body.length, { ...context, labels: [], depth: (context.depth ?? 0) + 1 }, styles, look);
      styles = read.styles;
      look = read.look;
      if (read.items.length > 0) out.push({ kind: 'raw', text: shownText(read.items), content: read.items, from: at, to: stop });
      at = stop === end ? after(stop) : stop;
      continue;
    }
    let stop = src[end] === '[' ? optional(src, end, to)?.end ?? end : end;
    let last: { from: number; to: number } | null = null;
    for (let arg = argument(src, stop, to); arg && src[stop] === '{'; arg = argument(src, stop, to)) {
      last = arg;
      stop = arg.end;
    }
    const defined = context.definitions.text[name];
    const content = defined === undefined && last ? parseInline(src, last.from, last.to, { ...context, labels: [] }, styles, look) : undefined;
    const text = defined !== undefined ? plainText(defined) : content ? shownText(content) : '';
    out.push({ kind: 'raw', text, ...(content ? { content } : {}), from: at, to: last ? stop : after(stop) });
    at = last ? stop : after(stop);
  }
  return { items: out, styles, look };
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

/** The columns a tabular's preamble sets: how each aligns, and whether its text wraps (p, m, b, X, tabulary's L C R J). */
function columnsOf(spec: string): { align: 'l' | 'c' | 'r'; wrap: boolean }[] {
  const columns: { align: 'l' | 'c' | 'r'; wrap: boolean }[] = [];
  const group = (from: number) => {
    let at = from;
    while (/\s/.test(spec[at] ?? '')) at += 1;
    if (spec[at] !== '{') return at;
    let depth = 0;
    for (; at < spec.length; at += 1) {
      if (spec[at] === '{') depth += 1;
      else if (spec[at] === '}' && --depth === 0) return at + 1;
    }
    return spec.length;
  };
  for (let at = 0; at < spec.length; ) {
    const char = spec[at];
    if ('@!<>'.includes(char)) at = group(at + 1);
    else if (char === '*') {
      const count = group(at + 1);
      const body = group(count);
      const times = Number(spec.slice(spec.indexOf('{', at) + 1, count - 1));
      const inner = columnsOf(spec.slice(spec.indexOf('{', count) + 1, body - 1));
      for (let n = 0; n < (Number.isFinite(times) ? Math.min(times, 100) : 0); n += 1) columns.push(...inner);
      at = body;
    } else if ('pmb'.includes(char)) {
      columns.push({ align: 'l', wrap: true });
      at = group(at + 1);
    } else if ('XLCRJ'.includes(char)) {
      columns.push({ align: char === 'C' ? 'c' : char === 'R' ? 'r' : 'l', wrap: true });
      at += 1;
    } else if ('lcrS'.includes(char)) {
      columns.push({ align: char === 'l' ? 'l' : char === 'r' ? 'r' : 'c', wrap: false });
      at += 1;
    } else at += 1;
  }
  return columns;
}

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
  const columns = columnsOf(src.slice(spec.from, spec.to));
  const rows: TableRow[] = [];
  let pending: TableRow['above'];
  // \cellcolor at the start of a cell: its colour, and the cell after it.
  const cellColor = (inner: { from: number; to: number }): { inner: { from: number; to: number }; background?: string } => {
    const colored = /^\s*\\cellcolor\b\s*/.exec(src.slice(inner.from, inner.to));
    if (!colored) return { inner };
    let stop = inner.from + colored[0].length;
    const model = src[stop] === '[' ? optional(src, stop, inner.to) : null;
    if (model) stop = model.end;
    const spec = argument(src, stop, inner.to);
    if (!spec) return { inner };
    const background = commandColor(model ? src.slice(model.from, model.to) : null, src.slice(spec.from, spec.to), context.definitions);
    return { inner: { from: spec.end, to: inner.to }, ...(background ? { background } : {}) };
  };
  for (const part of splitTop(src, spec.end, end.start, '\\\\')) {
    let start = part.from;
    let background: string | undefined;
    // Rules before the row's cells.
    for (let rule = RULE.exec(src.slice(start, part.to)); rule; rule = RULE.exec(src.slice(start, part.to))) {
      const kind = rule[1];
      if (kind === 'rowcolor') {
        const color = /\\rowcolor\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(rule[0]);
        if (color) background = commandColor(color[1] ?? null, color[2], context.definitions);
      }
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
      let { align, wrap } = columns[column] ?? { align: undefined, wrap: false };
      let inner = cell;
      const multi = /^\s*\\multicolumn\s*\{(\d+)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*/.exec(src.slice(cell.from, cell.to));
      if (multi) {
        span = Number(multi[1]);
        ({ align, wrap } = columnsOf(multi[2])[0] ?? { align: 'l', wrap: false });
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
      const colored = cellColor(inner);
      inner = colored.inner;
      cells.push({ content: trimmed(parseInline(src, inner.from, inner.to, context)), span, align, ...(wrap ? { wrap } : {}), ...(colored.background ? { background: colored.background } : {}), from: inner.from, to: inner.to });
      column += span;
    }
    rows.push({ cells, ...(background ? { background } : {}), ...(pending ? { above: pending } : {}) });
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
    const before = src.slice(inner, inner + tabularAt).replace(/(^|[^\\])%[^\n]*/g, '$1');
    // \resizebox{\linewidth}{!}{…} scales the table to the line; \resizebox{\ifdim\width>\linewidth…} and
    // adjustbox's max width only shrink it.
    const box = /\\resizebox\*?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(before)?.[1];
    const fit =
      box !== undefined && /\\ifdim\s*\\width\s*>/.test(box)
        ? 'shrink'
        : box !== undefined && /\\(linewidth|textwidth|columnwidth|hsize)\b/.test(box)
          ? 'scale'
          : /\\(?:begin\s*\{adjustbox\}|adjustbox)\s*\{[^}]*max\s+width\s*=/.test(before)
            ? 'shrink'
            : undefined;
    // The size the table is set in (\small before the tabular), as a share of the normal size.
    let size: number | undefined;
    for (const match of before.matchAll(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b|\\fontsize\s*\{([\d.]+)/g)) {
      size = match[1] ? SIZES[match[1]] : Number(match[2]) / (context.definitions.size ?? 10);
    }
    return { kind: 'table', wide: name.endsWith('*'), rows: tabular.rows, ...(fit ? { fit } : {}), ...(size !== undefined && Number.isFinite(size) ? { size } : {}), caption, captionFirst: caption !== undefined && caption.from < inner + tabularAt, labels, from, to: end.end };
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
  const macros: NonNullable<Definitions['macros']> = {};
  const colors: Record<string, RGB> = {};
  const definitions: Definitions = { text: {}, math: {}, theorems: {}, macros, colors };
  const src = preamble.replace(/(^|[^\\])%[^\n]*/g, '$1');
  const pattern = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?\s*(?:\[([^\]]*)\])?\s*\{/g;
  for (const match of src.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const end = closing(src, open);
    if (end < 0) continue;
    const body = src.slice(open + 1, end - 1);
    definitions.math[`\\${match[1]}`] = body;
    if (!match[2]) definitions.text[match[1]] = body;
    macros[match[1]] = { args: Number(match[2] ?? 0), ...(match[2] && match[3] !== undefined ? { optional: match[3] } : {}), body };
  }
  for (const match of src.matchAll(/\\def\s*\\([A-Za-z@]+)\s*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const end = closing(src, open);
    if (end < 0) continue;
    definitions.math[`\\${match[1]}`] = src.slice(open + 1, end - 1);
    definitions.text[match[1]] = src.slice(open + 1, end - 1);
    macros[match[1]] = { args: 0, body: src.slice(open + 1, end - 1) };
  }
  // Colours, in the order they are defined (\colorlet mixes those before it).
  for (const match of src.matchAll(/\\(?:definecolor\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}|colorlet\s*\{([^}]*)\}\s*(?:\[[^\]]*\])?\s*\{([^}]*)\})/g)) {
    const color = match[1] !== undefined ? colorInModel(match[2], match[3]) : colorOf(match[5], colors);
    if (color) colors[(match[1] ?? match[4]).trim()] = color;
  }
  const size = /\\documentclass\s*\[([^\]]*)\]/.exec(src)?.[1].match(/\b(1[012])pt\b/)?.[1];
  if (size) definitions.size = Number(size);
  for (const match of src.matchAll(/\\DeclareMathOperator(\*?)\s*\{\s*\\([A-Za-z]+)\s*\}\s*\{([^}]*)\}/g)) {
    definitions.math[`\\${match[2]}`] = match[1] ? `\\operatorname*{${match[3]}}` : `\\operatorname{${match[3]}}`;
  }
  for (const match of src.matchAll(/\\newtheorem(\*?)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g)) {
    const name = match[2].trim();
    definitions.theorems[name] = { title: match[4].trim(), counter: match[3]?.trim() || name, numbered: !match[1] };
  }
  return definitions;
}
