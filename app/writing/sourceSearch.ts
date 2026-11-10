import { Hit, Located, Mark, locate } from './document';

export interface SourceRange {
  line: number;
  start: number;
  end: number;
}

interface SearchText {
  text: string;
  starts: number[];
  ends: number[];
}

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[\u2010\u2011\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/\u00ad/g, '');
const words = (text: string): string[] => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const numericLiteral = /^[+-]?(?:(?:\p{N}{1,3}(?:,\p{N}{3})+|\p{N}+)(?:\.\p{N}+)?|\.\p{N}+)(?:e[+-]?\p{N}+)?%?$/u;
const hiddenArguments = /^(?:label|ref|pageref|eqref|autoref|[cC]ref|nameref|cite\w*|bibliography|bibliographystyle|input|include|includegraphics|begin|end|documentclass|usepackage|PassOptionsToPackage|hspace|vspace|setlength|hhline|cline|cmidrule)$/;
// These arguments control layout; the following argument contains the printed cell/text.
const layoutArguments: Record<string, number> = {
  multicolumn: 2, multirow: 2, resizebox: 2, scalebox: 1, rotatebox: 1,
  makebox: 0, parbox: 1, raisebox: 1, textcolor: 1, colorbox: 1, fcolorbox: 2,
  cellcolor: 1, rowcolor: 1, arrayrulecolor: 1, color: 1,
};

