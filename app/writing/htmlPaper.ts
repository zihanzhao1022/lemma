/**
 * What the web page of a paper needs beyond each block's elements: how its template looks (columns, font, size),
 * the numbers LaTeX would give its headings, floats, equations and theorems, what each \ref and \cite shows, and
 * the list of references. Close to what LaTeX prints, not the same.
 */
import { Element, LooseLabel, plainText } from './latexHtml';

/* ------------------------------------------------------------------ the template */

export interface PaperStyle {
  /** The template it follows. */
  template: 'article' | 'ieee' | 'acl' | 'neurips' | 'iclr' | 'icml';
  columns: 1 | 2;
  font: 'cm' | 'times' | 'palatino' | 'sans';
  /** Body text size and the width of the text, in points. */
  size: number;
  pageWidth: number;
  textWidth: number;
  columnGap: number;
  citations: 'numeric' | 'author-year';
}

const option = (options: string[], pattern: RegExp) => options.some((item) => pattern.test(item));

/** The template a preamble uses, and what its pages look like; `bibliographyStyle` decides how citations read. */
export function paperStyle(preamble: string, bibliographyStyle = 'plain'): PaperStyle {
  const src = preamble.replace(/(^|[^\\])%[^\n]*/g, '$1');
  const documentClass = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(src);
  const options = (documentClass?.[1] ?? '').split(',').map((item) => item.trim());
  const name = documentClass?.[2]?.trim() ?? 'article';
  const uses = (pattern: RegExp) => new RegExp(`\\\\usepackage\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b(?:${pattern.source})\\b[^}]*\\}`).test(src);
  const size = option(options, /^12pt$/) ? 12 : option(options, /^11pt$/) ? 11 : 10;
  const a4 = option(options, /a4paper/);
  const numbersOption = /\\usepackage\s*\[[^\]]*\bnumbers\b[^\]]*\]\s*\{natbib\}/.test(src);
  const authorYearStyle = /nat|apa|acl|iclr|icml|chicago|harvard|named|authordate|agsm|neurips|abbrvnat/i.test(bibliographyStyle) && !/unsrtnat/i.test(bibliographyStyle);
  const citations: PaperStyle['citations'] = authorYearStyle && !numbersOption ? 'author-year' : 'numeric';
  const font: PaperStyle['font'] = uses(/times|mathptmx|newtxtext|ptm|txfonts|tgtermes/)
    ? 'times'
    : uses(/mathpazo|palatino|newpxtext|tgpagella|pxfonts/)
      ? 'palatino'
      : uses(/helvet|sourcesanspro|libertinus-sans/)
        ? 'sans'
        : 'cm';
  if (/^IEEEtran$/i.test(name)) {
    const one = option(options, /onecolumn|draftcls/);
    return { template: 'ieee', columns: one ? 1 : 2, font: 'times', size, pageWidth: a4 ? 595 : 612, textWidth: one ? 469 : 516, columnGap: 12.4, citations: 'numeric' };
  }
  if (uses(/acl|acl20\d\d|emnlp20\d\d|naaclhlt20\d\d|eacl20\d\d|coling20\d\d/)) {
    return { template: 'acl', columns: 2, font: 'times', size: 11, pageWidth: 595, textWidth: 455, columnGap: 17, citations: numbersOption ? 'numeric' : 'author-year' };
  }
  if (uses(/icml20\d\d/)) return { template: 'icml', columns: 2, font: 'times', size: 10, pageWidth: 612, textWidth: 487, columnGap: 18, citations: numbersOption ? 'numeric' : 'author-year' };
  if (uses(/iclr20\d\d_conference|iclr20\d\d/)) return { template: 'iclr', columns: 1, font: 'times', size: 10, pageWidth: 612, textWidth: 397, columnGap: 0, citations: numbersOption ? 'numeric' : 'author-year' };
  if (uses(/neurips_20\d\d|nips_20\d\d|neurips/)) return { template: 'neurips', columns: 1, font: 'times', size: 10, pageWidth: 612, textWidth: 397, columnGap: 0, citations };
  const twocolumn = option(options, /^twocolumn$/);
  const pageWidth = a4 ? 595 : 612;
  let textWidth = twocolumn ? 469 : { 10: 345, 11: 360, 12: 390 }[size] ?? 345;
  // geometry's margins, when the preamble sets them.
  const geometry = /\\(?:usepackage\s*\[([^\]]*)\]\s*\{geometry\}|geometry\s*\{([^}]*)\})/.exec(src);
  const settings = geometry?.[1] ?? geometry?.[2];
  if (settings) {
    const length = (value: string | undefined) => {
      const match = value ? /([\d.]+)\s*(in|cm|mm|pt)/.exec(value) : null;
      return match ? Number(match[1]) * ({ in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1 } as Record<string, number>)[match[2]] : undefined;
    };
    const width = length(/textwidth\s*=\s*([^,]+)/.exec(settings)?.[1]);
    const margin = length(/(?:^|,)\s*(?:margin|hmargin|left)\s*=\s*([^,]+)/.exec(settings)?.[1]);
    if (width) textWidth = width;
    else if (margin) textWidth = pageWidth - 2 * margin;
  }
  return { template: 'article', columns: twocolumn ? 2 : 1, font, size, pageWidth, textWidth, columnGap: 10, citations };
}

