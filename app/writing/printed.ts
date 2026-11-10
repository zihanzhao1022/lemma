/**
 * What a stretch of LaTeX prints, unit by unit, each with the source range it comes from: the base for editing
 * the PDF in place. Plain characters, escaped ones (\%), TeX's dashes and quotes and accented letters are
 * characters; runs of white space (and a tie) are one space; math, citations, references, footnotes, images and
 * commands this file does not know are atoms, typed around but never into; table cell and row ends are
 * separators. Markup that prints nothing (braces, style commands, labels, rules) gives no unit at all.
 */

export type PrintedKind = 'char' | 'space' | 'atom' | 'separator';

export interface PrintedUnit {
  kind: PrintedKind;
  /** Source range [from, to). */
  from: number;
  to: number;
  /** What it prints: the character(s) of a char, ' ' for a space, '' for an atom or separator. */
  text: string;
}

const MATH_ENVIRONMENTS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*',
  'displaymath', 'math', 'flalign', 'flalign*', 'alignat', 'alignat*',
]);
const VERBATIM_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment']);

/** Braced arguments of an environment's opening that print nothing (optional ones are always skipped). */
const ENVIRONMENT_ARGUMENTS: Record<string, number> = {
  tabular: 1, 'tabular*': 2, tabularx: 2, tabulary: 2, array: 1, longtable: 1, minipage: 1, multicols: 1, 'multicols*': 1,
  thebibliography: 1, wrapfigure: 2, wraptable: 2, subfigure: 1, subtable: 1, adjustbox: 1,
};

/** Commands whose last argument prints as text, after this many arguments that do not. */
const WRAPPERS: Record<string, number> = {
  emph: 0, textbf: 0, textit: 0, textsl: 0, textsc: 0, textup: 0, textmd: 0, textrm: 0, textsf: 0, texttt: 0, textnormal: 0,
  underline: 0, uline: 0, mbox: 0, makebox: 0, fbox: 0, framebox: 0, text: 0, hl: 0, textsuperscript: 0, textsubscript: 0,
  textcolor: 1, colorbox: 1, fcolorbox: 2, multicolumn: 2, multirow: 2, parbox: 1, raisebox: 1, rotatebox: 1, scalebox: 1,
  resizebox: 2, shortstack: 0, caption: 0, section: 0, subsection: 0, subsubsection: 0, paragraph: 0, subparagraph: 0,
  chapter: 0, part: 0, title: 0,
};

/** Commands that print nothing, with the number of braced arguments they take. */
const SILENT: Record<string, number> = {
  label: 1, vspace: 1, hspace: 1, setlength: 2, addtolength: 2, color: 1, pagestyle: 1, thispagestyle: 1, cline: 1,
  rowcolor: 1, cellcolor: 1, arrayrulecolor: 1, linespread: 1, fontsize: 2, enlargethispage: 1, bibliographystyle: 1,
  nocite: 1, index: 1, addcontentsline: 3, cmidrule: 1, specialrule: 3, setcounter: 2, addtocounter: 2, hyphenation: 1,
};

/** Commands without arguments that print nothing. */
const DECLARATIONS = new Set([
  'bf', 'it', 'sl', 'sc', 'tt', 'rm', 'sf', 'em', 'bfseries', 'itshape', 'slshape', 'scshape', 'ttfamily', 'rmfamily',
  'sffamily', 'mdseries', 'upshape', 'normalfont', 'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large',
  'Large', 'LARGE', 'huge', 'Huge', 'centering', 'raggedright', 'raggedleft', 'noindent', 'indent', 'relax', 'protect',
  'nobreak', 'newpage', 'clearpage', 'cleardoublepage', 'smallskip', 'medskip', 'bigskip', 'vfill', 'hfill', 'hfil',
  'null', 'leavevmode', 'maketitle', 'toprule', 'midrule', 'bottomrule', 'hline', 'appendix', 'selectfont', 'item',
  'phantomsection', 'unskip', 'ignorespaces', 'sloppy', 'fussy', 'frenchspacing', 'nonfrenchspacing', 'strut',
]);

/** Commands that print a space. */
const SPACES = new Set(['quad', 'qquad', 'enspace', 'enskip', 'thinspace', 'par', 'newline', 'linebreak']);

/** Commands that print one character (or a fixed short text). */
const LETTERS: Record<string, string> = {
  ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textbar: '|', textless: '<', textgreater: '>',
  textbullet: '•', dag: '†', ddag: '‡', S: '§', P: '¶', copyright: '©', pounds: '£', textregistered: '®',
  texttrademark: '™', textendash: '–', textemdash: '—', ldots: '...', dots: '...', textellipsis: '...',
  textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”', textdegree: '°', euro: '€',
};

