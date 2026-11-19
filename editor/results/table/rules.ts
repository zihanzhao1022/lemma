/**
 * Rules a table keeps: colours from a colour scale, the best and second-best numbers marked, numbers written with a
 * set number of decimals. The rules are kept in the table's own LaTeX, on one comment line, and work on the LaTeX
 * as it is: they read the tabular's rows and cells, find the number each cell starts with, and rewrite only what
 * they own there (the cell's \cellcolor, a \textbf or \underline around the number, the digits). Everything else in
 * the table stays as written, so tables the visual editor cannot read (\cmidrule(lr), @{...} columns, \resizebox
 * around them) take rules as well. A rule left out leaves those parts of the cells alone.
 */

export type Direction = 'higher' | 'lower';
export type Mark = 'bold' | 'underline' | 'none';

/** Rows and columns a rule covers, by their place in the tabular (rows counted from the first, header rows too); null for all. */
export interface Region {
  rows: number[] | null;
  cols: number[] | null;
}

/** What a cell's number is set against. */
export type Reference =
  | { kind: 'none' }
  | { kind: 'value'; value: number }
  /** One row, found by the text of its first cell (`label`) and else by its place. */
  | { kind: 'row'; row: number; label?: string }
  /** The first row of each group (rows between full rules: \midrule, \hline) that has a number in the column. */
  | { kind: 'group' }
  | { kind: 'column'; col: number };

/** Colours as xcolor names (e.g. one the preamble defines) or #RRGGBB. */
export type Palette =
  /** Better than the reference in one colour, worse in the other, each mixed with white. */
  | { kind: 'diverging'; better: string; worse: string }
  /** One colour mixed with white. */
  | { kind: 'sequential'; color: string }
  /** A scale of several colours, written as exact colours. */
  | { kind: 'scale'; name: ScaleName };

export type ScaleName = 'viridis' | 'magma' | 'blues' | 'greens' | 'rdbu';

export interface ColorRule {
  region: Region;
  reference: Reference;
  palette: Palette;
  /**
   * How much colour (0–100, the share mixed with white). Against a reference: `base + slope·|difference|`, at most `max`,
   * none when equal. Without one: the lowest number gets `base`, the highest `max` (better = more colour).
   */
  base: number;
  slope: number;
  max: number;
  /** Without a reference: the lowest and highest numbers are taken in each column, or over the whole region. */
  span?: 'column' | 'region';
}

export interface RankRule {
  region: Region;
  /** Best of each column, or of each row. */
  by: 'column' | 'row';
  /** Each group of rows apart (between full rules), or the whole column at once. */
  withinGroups: boolean;
  best: Mark;
  second: Mark;
}

export interface FormatRule {
  region: Region;
  /** Decimals of the number, and of the ± part after it; null leaves them as written. */
  decimals: number | null;
  stdDecimals: number | null;
}

export interface TableRules {
  /** By column (its place): which way is better. Columns left out: higher. */
  directions: Record<string, Direction>;
  color?: ColorRule;
  rank?: RankRule;
  format?: FormatRule;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/* ------------------------------------------------------------------ the rule line */

const RULE_LINE = /^[ \t]*%[ \t]*onizukatex-table-rules[ \t]+(\{.*\})[ \t]*$/m;
const RULE_PREFIX = '% onizukatex-table-rules ';

const isRegion = (value: unknown): value is Region => {
  if (!value || typeof value !== 'object') return false;
  const { rows, cols } = value as Region;
  const list = (items: unknown) => items === null || (Array.isArray(items) && items.every((item) => Number.isInteger(item) && item >= 0));
  return list(rows) && list(cols);
};

/** The rules a table's LaTeX keeps, or null when it keeps none (or they cannot be read). */
export function readRules(source: string): TableRules | null {
  const match = RULE_LINE.exec(source);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]) as Partial<TableRules>;
    const rules: TableRules = { directions: {} };
    if (raw.directions && typeof raw.directions === 'object') {
      for (const [col, direction] of Object.entries(raw.directions)) if (direction === 'higher' || direction === 'lower') rules.directions[col] = direction;
    }
    if (raw.color && isRegion(raw.color.region) && raw.color.reference && raw.color.palette) rules.color = raw.color;
    if (raw.rank && isRegion(raw.rank.region)) rules.rank = raw.rank;
    if (raw.format && isRegion(raw.format.region)) rules.format = raw.format;
    return rules;
  } catch {
    return null;
  }
}