/* ------------------------------------------------------------------ the bibliography */

export interface BibRecord {
  key: string;
  type: string;
  fields: Record<string, string>;
}

/** The fields of BibTeX entries: `name = {value}`, `"value"` or a bare word. */
export function parseBibRecords(text: string): BibRecord[] {
  const records: BibRecord[] = [];
  for (const match of text.matchAll(/@([A-Za-z]+)\s*[{(]\s*([^,\s]+)\s*,/g)) {
    const type = match[1].toLowerCase();
    if (type === 'string' || type === 'comment' || type === 'preamble') continue;
    const fields: Record<string, string> = {};
    let at = (match.index ?? 0) + match[0].length;
    for (;;) {
      const field = /^\s*([A-Za-z_-]+)\s*=\s*/.exec(text.slice(at));
      if (!field) break;
      at += field[0].length;
      let value = '';
      if (text[at] === '{') {
        let depth = 0;
        const start = at;
        for (; at < text.length; at += 1) {
          if (text[at] === '{') depth += 1;
          else if (text[at] === '}' && --depth === 0) break;
        }
        value = text.slice(start + 1, at);
        at += 1;
      } else if (text[at] === '"') {
        const end = text.indexOf('"', at + 1);
        value = text.slice(at + 1, end);
        at = end + 1;
      } else {
        const word = /^[^,}\s]+/.exec(text.slice(at))?.[0] ?? '';
        value = word;
        at += word.length;
      }
      fields[field[1].toLowerCase()] = value.replace(/\s+/g, ' ').trim();
      const comma = /^\s*,/.exec(text.slice(at));
      if (!comma) break;
      at += comma[0].length;
    }
    records.push({ key: match[2], type, fields });
  }
  return records;
}

/** Each author's last name, from "Last, First" or "First Last". */
export const lastNames = (authors: string): string[] =>
  authors
    .split(/\s+and\s+/)
    .map((name) => plainText(name))
    .filter(Boolean)
    .map((name) => (name.includes(',') ? name.split(',')[0].trim() : name.split(/\s+/).pop() ?? name));

/** "Smith", "Smith and Lee", "Smith et al." */
export function authorShort(record: BibRecord | undefined): string {
  const names = lastNames(record?.fields.author ?? record?.fields.editor ?? '');
  if (names.length === 0) return plainText(record?.fields.title ?? record?.key ?? '?');
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

/** An entry as the list of references prints it, roughly. */
export function referenceText(record: BibRecord): string {
  const field = (name: string) => plainText(record.fields[name] ?? '');
  const authors = (record.fields.author ?? '')
    .split(/\s+and\s+/)
    .map((name) => plainText(name))
    .filter(Boolean)
    .map((name) => (name.includes(',') ? `${name.split(',').slice(1).join(',').trim()} ${name.split(',')[0].trim()}` : name));
  const who = authors.length > 2 ? `${authors.slice(0, -1).join(', ')}, and ${authors[authors.length - 1]}` : authors.join(' and ');
  const venue = field('journal') || field('booktitle') || field('publisher') || field('school') || field('institution') || (record.fields.eprint ? `arXiv:${field('eprint')}` : '') || field('howpublished');
  const parts = [who, field('title'), [venue, field('volume') && `${field('volume')}`, field('pages') && `pp. ${field('pages').replace(/--/g, '–')}`].filter(Boolean).join(', '), field('year')];
  return parts.filter(Boolean).map((part) => part.replace(/\.$/, '')).join('. ') + '.';
}

/* ------------------------------------------------------------------ numbers */

export interface Numbering {
  /** What each numbered element shows: "2.1" for a heading, "3" for a figure, "(4)" without parentheses for an equation. */
  numbers: Map<Element, string>;
  /** What \ref shows for each label. */
  labels: Record<string, string>;
  /** What each cited key shows: its number, or its author and year. */
  citations: Record<string, { number?: number; author: string; year: string }>;
  /** The references cited, in the order the list prints them. */
  references: { key: string; text: string; number?: number }[];
}

const roman = (n: number): string => {
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let rest = n;
  let out = '';
  for (const [value, letters] of table) while (rest >= value) {
    out += letters;
    rest -= value;
  }
  return out;
};
const letter = (n: number) => String.fromCharCode(64 + n);

const NUMERIC_IN_ORDER = /unsrt|ieee|acm|splncs|vancouver|nature|science/i;

/** Numbers for a paper's elements in order (each block's, with the labels set in its text), and its citations. */
export function numberPaper(blocks: { elements: Element[]; labels: LooseLabel[] }[], style: PaperStyle, bib: BibRecord[], bibliographyStyle = 'plain', theoremCounters: Record<string, string> = {}): Numbering {
  const numbers = new Map<Element, string>();
  const labels: Record<string, string> = {};
  const placed: { at: number; number: string }[] = [];
  const counters = [0, 0, 0, 0];
  let figures = 0;
  let tables = 0;
  let equations = 0;
  let appendix = false;
  const theorems: Record<string, number> = {};
  const cited: string[] = [];
  const cite = (keys: string[]) => keys.forEach((key) => !cited.includes(key) && cited.push(key));

  const sectionNumber = (level: number): string => {
    const parts = counters.slice(1, level + 1);
    const first = appendix ? letter(parts[0]) : style.template === 'ieee' ? roman(parts[0]) : String(parts[0]);
    if (style.template === 'ieee' && level === 2) return letter(parts[1]);
    if (style.template === 'ieee' && level === 3) return `${parts[2]})`;
    return [first, ...parts.slice(1).map(String)].join('.');
  };

  const visitInline = (items: import('./latexHtml').Inline[]) => {
    for (const item of items) {
      if (item.kind === 'cite') cite(item.keys);
      if (item.kind === 'footnote') visitInline(item.content);
    }
  };

  const visit = (element: Element) => {
    switch (element.kind) {
      case 'appendix':
        appendix = true;
        counters.fill(0);
        return;
      case 'heading': {
        visitInline(element.title);
        if (element.starred || element.level < 1 || element.level > 3) return;
        counters[element.level] += 1;
        for (let level = element.level + 1; level < counters.length; level += 1) counters[level] = 0;
        const number = sectionNumber(element.level);
        numbers.set(element, number);
        placed.push({ at: element.from, number });
        return;
      }
      case 'paragraph':
        visitInline(element.content);
        return;
      case 'equation': {
        if (!element.numbered) return;
        equations += 1;
        numbers.set(element, String(equations));
        for (const label of element.labels) labels[label] = String(equations);
        return;
      }
      case 'figure': {
        if (element.caption) visitInline(element.caption.content);
        if (!element.caption) return;
        figures += 1;
        numbers.set(element, String(figures));
        for (const label of element.labels) labels[label] = String(figures);
        return;
      }
      case 'table': {
        if (element.caption) visitInline(element.caption.content);
        for (const row of element.rows) for (const cell of row.cells) visitInline(cell.content);
        if (!element.caption) return;
        tables += 1;
        const number = style.template === 'ieee' ? roman(tables) : String(tables);
        numbers.set(element, number);
        for (const label of element.labels) labels[label] = number;
        return;
      }
      case 'list':
        element.items.forEach((item) => item.children.forEach(visit));
        return;
      case 'environment': {
        const counter = theoremCounters[element.name];
        if (counter) {
          theorems[counter] = (theorems[counter] ?? 0) + 1;
          const number = String(theorems[counter]);
          numbers.set(element, number);
          for (const label of element.labels) labels[label] = number;
        }
        if (element.title) visitInline(element.title);
        element.children.forEach(visit);
        return;
      }
      default:
    }
  };

  const loose: LooseLabel[] = [];
  for (const block of blocks) {
    block.elements.forEach(visit);
    loose.push(...block.labels);
  }
  // A label in running text names the last numbered heading before it.
  placed.sort((a, b) => a.at - b.at);
  for (const { label, at } of loose) {
    if (labels[label] !== undefined) continue;
    const owner = placed.filter((item) => item.at <= at).pop();
    if (owner) labels[label] = owner.number;
  }

  const records = new Map(bib.map((record) => [record.key, record]));
  const listed = cited.filter((key) => records.has(key));
  if (!NUMERIC_IN_ORDER.test(bibliographyStyle) || style.citations === 'author-year') {
    listed.sort((a, b) => authorShort(records.get(a)).localeCompare(authorShort(records.get(b))) || (records.get(a)?.fields.year ?? '').localeCompare(records.get(b)?.fields.year ?? ''));
  }
  const citations: Numbering['citations'] = {};
  listed.forEach((key, index) => {
    const record = records.get(key);
    citations[key] = { ...(style.citations === 'numeric' ? { number: index + 1 } : {}), author: authorShort(record), year: plainText(record?.fields.year ?? '') };
  });
  const references = listed.map((key, index) => ({ key, text: referenceText(records.get(key)!), ...(style.citations === 'numeric' ? { number: index + 1 } : {}) }));
  return { numbers, labels, citations, references };
}

/** What a citation command shows. */
export function citationText(command: string, keys: string[], numbering: Numbering, style: PaperStyle, pre?: string, post?: string): string {
  const found = keys.map((key) => numbering.citations[key]);
  const note = (text: string) => [pre && plainText(pre), text, post && plainText(post)].filter(Boolean).join(post ? ', ' : ' ').replace(/ , /, ', ');
  if (style.citations === 'numeric') {
    const shown = found.map((item) => (item?.number !== undefined ? String(item.number) : '?')).join(', ');
    if (command === 'citeauthor') return found.map((item) => item?.author ?? '?').join(', ');
    if (command === 'citet' || command === 'textcite') return found.map((item) => `${item?.author ?? '?'} [${item?.number ?? '?'}]`).join(', ');
    return `[${note(shown)}]`;
  }
  const each = (item: (typeof found)[number]) => (item ? `${item.author}, ${item.year}` : '?');
  switch (command) {
    case 'citeauthor':
      return found.map((item) => item?.author ?? '?').join(', ');
    case 'citeyear':
      return found.map((item) => item?.year ?? '?').join(', ');
    case 'citeyearpar':
      return `(${found.map((item) => item?.year ?? '?').join(', ')})`;
    case 'citealp':
    case 'citealt':
      return note(found.map(each).join('; '));
    case 'citep':
    case 'parencite':
    case 'autocite':
      return `(${note(found.map(each).join('; '))})`;
    default:
      // \cite and \citet: "Smith et al. (2020)".
      return found.map((item) => (item ? `${item.author} (${item.year})` : '?')).join('; ') + (post ? ` (${plainText(post)})` : '');
  }
}