/** Atoms whose arguments may follow after spaces: how many braced arguments they take. */
const ATOM_ARGUMENTS: Record<string, number> = {
  cite: 1, citep: 1, citet: 1, citealp: 1, citealt: 1, citeauthor: 1, citeyear: 1, Citep: 1, Citet: 1, parencite: 1,
  textcite: 1, autocite: 1, ref: 1, eqref: 1, autoref: 1, cref: 1, Cref: 1, pageref: 1, nameref: 1, footnote: 1,
  footnotetext: 1, url: 1, href: 2, includegraphics: 1, input: 1, include: 1, bibliography: 1, thanks: 1, todo: 1,
};

const COMBINING: Record<string, string> = {
  "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇',
  u: '̆', v: '̌', H: '̋', c: '̧', d: '̣', b: '̱', r: '̊', k: '̨',
};

const ESCAPED = new Set(['%', '&', '$', '#', '_', '{', '}']);
const THIN_SPACES = new Set([',', ';', ':', '>']);
const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r';
const isLetter = (char: string | undefined): boolean => char !== undefined && /[A-Za-z@]/.test(char);

export function printedUnits(source: string, from = 0, to = source.length): PrintedUnit[] {
  const units: PrintedUnit[] = [];
  const emit = (kind: PrintedKind, start: number, end: number, text: string) => units.push({ kind, from: start, to: end, text });
  let i = from;

  /** The end of a balanced group opening at `at` ({...}, [...] or (...)), escapes skipped. */
  const groupEnd = (at: number, open: string, close: string): number => {
    let depth = 0;
    for (let j = at; j < source.length; j += 1) {
      const char = source[j];
      if (char === '\\') j += 1;
      else if (char === open) depth += 1;
      else if (char === close && --depth === 0) return j + 1;
    }
    return source.length;
  };
  const skipSpaces = (at: number): number => {
    while (at < source.length && isSpace(source[at])) at += 1;
    return at;
  };
  /** Skips optional arguments ([...]) after `at`, spaces between them included. */
  const skipOptional = (at: number): number => {
    let next = skipSpaces(at);
    while (source[next] === '[') {
      at = groupEnd(next, '[', ']');
      next = skipSpaces(at);
    }
    return at;
  };
  /** Skips `count` braced arguments (each may be followed by optional ones), spaces before each allowed. */
  const skipArguments = (at: number, count: number): number => {
    for (let n = 0; n < count; n += 1) {
      const next = skipSpaces(at);
      if (source[next] !== '{') {
        // An argument that is a single token.
        if (next < source.length && !isSpace(source[next])) at = source[next] === '\\' ? commandEnd(next) : next + 1;
        break;
      }
      at = skipOptional(groupEnd(next, '{', '}'));
    }
    return at;
  };
  const commandEnd = (at: number): number => {
    let end = at + 1;
    if (isLetter(source[end])) while (isLetter(source[end])) end += 1;
    else end += 1;
    return end;
  };
  /** An accent's letter: `x`, `{x}` or (after a letter accent) ` x`; the composed text and where it ends. */
  const accented = (at: number, mark: string, letterCommand: boolean): { text: string; end: number } => {
    let next = letterCommand ? skipSpaces(at) : at;
    let base = '';
    if (source[next] === '{') {
      const close = groupEnd(next, '{', '}');
      base = source.slice(next + 1, close - 1).trim();
      next = close;
    } else if (next < source.length) {
      base = String.fromCodePoint(source.codePointAt(next)!);
      next += base.length;
    }
    if (base.startsWith('\\') && LETTERS[base.slice(1)]) base = LETTERS[base.slice(1)];
    return { text: `${base}${mark}`.normalize('NFC'), end: next };
  };

  while (i < to) {
    const char = source[i];
    if (char === '%') {
      const end = source.indexOf('\n', i);
      // TeX drops the comment, its line break and the spaces that start the next line.
      i = end < 0 ? source.length : skipLeading(end + 1);
      continue;
    }
    if (isSpace(char)) {
      const start = i;
      while (i < to && isSpace(source[i])) i += 1;
      emit('space', start, i, ' ');
      continue;
    }
    if (char === '{' || char === '}') {
      i += 1;
      continue;
    }
    if (char === '~') {
      emit('space', i, i + 1, ' ');
      i += 1;
      continue;
    }
    if (char === '&') {
      emit('separator', i, i + 1, '');
      i += 1;
      continue;
    }
    if (char === '$') {
      const display = source[i + 1] === '$';
      let end = i + (display ? 2 : 1);
      for (; end < source.length; end += 1) {
        if (source[end] === '\\') end += 1;
        else if (source[end] === '$') break;
      }
      end = Math.min(source.length, end + (display ? 2 : 1));
      emit('atom', i, end, '');
      i = end;
      continue;
    }
    if (char === '-') {
      const length = source.startsWith('---', i) ? 3 : source.startsWith('--', i) ? 2 : 1;
      emit('char', i, i + length, length === 3 ? '—' : length === 2 ? '–' : '-');
      i += length;
      continue;
    }
    if (char === '`' || char === "'") {
      const double = source[i + 1] === char;
      emit('char', i, i + (double ? 2 : 1), char === '`' ? (double ? '“' : '‘') : double ? '”' : '’');
      i += double ? 2 : 1;
      continue;
    }
    if (char !== '\\') {
      const point = String.fromCodePoint(source.codePointAt(i)!);
      emit('char', i, i + point.length, point);
      i += point.length;
      continue;
    }

    // A command.
    const next = source[i + 1];
    if (next === undefined) {
      i += 1;
      continue;
    }
    if (!isLetter(next)) {
      if (ESCAPED.has(next)) emit('char', i, i + 2, next);
      else if (next === '\\') {
        let end = i + 2;
        if (source[end] === '*') end += 1;
        end = skipOptional(end);
        emit('separator', i, end, '');
        i = end;
        continue;
      } else if (isSpace(next) || THIN_SPACES.has(next)) emit('space', i, i + 2, ' ');
      else if (COMBINING[next]) {
        const accent = accented(i + 2, COMBINING[next], false);
        emit('char', i, accent.end, accent.text);
        i = accent.end;
        continue;
      } else if (next === '(' || next === '[') {
        const close = source.indexOf(next === '(' ? '\\)' : '\\]', i + 2);
        const end = close < 0 ? source.length : close + 2;
        emit('atom', i, end, '');
        i = end;
        continue;
      } else if (!['-', '/', '@', '!'].includes(next)) emit('atom', i, i + 2, '');
      i += 2;
      continue;
    }
    const end = commandEnd(i);
    const name = source.slice(i + 1, end);
    let after = end;
    if (source[after] === '*') after += 1;

    if (name === 'begin' || name === 'end') {
      const open = skipSpaces(after);
      const close = source[open] === '{' ? groupEnd(open, '{', '}') : open;
      const environment = source.slice(open + 1, close - 1).trim();
      if (name === 'begin' && (MATH_ENVIRONMENTS.has(environment) || VERBATIM_ENVIRONMENTS.has(environment))) {
        const ending = new RegExp(`\\\\end\\s*\\{${environment.replace(/\*/g, '\\*')}\\}`, 'g');
        ending.lastIndex = close;
        const found = ending.exec(source);
        const stop = found ? found.index + found[0].length : source.length;
        emit('atom', i, stop, '');
        i = stop;
        continue;
      }
      i = name === 'begin' ? skipArguments(skipOptional(close), ENVIRONMENT_ARGUMENTS[environment] ?? 0) : close;
      if (name === 'begin') i = skipOptional(i);
      continue;
    }
    if (name === 'verb') {
      const delimiter = source[after];
      const close = delimiter ? source.indexOf(delimiter, after + 1) : -1;
      const stop = close < 0 ? source.length : close + 1;
      emit('atom', i, stop, '');
      i = stop;
      continue;
    }
    if (WRAPPERS[name] !== undefined) {
      let at = skipArguments(skipOptional(after), WRAPPERS[name]);
      at = skipOptional(at);
      const open = skipSpaces(at);
      // The printed argument's braces are markup; what is inside reads as text.
      i = source[open] === '{' ? open + 1 : open;
      continue;
    }
    if (SILENT[name] !== undefined) {
      let at = skipOptional(after);
      const paren = skipSpaces(at);
      if (source[paren] === '(') at = groupEnd(paren, '(', ')');
      i = skipArguments(at, SILENT[name]);
      continue;
    }
    if (DECLARATIONS.has(name)) {
      i = name === 'item' || name.endsWith('rule') || name === 'hline' ? skipOptional(after) : after;
      i = skipSpaces(i);
      continue;
    }
    if (SPACES.has(name)) {
      const stop = skipSpaces(after);
      emit('space', i, stop, ' ');
      i = stop;
      continue;
    }
    if (LETTERS[name] !== undefined) {
      let stop = after;
      if (source.startsWith('{}', stop)) stop += 2;
      emit('char', i, stop, LETTERS[name]);
      i = stop === after ? skipSpaces(stop) : stop;
      continue;
    }
    if (COMBINING[name] && name.length === 1) {
      const accent = accented(after, COMBINING[name], true);
      emit('char', i, accent.end, accent.text);
      i = accent.end;
      continue;
    }
    if (ATOM_ARGUMENTS[name] !== undefined) {
      const stop = skipArguments(skipOptional(after), ATOM_ARGUMENTS[name]);
      emit('atom', i, stop, '');
      i = stop;
      continue;
    }
    // A command this file does not know: it and the arguments right after it print something of their own.
    let stop = after;
    let argument = false;
    for (;;) {
      if (source[stop] === '[') stop = groupEnd(stop, '[', ']');
      else if (source[stop] === '{') stop = groupEnd(stop, '{', '}');
      else break;
      argument = true;
    }
    emit('atom', i, stop, '');
    i = argument ? stop : skipSpaces(stop);
  }
  return units;

  function skipLeading(at: number): number {
    while (at < source.length && (source[at] === ' ' || source[at] === '\t')) at += 1;
    return at;
  }
}