/** The LaTeX with `rules` on its rule line (the first line), or without the line when null. */
export function writeRules(source: string, rules: TableRules | null): string {
  const without = source.replace(new RegExp(`${RULE_LINE.source}\\n?`, 'm'), '');
  if (!rules) return without;
  return `${RULE_PREFIX}${JSON.stringify(rules)}\n${without}`;
}

/* ------------------------------------------------------------------ reading the tabular */

export interface TableCellPlace {
  /** The cell's text, after the spaces before it, up to the spaces before the next & or \\. */
  from: number;
  to: number;
  col: number;
  span: number;
}

export interface TableRow {
  index: number;
  /** Rows between two full rules share a group. */
  group: number;
  cells: TableCellPlace[];
}

export interface TabularLayout {
  rows: TableRow[];
  columns: number;
}

const skipSpaces = (src: string, at: number, to: number): number => {
  let position = at;
  while (position < to) {
    if (/\s/.test(src[position])) position += 1;
    else if (src[position] === '%' && !escapedAt(src, position)) {
      const end = src.indexOf('\n', position);
      position = end < 0 || end > to ? to : end + 1;
    } else break;
  }
  return position;
};

function escapedAt(src: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && src[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** The index just past the group opened at `at` ({ or [), or -1. */
function groupEnd(src: string, at: number, to: number): number {
  const open = src[at];
  const close = open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : '';
  if (!close) return -1;
  let depth = 0;
  for (let i = at; i < to; i += 1) {
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
    if (open === '{' ? char === '{' : char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The arguments of the command at `at` named `name`, given how many {…} and whether [ ] and ( ) may come first. */
function commandEnd(src: string, at: number, to: number, args: number, optional = true): number {
  let position = at;
  for (;;) {
    const next = skipSpaces(src, position, to);
    if (optional && (src[next] === '[' || src[next] === '(')) {
      const end = groupEnd(src, next, to);
      if (end < 0) return -1;
      position = end;
    } else break;
  }
  for (let n = 0; n < args; n += 1) {
    const next = skipSpaces(src, position, to);
    if (src[next] !== '{') return -1;
    const end = groupEnd(src, next, to);
    if (end < 0) return -1;
    position = end;
  }
  return position;
}

/** Splits [from, to) at the separator (& or \\) where it stands outside braces and comments; each piece's range. */
function splitAt(src: string, from: number, to: number, separator: '&' | 'row'): { from: number; to: number; next: number }[] {
  const pieces: { from: number; to: number; next: number }[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const char = src[i];
    if (char === '%' && !escapedAt(src, i)) {
      const end = src.indexOf('\n', i);
      i = end < 0 || end > to ? to : end;
      continue;
    }
    if (char === '{' && !escapedAt(src, i)) depth += 1;
    else if (char === '}' && !escapedAt(src, i)) depth -= 1;
    if (depth !== 0) continue;
    if (separator === '&' && char === '&' && !escapedAt(src, i)) {
      pieces.push({ from: start, to: i, next: i + 1 });
      start = i + 1;
    } else if (separator === 'row' && char === '\\' && (src[i + 1] === '\\' || src.startsWith('\\tabularnewline', i)) && !escapedAt(src, i)) {
      let end = src[i + 1] === '\\' ? i + 2 : i + '\\tabularnewline'.length;
      // \\[2pt] and \\* belong to the row's end.
      if (src[end] === '*') end += 1;
      const spaced = skipSpaces(src, end, to);
      if (src[spaced] === '[') {
        const close = groupEnd(src, spaced, to);
        if (close > 0) end = close;
      }
      pieces.push({ from: start, to: i, next: end });
      start = end;
      i = end - 1;
    }
  }
  pieces.push({ from: start, to, next: to });
  return pieces;
}

const FULL_RULES = /^\\(toprule|midrule|bottomrule|hline|specialrule|Xhline)(?![A-Za-z@])/;
const ROW_COMMANDS = /^\\(cmidrule|cline|rowcolor|addlinespace|noalign|hhline|arrayrulecolor|rule)(?![A-Za-z@])/;
const ROW_COMMAND_ARGS: Record<string, number> = { cmidrule: 1, cline: 1, rowcolor: 1, addlinespace: 0, noalign: 1, hhline: 1, arrayrulecolor: 1, specialrule: 3, rule: 2 };

/** Where the tabular's rows are: [from, to) of its body, and how many columns its format has. */
function tabularBody(src: string): { from: number; to: number; columns: number } | null {
  const begin = /\\begin\s*\{(tabular\*?|tabularx|tabulary)\}/g;
  const found = [...src.matchAll(begin)].filter((match) => !inComment(src, match.index ?? 0));
  if (found.length !== 1) return null;
  const [match] = found;
  const name = match[1];
  let at = (match.index ?? 0) + match[0].length;
  const end = src.length;
  // tabular* and tabularx take a width first.
  if (name !== 'tabular') {
    const next = skipSpaces(src, at, end);
    const close = groupEnd(src, next, end);
    if (close < 0) return null;
    at = close;
  }
  let next = skipSpaces(src, at, end);
  if (src[next] === '[') {
    const close = groupEnd(src, next, end);
    if (close < 0) return null;
    next = skipSpaces(src, close, end);
  }
  if (src[next] !== '{') return null;
  const specEnd = groupEnd(src, next, end);
  if (specEnd < 0) return null;
  const columns = countColumns(src.slice(next + 1, specEnd - 1));
  const closing = new RegExp(`\\\\end\\s*\\{${name.replace('*', '\\*')}\\}`, 'g');
  closing.lastIndex = specEnd;
  let close: RegExpExecArray | null;
  while ((close = closing.exec(src)) && inComment(src, close.index));
  if (!close || columns < 1) return null;
  return { from: specEnd, to: close.index, columns };
}

function inComment(src: string, at: number): boolean {
  const line = src.slice(src.lastIndexOf('\n', at - 1) + 1, at);
  for (let i = 0; i < line.length; i += 1) if (line[i] === '%' && !escapedAt(line, i)) return true;
  return false;
}

/** How many columns a tabular format has: l, c, r, p{…}, m{…}, b{…}, X, S, *{n}{…}, leaving out @{…}, !{…}, >{…}, <{…} and |. */
export function countColumns(spec: string): number {
  let count = 0;
  for (let i = 0; i < spec.length; i += 1) {
    const char = spec[i];
    if (/\s|\|/.test(char)) continue;
    if ('@!><'.includes(char)) {
      const end = groupEnd(spec, skipSpaces(spec, i + 1, spec.length), spec.length);
      if (end < 0) return 0;
      i = end - 1;
      continue;
    }
    if (char === '*') {
      const first = skipSpaces(spec, i + 1, spec.length);
      const firstEnd = groupEnd(spec, first, spec.length);
      const second = skipSpaces(spec, firstEnd, spec.length);
      const secondEnd = groupEnd(spec, second, spec.length);
      if (firstEnd < 0 || secondEnd < 0) return 0;
      const times = Number(spec.slice(first + 1, firstEnd - 1).trim());
      count += (Number.isInteger(times) ? times : 1) * countColumns(spec.slice(second + 1, secondEnd - 1));
      i = secondEnd - 1;
      continue;
    }
    if ('pmbw'.includes(char)) {
      const open = skipSpaces(spec, i + 1, spec.length);
      const end = groupEnd(spec, open, spec.length);
      if (end < 0) return 0;
      // w{align}{width}
      if (char === 'w') {
        const again = skipSpaces(spec, end, spec.length);
        const second = groupEnd(spec, again, spec.length);
        i = (second < 0 ? end : second) - 1;
      } else i = end - 1;
      count += 1;
      continue;
    }
    if (char === 'S' && spec[skipSpaces(spec, i + 1, spec.length)] === '[') {
      const end = groupEnd(spec, skipSpaces(spec, i + 1, spec.length), spec.length);
      if (end < 0) return 0;
      i = end - 1;
      count += 1;
      continue;
    }
    if (/[A-Za-z]/.test(char)) count += 1;
  }
  return count;
}

/** The tabular's rows and their cells, or null when the LaTeX holds no single tabular this can read. */
export function readTabular(src: string): TabularLayout | null {
  const body = tabularBody(src);
  if (!body) return null;
  const rows: TableRow[] = [];
  let group = 0;
  for (const piece of splitAt(src, body.from, body.to, 'row')) {
    let at = piece.from;
    // Rules and row colours before the row's first cell.
    for (;;) {
      at = skipSpaces(src, at, piece.to);
      const rest = src.slice(at, Math.min(piece.to, at + 40));
      const full = FULL_RULES.exec(rest);
      const other = full ? null : ROW_COMMANDS.exec(rest);
      const found = full ?? other;
      if (!found) break;
      const name = found[1];
      const end = commandEnd(src, at + found[0].length, piece.to, name === 'specialrule' ? 3 : (ROW_COMMAND_ARGS[name] ?? 0));
      if (end < 0) return null;
      if (full && name !== 'bottomrule' && rows.length > 0) group += 1;
      at = end;
    }
    if (skipSpaces(src, at, piece.to) >= piece.to) continue;
    const cells: TableCellPlace[] = [];
    let col = 0;
    for (const part of splitAt(src, at, piece.to, '&')) {
      const from = skipSpaces(src, part.from, part.to);
      let to = part.to;
      while (to > from && /\s/.test(src[to - 1])) to -= 1;
      let span = 1;
      const multi = /^\\multicolumn\s*\{\s*(\d+)\s*\}/.exec(src.slice(from, from + 30));
      if (multi) span = Math.max(1, Number(multi[1]));
      cells.push({ from, to: Math.max(from, to), col, span });
      col += span;
    }
    rows.push({ index: rows.length, group, cells });
  }
  return rows.length ? { rows, columns: body.columns } : null;
}

/* ------------------------------------------------------------------ one cell's number */

/** A cell's content past \multicolumn{n}{fmt}{ and \multirow{n}{w}{, as a range. */
function cellContent(src: string, cell: TableCellPlace): { from: number; to: number } {
  let from = cell.from;
  let to = cell.to;
  for (const [name, args] of [['multicolumn', 2], ['multirow', 2]] as const) {
    const head = new RegExp(`^\\\\${name}(?![A-Za-z@])`).exec(src.slice(from, to));
    if (!head) continue;
    const before = commandEnd(src, from + head[0].length, to, args);
    if (before < 0) break;
    const open = skipSpaces(src, before, to);
    if (src[open] !== '{') break;
    const close = groupEnd(src, open, to);
    if (close < 0) break;
    from = skipSpaces(src, open + 1, close - 1);
    to = close - 1;
    while (to > from && /\s/.test(src[to - 1])) to -= 1;
  }
  return { from, to };
}

interface CellParts {
  /** \cellcolor[…]{…} at the start, or an empty range where one would go. */
  color: { from: number; to: number };
  /** \textbf{ … } / \underline{ … } around the number: the opening and the closing brace. */
  wrappers: { open: { from: number; to: number }; close: { from: number; to: number }; name: string }[];
  number: { from: number; to: number; text: string; value: number };
  std: { from: number; to: number; text: string; value: number } | null;
}

const NUMBER = /^[-+−]?(?:\d+(?:\.\d*)?|\.\d+)/;
const WRAPPERS = /^\\(textbf|underline|uline|mathbf|bm)\s*\{/;

function readCellParts(src: string, from: number, to: number): CellParts | null {
  let at = skipSpaces(src, from, to);
  let color = { from: at, to: at };
  const colorHead = /^\\cellcolor(?![A-Za-z@])/.exec(src.slice(at, to));
  if (colorHead) {
    const end = commandEnd(src, at + colorHead[0].length, to, 1);
    if (end < 0) return null;
    color = { from: at, to: end };
    at = skipSpaces(src, end, to);
  }
  const wrappers: CellParts['wrappers'] = [];
  for (let n = 0; n < 3; n += 1) {
    const wrap = WRAPPERS.exec(src.slice(at, to));
    if (!wrap) break;
    const brace = at + wrap[0].length - 1;
    const close = groupEnd(src, brace, to);
    if (close < 0) return null;
    wrappers.push({ open: { from: at, to: brace + 1 }, close: { from: close - 1, to: close }, name: wrap[1] });
    at = skipSpaces(src, brace + 1, close - 1);
  }
  const found = NUMBER.exec(src.slice(at, to));
  if (!found) return null;
  const value = Number(found[0].replace('−', '-'));
  if (!Number.isFinite(value)) return null;
  const number = { from: at, to: at + found[0].length, text: found[0], value };
  // A letter or digit right after it: not a number cell ("3B", "2nd").
  if (/[A-Za-z]/.test(src[number.to] ?? '')) return null;
  const tail = src.slice(number.to, to);
  const pm = /\\pm\s*\$?\s*\{?\s*((?:\d+(?:\.\d*)?|\.\d+))/.exec(tail);
  const std = pm ? { from: number.to + pm.index + pm[0].length - pm[1].length, to: number.to + pm.index + pm[0].length, text: pm[1], value: Number(pm[1]) } : null;
  return { color, wrappers, number, std };
}

/* ------------------------------------------------------------------ colours */

type RGB = [number, number, number];

const SCALES: Record<ScaleName, string[]> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
  blues: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  greens: ['#f7fcf5', '#c7e9c0', '#74c476', '#238b45', '#00441b'],
  rdbu: ['#b2182b', '#ef8a62', '#f7f7f7', '#67a9cf', '#2166ac'],
};

export const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];

const hexToRgb = (hex: string): RGB | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const rgbToHex = (rgb: RGB): string => rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('').toUpperCase();

/** A scale's colour at t (0–1), as RGB 0–255. */
export function scaleColor(name: ScaleName, t: number): RGB {
  const stops = SCALES[name].map((hex) => hexToRgb(hex)!);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const position = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const fraction = position - index;
  return stops[index].map((channel, i) => channel + (stops[index + 1][i] - channel) * fraction) as RGB;
}

const share = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return rounded.toFixed(1);
};

/** The \cellcolor for a colour mixed with white at `intensity` percent: by name as xcolor mixes it, or as an exact colour. */
function mixedColor(color: string, intensity: number): string {
  const amount = Math.min(100, Math.max(0, intensity));
  const rgb = hexToRgb(color);
  if (rgb) return `\\cellcolor[HTML]{${rgbToHex(rgb.map((channel) => 255 + (channel - 255) * (amount / 100)) as RGB)}}`;
  return `\\cellcolor{${color}!${share(amount)}!white}`;
}

/* ------------------------------------------------------------------ applying the rules */

const covers = (region: Region, row: number, col: number, span: number): boolean =>
  (region.rows === null || region.rows.includes(row)) &&
  (region.cols === null || Array.from({ length: span }, (_, n) => col + n).some((c) => region.cols!.includes(c)));

const round = (value: number, decimals: number) => Number(value.toFixed(decimals));

interface Found {
  row: TableRow;
  cell: TableCellPlace;
  parts: CellParts;
  /** The number as the cell will show it (after the format rule). */
  value: number;
}

/** The plain first-cell text of a row, to find a reference row by its name. */
export function rowLabel(src: string, row: TableRow): string {
  const first = row.cells[0];
  if (!first) return '';
  const { from, to } = cellContent(src, first);
  return src
    .slice(from, to)
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The edits that bring a table's LaTeX in line with its rules (those on its rule line, or `given`): none when it keeps
 * no rules or already is. Each edit is as small as it can be, so a caret elsewhere in the cell stays where it was.
 */
export function ruleEdits(src: string, given?: TableRules | null): Edit[] {
  const rules = given === undefined ? readRules(src) : given;
  if (!rules || (!rules.color && !rules.rank && !rules.format)) return [];
  const layout = readTabular(src);
  if (!layout) return [];
  const found: Found[] = [];
  for (const row of layout.rows) {
    for (const cell of row.cells) {
      const content = cellContent(src, cell);
      const parts = readCellParts(src, content.from, content.to);
      if (!parts) continue;
      const format = rules.format && covers(rules.format.region, row.index, cell.col, cell.span) ? rules.format : null;
      const value = format?.decimals !== null && format?.decimals !== undefined ? round(parts.number.value, format.decimals) : parts.number.value;
      found.push({ row, cell, parts, value });
    }
  }
  const at = (row: number, col: number) => found.find((item) => item.row.index === row && item.cell.col === col);
  const direction = (col: number): Direction => rules.directions[String(col)] ?? 'higher';

  /* colours */
  const colors = new Map<Found, string | null>();
  const color = rules.color;
  if (color) {
    const inRegion = found.filter((item) => covers(color.region, item.row.index, item.cell.col, item.cell.span));
    const reference = color.reference;
    let referenceRow: number | null = null;
    if (reference.kind === 'row') {
      const byLabel = reference.label ? layout.rows.find((row) => rowLabel(src, row) === reference.label) : undefined;
      referenceRow = byLabel ? byLabel.index : reference.row;
    }
    if (reference.kind === 'none') {
      // From the lowest to the highest number, in each column or over the region.
      const spanKey = (item: Found) => (color.span === 'region' ? 'all' : String(item.cell.col));
      const ranges = new Map<string, [number, number]>();
      for (const item of inRegion) {
        const key = spanKey(item);
        const range = ranges.get(key);
        ranges.set(key, range ? [Math.min(range[0], item.value), Math.max(range[1], item.value)] : [item.value, item.value]);
      }
      for (const item of inRegion) {
        const [low, high] = ranges.get(spanKey(item))!;
        let t = high > low ? (item.value - low) / (high - low) : 1;
        if (direction(item.cell.col) === 'lower') t = 1 - t;
        colors.set(item, paint(color, t, null));
      }
    } else {
      for (const item of inRegion) {
        let base: number | null = null;
        if (reference.kind === 'value') base = reference.value;
        else if (reference.kind === 'column') base = at(item.row.index, reference.col)?.value ?? null;
        else if (reference.kind === 'row') base = referenceRow === null ? null : at(referenceRow, item.cell.col)?.value ?? null;
        else if (reference.kind === 'group') {
          const first = found.find((other) => other.row.group === item.row.group && other.cell.col === item.cell.col);
          base = first ? first.value : null;
        }
        if (base === null) continue;
        const difference = item.value - base;
        if (Math.abs(difference) < 1e-9) {
          colors.set(item, null);
          continue;
        }
        const better = direction(item.cell.col) === 'higher' ? difference > 0 : difference < 0;
        const intensity = Math.min(color.max, color.base + color.slope * Math.abs(difference));
        colors.set(item, paint(color, intensity / 100, better));
      }
    }
  }

  /* best and second best */
  const marks = new Map<Found, Mark>();
  const rank = rules.rank;
  if (rank) {
    const inRegion = found.filter((item) => covers(rank.region, item.row.index, item.cell.col, item.cell.span));
    const sets = new Map<string, Found[]>();
    for (const item of inRegion) {
      const key = rank.by === 'column' ? `${item.cell.col}:${rank.withinGroups ? item.row.group : ''}` : `${item.row.index}`;
      sets.set(key, [...(sets.get(key) ?? []), item]);
    }
    for (const items of sets.values()) {
      for (const item of items) marks.set(item, 'none');
      if (items.length < 2) continue;
      const higher = rank.by === 'column' ? direction(items[0].cell.col) === 'higher' : true;
      const values = [...new Set(items.map((item) => item.value))].sort((a, b) => (higher ? b - a : a - b));
      for (const item of items) {
        if (item.value === values[0]) marks.set(item, rank.best);
        else if (values.length > 1 && item.value === values[1]) marks.set(item, rank.second);
      }
    }
  }

  /* writing the cells */
  const edits: Edit[] = [];
  for (const item of found) {
    const { parts } = item;
    const original = src.slice(parts.color.from, Math.max(parts.number.to, parts.std?.to ?? 0, ...parts.wrappers.map((wrapper) => wrapper.close.to)));
    const start = parts.color.from;
    const pieces: { from: number; to: number; insert: string }[] = [];
    if (colors.has(item)) pieces.push({ ...parts.color, insert: colors.get(item) ?? '' });
    const format = rules.format && covers(rules.format.region, item.row.index, item.cell.col, item.cell.span) ? rules.format : null;
    const numberText = format?.decimals !== null && format?.decimals !== undefined ? formatNumber(parts.number.text, item.value, format.decimals) : parts.number.text;
    if (marks.has(item)) {
      for (const wrapper of parts.wrappers) {
        pieces.push({ ...wrapper.open, insert: '' });
        pieces.push({ ...wrapper.close, insert: '' });
      }
      const mark = marks.get(item)!;
      const open = mark === 'bold' ? '\\textbf{' : mark === 'underline' ? '\\underline{' : '';
      pieces.push({ from: parts.number.from, to: parts.number.to, insert: `${open}${numberText}${open ? '}' : ''}` });
    } else if (numberText !== parts.number.text) {
      pieces.push({ from: parts.number.from, to: parts.number.to, insert: numberText });
    }
    if (parts.std && format?.stdDecimals !== null && format?.stdDecimals !== undefined) {
      const text = formatNumber(parts.std.text, parts.std.value, format.stdDecimals);
      if (text !== parts.std.text) pieces.push({ from: parts.std.from, to: parts.std.to, insert: text });
    }
    if (!pieces.length) continue;
    // The cell as the rules write it, then only the part that differs from what is there.
    pieces.sort((a, b) => a.from - b.from || a.to - b.to);
    let rewritten = '';
    let cursor = start;
    for (const piece of pieces) {
      rewritten += src.slice(cursor, piece.from) + piece.insert;
      cursor = Math.max(cursor, piece.to);
    }
    const end = start + original.length;
    rewritten += src.slice(cursor, end);
    const edit = smallest(src, start, end, rewritten);
    if (edit) edits.push(edit);
  }
  return edits.sort((a, b) => a.from - b.from);
}

function formatNumber(text: string, value: number, decimals: number): string {
  const sign = /^[+−]/.exec(text)?.[0];
  const formatted = Math.abs(value).toFixed(Math.max(0, Math.min(6, decimals)));
  if (value < 0) return `${sign === '−' ? '−' : '-'}${formatted}`;
  return `${sign === '+' ? '+' : ''}${formatted}`;
}

/** The colour a rule gives at `amount` (0–1): of the better or worse colour, or along the scale when `better` is null. */
function paint(rule: ColorRule, amount: number, better: boolean | null): string {
  const palette = rule.palette;
  if (better === null) {
    const intensity = rule.base + (rule.max - rule.base) * amount;
    if (palette.kind === 'scale') return `\\cellcolor[HTML]{${rgbToHex(scaleColor(palette.name, amount))}}`;
    return mixedColor(palette.kind === 'sequential' ? palette.color : palette.better, intensity);
  }
  const intensity = amount * 100;
  if (palette.kind === 'scale') {
    // Worse runs from the middle to one end, better to the other.
    const t = 0.5 + (better ? 1 : -1) * (intensity / 200);
    return `\\cellcolor[HTML]{${rgbToHex(scaleColor(palette.name, t))}}`;
  }
  if (palette.kind === 'sequential') return mixedColor(palette.color, better ? intensity : 0);
  return mixedColor(better ? palette.better : palette.worse, intensity);
}

/** [start, end) of `src` turned into `next`, as the one edit that changes least. */
function smallest(src: string, start: number, end: number, next: string): Edit | null {
  const old = src.slice(start, end);
  if (old === next) return null;
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return { from: start + head, to: end - tail, insert: next.slice(head, next.length - tail) };
}

/** Edits applied to a text, from the last to the first. */
export function applyEdits(src: string, edits: Edit[]): string {
  let text = src;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return text;
}

/** A table's LaTeX with its rules applied (unchanged when it keeps none). */
export function applyRules(src: string, given?: TableRules | null): string {
  return applyEdits(src, ruleEdits(src, given));
}

/* ------------------------------------------------------------------ for the panel */

export interface PreviewCell {
  row: number;
  col: number;
  span: number;
  /** The cell's text, roughly as it prints. */
  text: string;
  /** Its number, if it starts with one. */
  value: number | null;
  /** Its \cellcolor's colour expression (after the rules), if any. */
  color: string | null;
  mark: Mark;
}

/** The table's cells as the rules leave them, for drawing the panel's preview. */
export function previewTable(src: string, rules: TableRules | null): { rows: PreviewCell[][]; columns: number; groups: number[] } | null {
  const applied = rules ? applyRules(src, rules) : src;
  const layout = readTabular(applied);
  if (!layout) return null;
  return {
    columns: layout.columns,
    groups: layout.rows.map((row) => row.group),
    rows: layout.rows.map((row) =>
      row.cells.map((cell) => {
        const content = cellContent(applied, cell);
        const parts = readCellParts(applied, content.from, content.to);
        let color: string | null = null;
        let rest = applied.slice(content.from, content.to);
        const head = /^\s*\\cellcolor(\[[^\]]*\])?\{([^{}]*)\}/.exec(rest);
        if (head) {
          color = head[1] ? `${head[1].slice(1, -1)}:${head[2]}` : head[2];
          rest = rest.slice(head[0].length);
        }
        const mark: Mark = parts?.wrappers.some((wrapper) => wrapper.name === 'textbf' || wrapper.name === 'mathbf' || wrapper.name === 'bm')
          ? 'bold'
          : parts?.wrappers.some((wrapper) => wrapper.name === 'underline' || wrapper.name === 'uline')
            ? 'underline'
            : 'none';
        const text = rest
          .replace(/\\pm/g, '±')
          .replace(/\\%/g, '%')
          .replace(/\\(?:sdstyle|small|footnotesize|scriptsize|tiny|textbf|underline|textit|emph|mathbf|bm|text|textrm|textsc|uline)(?![A-Za-z@])/g, '')
          .replace(/\\(?:multicolumn|multirow)\s*\{[^{}]*\}\s*\{[^{}]*\}/g, '')
          .replace(/\\[A-Za-z@]+\*?/g, '')
          .replace(/[{}$~]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return { row: row.index, col: cell.col, span: cell.span, text, value: parts?.number.value ?? null, color, mark };
      }),
    ),
  };
}

/** The rules a table starts from: colours against each group's first row, in the paper's own two heat colours when it has them. */
export function defaultRules(preambleColors: string[]): TableRules {
  const better = preambleColors.includes('heatbluemid') ? 'heatbluemid' : '#5C8EDE';
  const worse = preambleColors.includes('heatredmid') ? 'heatredmid' : '#F2963C';
  return {
    directions: {},
    color: { region: { rows: null, cols: null }, reference: { kind: 'group' }, palette: { kind: 'diverging', better, worse }, base: 20, slope: 0.8, max: 100 },
  };
}