/** Text likely to be printed, retaining UTF-16 offsets into the original LaTeX. */
function searchable(source: string): SearchText {
  const result: SearchText = { text: '', starts: [], ends: [] };
  const append = (text: string, from: number, to: number) => {
    const value = normalize(text);
    result.text += value;
    for (let j = 0; j < value.length; j += 1) {
      result.starts.push(from);
      result.ends.push(to);
    }
  };
  const groupEnd = (at: number, open: string, close: string): number => {
    let depth = 1;
    for (let i = at + 1; i < source.length; i += 1) {
      if (source[i] === '\\') i += 1;
      else if (source[i] === open) depth += 1;
      else if (source[i] === close && --depth === 0) return i + 1;
    }
    return source.length;
  };
  for (let i = 0; i < source.length; ) {
    const char = source[i];
    if (char === '%') {
      const end = source.indexOf('\n', i);
      // A comment removes its newline too: "per%\nformance" prints as one word.
      i = end < 0 ? source.length : end + 1;
    } else if (char === '\\') {
      const command = /^\\([A-Za-z@]+)\*?/.exec(source.slice(i));
      if (command) {
        i += command[0].length;
        while (/\s/.test(source[i] ?? '') && i < source.length) i += 1;
        while (source[i] === '[') {
          i = groupEnd(i, '[', ']');
          while (/\s/.test(source[i] ?? '') && i < source.length) i += 1;
        }
        for (let argument = 0; argument < (layoutArguments[command[1]] ?? 0); argument += 1) {
          while (/\s/.test(source[i] ?? '') && i < source.length) i += 1;
          if (source[i] !== '{') break;
          i = groupEnd(i, '{', '}');
          while (/\s/.test(source[i] ?? '') && i < source.length) i += 1;
          while (source[i] === '[') {
            i = groupEnd(i, '[', ']');
            while (/\s/.test(source[i] ?? '') && i < source.length) i += 1;
          }
        }
        if (hiddenArguments.test(command[1])) {
          while (/\s/.test(source[i] ?? '') && i < source.length) i += 1;
          if (source[i] === '{') i = groupEnd(i, '{', '}');
          append(' ', i, i);
        }
      } else {
        const next = source[i + 1];
        if (next && /[%&#_{}]/.test(next)) append(next, i, i + 2);
        else if (next !== '-') append(' ', i, i + 2);
        i += 2;
      }
    } else if (/[{}$]/.test(char)) i += 1;
    else {
      const point = String.fromCodePoint(source.codePointAt(i)!);
      append(point === '~' ? ' ' : point, i, i + point.length);
      i += point.length;
    }
  }
  return result;
}

interface Match extends SourceRange {
  score: number;
}

function offsetRange(source: string, start: number, end: number): SourceRange {
  const before = source.slice(0, start);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = source.indexOf('\n', start);
  return { line: before.split('\n').length, start: start - lineStart, end: Math.min(end, lineEnd < 0 ? source.length : lineEnd) - lineStart };
}

function search(source: string, word: string, context: string, range?: Located, strict = false, contextOffset?: number, literalNumbers = false): Match | null {
  const normalizedWord = normalize(word).trim();
  const numeric = numericLiteral.test(normalizedWord);
  const target = numeric ? normalizedWord : normalizedWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!target) return null;
  const content = searchable(source);
  // A table's math macros can produce PDF words with no literal spelling in its code.
  // Keep the known neighboring values adjacent when disambiguating repeated data cells.
  const knownWords = literalNumbers && numeric ? new Set(words(content.text)) : null;
  const contextWordsAt = (text: string) => words(text).filter((item) => !knownWords || knownWords.has(item));
  const contextWords = contextWordsAt(context);
  const nearby = new Set(contextWords);
  const phrase = contextWords.join(' ');
  const normalizedContext = normalize(context);
  const offset = contextOffset === undefined ? undefined : normalize(context.slice(0, contextOffset)).length;
  let contextAt = normalizedContext.indexOf(target);
  if (offset !== undefined && contextAt >= 0) {
    const distance = (at: number) => Math.max(at - offset, offset - at - target.length, 0);
    for (let at = normalizedContext.indexOf(target, contextAt + 1); at >= 0; at = normalizedContext.indexOf(target, at + 1)) {
      if (distance(at) < distance(contextAt)) contextAt = at;
    }
  }
  let best: Match | null = null;
  for (let at = content.text.indexOf(target); at >= 0; at = content.text.indexOf(target, at + 1)) {
    const result = offsetRange(source, content.starts[at], content.ends[at + target.length - 1]);
    const inRange = range && result.line >= range.line && result.line <= range.until;
    if (strict && !inRange) continue;
    const isLetter = (value: string) => /[\p{L}\p{N}]/u.test(value);
    const boundary = !isLetter(content.text[at - 1] ?? '') && !isLetter(content.text[at + target.length] ?? '');
    // A value's sign, decimal part and percentage suffix identify its actual table cell.
    if (numeric && (!boundary || /[+\-.,]/u.test(content.text[at - 1] ?? '')
      || content.text[at + target.length] === '%'
      || /^[.,]\p{N}/u.test(content.text.slice(at + target.length)))) continue;
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(target);
    const truncated = normalize(word).endsWith('-') || normalize(context).includes(`${target}-`);
    if (!boundary && !cjk && !truncated && !inRange) continue;
    const radius = Math.max(80, context.length * 1.2);
    const around = words(content.text.slice(Math.max(0, at - radius), at + target.length + radius));
    const aroundSet = new Set(around);
    let score = [...nearby].filter((item) => aroundSet.has(item)).length;
    // Consecutive words distinguish repeated terms and several occurrences on one source line.
    if (contextAt >= 0) {
      const left = contextWordsAt(normalizedContext.slice(0, contextAt));
      const right = contextWordsAt(normalizedContext.slice(contextAt + target.length));
      const before = words(content.text.slice(Math.max(0, at - radius), at));
      const after = words(content.text.slice(at + target.length, at + target.length + radius));
      for (let j = 1; j <= Math.min(6, left.length, before.length); j += 1) {
        if (left[left.length - j] !== before[before.length - j]) break;
        score += 3;
      }
      for (let j = 0; j < Math.min(6, right.length, after.length); j += 1) {
        if (right[j] !== after[j]) break;
        score += 3;
      }
    }
    if (phrase && around.join(' ').includes(phrase)) score += 4;
    // Counters and reference numbers are generated; require their literal context for a numeric hit.
    if (!literalNumbers && /^\p{N}+$/u.test(target) && /\p{L}/u.test(context) && !around.join(' ').includes(phrase)) continue;
    if (boundary) score += 2;
    if (inRange) score += 3;
    if (range) score -= Math.min(1, Math.abs(result.line - range.line) * 0.002);
    if (!best || score > best.score) best = { ...result, score };
  }
  return best;
}

/** Search the marked region first, then nearby lines; selection columns refer to the original source. */
export function findSourceWord(lines: string[], from: number, until: number, word: string, context = ''): SourceRange | null {
  const source = lines.join('\n');
  const match = search(source, word, context, { line: from, until }, true)
    ?? search(source, word, context, { line: Math.max(1, from - 8), until: until + 30 }, true);
  if (!match) return null;
  const { score: _score, ...result } = match;
  return result;
}

export interface SourceLocation extends Partial<Pick<SourceRange, 'start' | 'end'>> {
  file: string;
  line: number;
}

/** Position marks disambiguate text; text also finds headings and command arguments without marks. */
export function inverseSearch(sources: Record<string, string>, marks: Mark[], hit: Hit & { word: string; context: string; rowContext?: string; contextOffset?: number; rowContextOffset?: number }, fileNames: string[] = ['main.tex'], options: { literalNumbers?: boolean } = {}): SourceLocation | null {
  const located = locate(marks, hit);
  const preferred = fileNames[located?.file ?? 0] ?? 'main.tex';
  const float = located?.scope === 'float';
  const context = float ? hit.rowContext || hit.context : hit.context;
  const contextOffset = float && hit.rowContext ? hit.rowContextOffset : hit.contextOffset;
  const regions: { file: string; range?: Located }[] = [];
  if (float) {
    regions.push({ file: preferred, range: located });
    // A table may input its rows from a separate file. Follow only inputs of the clicked float.
    const visited = new Set([preferred]);
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      const lines = (sources[region.file] ?? '').split('\n');
      const source = region.range ? lines.slice(region.range.line - 1, region.range.until).join('\n') : lines.join('\n');
      const uncommented = source.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, '$1$2');
      for (const input of uncommented.matchAll(/\\(?:input|include)\s*(?:\{([^{}]+)\}|([^\s{}%]+))/g)) {
        const raw = (input[1] ?? input[2]).trim();
        if (raw.startsWith('/') || /[\\#{}]/.test(raw)) continue;
        const parts: string[] = [];
        let valid = true;
        for (const part of raw.split('/')) {
          if (!part || part === '.') continue;
          if (part === '..') {
            if (!parts.length) { valid = false; break; }
            parts.pop();
          } else parts.push(part);
        }
        if (!valid || !parts.length) continue;
        const name = parts.join('/').replace(/\.tex$/, '');
        const file = [`files/${name}.tex`, `${name}.tex`].find((key) => sources[key] !== undefined);
        if (!file || visited.has(file)) continue;
        visited.add(file);
        regions.push({ file });
      }
    }
  } else {
    for (const file of Object.keys(sources)) {
      if (file === 'main.tex' || file === 'preamble.tex' || file.endsWith('.tex')) regions.push({ file, range: file === preferred ? located ?? undefined : undefined });
    }
  }
  let best: (SourceLocation & { score: number }) | null = null;
  for (const { file, range } of regions) {
    const match = search(sources[file] ?? '', hit.word, context, range, float && range !== undefined, contextOffset, options.literalNumbers);
    if (match && (!best || match.score > best.score)) best = { file, ...match };
  }
  if (best) {
    const { score: _score, ...result } = best;
    return result;
  }
  // A printed number or macro may have no literal source spelling. Use the other words on its PDF line.
  for (const word of [...new Set(words(context))].sort((a, b) => b.length - a.length)) {
    if (word.length < 3) continue;
    for (const { file, range } of regions) {
      const match = search(sources[file] ?? '', word, context, range, float && range !== undefined, contextOffset);
      if (match && (!best || match.score > best.score)) best = { file, ...match };
    }
  }
  if (best) return { file: best.file, line: best.line, start: best.start, end: best.end };
  return located ? { file: preferred, line: located.line } : null;
}
