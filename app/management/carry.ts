/**
 * Carrying a figure or table from one paper to another (Management, phase 2 and 3): what else it needs there
 * (attachments, preamble definitions, packages, bibliography entries), how its attachment paths change, and how
 * a copy compares with the block it came from.
 */
import { bibKeysOf, parseBibEntries } from '../../editor/results/bibtex';
import { citedKeys } from '../../editor/results/numbering';
import { stripComments } from '../../editor/tex/document';
import { BlockOrigin, ResultBlock, ResultPaper, SyncState } from '../../types';
import { labelsOf } from './results';

/* ------------------------------------------------------------------ attachments */

const bare = (value: string): string => value.trim().replace(/^\.\//, '').replace(/\.[A-Za-z0-9]+$/, '');

/** The braced arguments of a source that could name a file: no spaces, no backslash. */
function fileArguments(source: string): string[] {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(/\{([^{}\\\s,]+)\}/g)) found.add(match[1]);
  return [...found];
}

/** Whether an argument names an attachment: the same path with or without its extension. */
export const namesFile = (argument: string, name: string): boolean => bare(argument) === bare(name);

/** The attachments of `files` a source names, each with the argument that names it. */
export function filesUsed(source: string, files: string[]): { argument: string; name: string }[] {
  return fileArguments(source).flatMap((argument) => {
    const name = files.find((file) => namesFile(argument, file));
    return name ? [{ argument, name }] : [];
  });
}

/** A source with its file arguments renamed: `{a}` → `{b}` for each entry of the mapping. */
export function mapArguments(source: string, mapping: Record<string, string>): string {
  if (Object.keys(mapping).length === 0) return source;
  return source.replace(/\{([^{}\\\s,]+)\}/g, (whole, argument: string) => (argument in mapping ? `{${mapping[argument]}}` : whole));
}

/** The mapping the other way. */
export const inverse = (mapping: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(mapping).map(([from, to]) => [to, from]));

/** A folder name from a paper's slug, for attachments that would clash. */
const folderOf = (paper: Pick<ResultPaper, 'slug' | 'id'>): string => (paper.slug || paper.id).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'imported';

export interface FileCopy {
  /** The attachment's name in the paper it comes from. */
  from: string;
  /** Its name in the paper it goes to. */
  to: string;
}

/**
 * The attachments a source needs that the target lacks: each named file of `from` that the target does not have
 * with the same content. One the target has under the same name with other content is copied into a folder named
 * after the source paper, and the source's argument is renamed to it (`mapping`, from's arguments → to's).
 */
export function planFiles(
  source: string,
  from: Pick<ResultPaper, 'slug' | 'id' | 'files' | 'fileHashes'>,
  to: Pick<ResultPaper, 'files' | 'fileHashes'>,
  mapping: Record<string, string> = {},
): { copies: FileCopy[]; mapping: Record<string, string> } {
  const copies: FileCopy[] = [];
  const next = { ...mapping };
  const targetFiles = to.files ?? [];
  for (const { argument, name } of filesUsed(source, from.files ?? [])) {
    const renamed = next[argument];
    const wanted = renamed ? name.replace(bare(argument), bare(renamed)) : name;
    const there = targetFiles.find((file) => file === wanted);
    const same = there !== undefined && from.fileHashes?.[name] !== undefined && from.fileHashes[name] === to.fileHashes?.[there];
    if (same) continue;
    if (there === undefined) {
      if (!copies.some((copy) => copy.to === wanted)) copies.push({ from: name, to: wanted });
      continue;
    }
    // The name is taken by another file: a folder of its own, and the source names it there.
    const folder = folderOf(from);
    const target = `${folder}/${name}`;
    const writtenTarget = `${folder}/${argument}`;
    const clash = targetFiles.includes(target) && from.fileHashes?.[name] !== undefined && from.fileHashes[name] === to.fileHashes?.[target];
    next[argument] = writtenTarget;
    if (!clash && !copies.some((copy) => copy.to === target)) copies.push({ from: name, to: target });
  }
  return { copies, mapping: next };
}

/* ------------------------------------------------------------------ preamble */

/** How many braced groups each defining command takes, its name counted when braced. */
const DEFINERS: Record<string, number> = {
  newcommand: 2,
  renewcommand: 2,
  providecommand: 2,
  DeclareRobustCommand: 2,
  DeclareMathOperator: 2,
  newenvironment: 3,
  renewenvironment: 3,
  definecolor: 3,
  colorlet: 2,
  newcolumntype: 2,
  def: 1,
  gdef: 1,
  edef: 1,
  xdef: 1,
};

export interface Definition {
  kind: 'command' | 'environment' | 'color' | 'column';
  name: string;
  text: string;
}

/** The end of the group opening at `at` ("{" or "["), or -1. */
function groupEnd(text: string, at: number): number {
  const open = text[at];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const skipSpace = (text: string, at: number): number => {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
};

/** The definitions a preamble makes with \newcommand, \def, \definecolor, \newcolumntype and their kin. */
export function definitionsOf(preamble: string): Definition[] {
  const text = stripComments(preamble);
  const found: Definition[] = [];
  const pattern = new RegExp(`\\\\(${Object.keys(DEFINERS).join('|')})(?![A-Za-z])\\*?`, 'g');
  for (const match of text.matchAll(pattern)) {
    const definer = match[1];
    const start = match.index ?? 0;
    let at = skipSpace(text, start + match[0].length);
    let name = '';
    let braces = DEFINERS[definer];
    if (text[at] === '{') {
      const end = groupEnd(text, at);
      if (end < 0) continue;
      name = text.slice(at + 1, end - 1).trim();
      at = end;
      braces -= 1;
    } else if (text[at] === '\\') {
      name = /^\\([A-Za-z@]+|.)/.exec(text.slice(at))?.[0] ?? '';
      at += name.length;
      if (definer !== 'def' && definer !== 'gdef' && definer !== 'edef' && definer !== 'xdef') braces -= 1;
    } else if (definer === 'newcolumntype' && /\S/.test(text[at] ?? '')) {
      name = text[at];
      at += 1;
      braces -= 1;
    } else continue;
    // \def\name#1#2{…}: the parameter text up to the body.
    if (DEFINERS[definer] === 1) {
      while (at < text.length && text[at] !== '{') at += 1;
    }
    let ok = true;
    while (braces > 0) {
      at = skipSpace(text, at);
      if (text[at] === '[') {
        const end = groupEnd(text, at);
        if (end < 0) {
          ok = false;
          break;
        }
        at = end;
        continue;
      }
      if (text[at] !== '{') {
        ok = false;
        break;
      }
      const end = groupEnd(text, at);
      if (end < 0) {
        ok = false;
        break;
      }
      at = end;
      braces -= 1;
    }
    if (!ok || !name) continue;
    const kind = definer.endsWith('environment') ? 'environment' : definer === 'definecolor' || definer === 'colorlet' ? 'color' : definer === 'newcolumntype' ? 'column' : 'command';
    found.push({ kind, name: kind === 'command' ? name.replace(/^\\/, '') : name, text: text.slice(start, at).trim() });
  }
  return found;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The column specifications of a source's tabulars, where a \newcolumntype is used. */
const columnSpecs = (source: string): string =>
  [...source.matchAll(/\\begin\s*\{(?:tabular\*?|tabularx|tabulary|longtable|array|tblr)\}\s*(?:\{[^{}]*\}\s*)?(?:\[[^\]]*\]\s*)?\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
    .map((match) => match[1])
    .join(' ');

/** Whether a source uses a definition. */
export function uses(source: string, definition: Definition): boolean {
  const name = escapeRegExp(definition.name);
  switch (definition.kind) {
    case 'command':
      return new RegExp(`\\\\${name}(?![A-Za-z@])`).test(source);
    case 'environment':
      return new RegExp(`\\\\begin\\s*\\{${name}\\}`).test(source);
    case 'color':
      return new RegExp(`(^|[{,!=\\s])${name}($|[}!,\\s])`).test(source.replace(/\\[A-Za-z]+/g, ' '));
    case 'column':
      return columnSpecs(source).includes(definition.name);
  }
}

/** Packages a preamble loads, each with the line that loads it (one package per line). */
export function packagesOf(preamble: string): { name: string; line: string }[] {
  const found: { name: string; line: string }[] = [];
  for (const match of stripComments(preamble).matchAll(/\\(?:usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const name of match[2].split(',').map((item) => item.trim()).filter(Boolean)) {
      if (!found.some((item) => item.name === name)) found.push({ name, line: `\\usepackage${match[1] ?? ''}{${name}}` });
    }
  }
  return found;
}

/** Packages that typeset what figures and tables hold; others (fonts, page layout, a template's own) change the whole paper. */
const CONTENT_PACKAGES = new Set([
  'booktabs', 'multirow', 'makecell', 'xcolor', 'colortbl', 'siunitx', 'pgfplots', 'tikz', 'subcaption', 'subfig', 'graphicx',
  'amsmath', 'amssymb', 'amsfonts', 'mathtools', 'bm', 'threeparttable', 'tabularx', 'tabulary', 'array', 'diagbox', 'adjustbox',
  'pifont', 'rotating', 'longtable', 'wrapfig', 'dcolumn', 'arydshln', 'hhline', 'tabu', 'tabularray', 'nicematrix', 'float',
  'placeins', 'xspace', 'url', 'pgfplotstable', 'circledsteps', 'utfsym', 'fontawesome5', 'bbding', 'marvosym', 'wasysym',
]);

export interface PackageNeed {
  name: string;
  line: string;
  /** Whether to add it unless the person says otherwise: packages for content, not for the page. */
  suggested: boolean;
}

/**
 * What the target's preamble lacks for a source from another paper: the definitions it uses (and those they use)
 * that only the source paper's preamble makes, and the packages only that preamble loads.
 */
export function preambleNeeds(source: string, fromPreamble: string, toPreamble: string): { definitions: Definition[]; packages: PackageNeed[] } {
  const theirs = definitionsOf(fromPreamble);
  const ours = definitionsOf(toPreamble);
  const known = (definition: Definition) => ours.some((item) => item.kind === definition.kind && item.name === definition.name);
  const needed: Definition[] = [];
  let pending = stripComments(source);
  // Definitions bring the ones they use in turn.
  for (let round = 0; round < 10 && pending; round += 1) {
    const found = theirs.filter((definition) => !known(definition) && !needed.includes(definition) && uses(pending, definition));
    needed.push(...found);
    pending = found.map((definition) => definition.text).join('\n');
  }
  const loaded = new Set(packagesOf(toPreamble).map((item) => item.name));
  const packages = packagesOf(fromPreamble)
    .filter((item) => !loaded.has(item.name))
    .map((item) => ({ ...item, suggested: CONTENT_PACKAGES.has(item.name) }));
  // In the order the source paper defines them.
  return { definitions: theirs.filter((definition) => needed.includes(definition)), packages };
}

/** A preamble with lines added before \begin{document}'s end of preamble, i.e. at its end, under a comment. */
export function withPreambleLines(preamble: string, lines: string[], note: string): string {
  if (lines.length === 0) return preamble;
  const base = preamble.replace(/\s+$/, '');
  return `${base}\n\n% ${note}\n${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ labels and citations */

/** The labels a source defines that blocks of the target already define. */
export function labelClashes(source: string, target: Pick<ResultPaper, 'blocks'>, except?: string): string[] {
  const mine = labelsOf({ id: '', kind: 'text', source });
  const taken = new Set(target.blocks.filter((block) => block.id !== except).flatMap(labelsOf));
  return mine.filter((label) => taken.has(label));
}

/** The bibliography entries a source cites that the target's .bib lacks and the source paper's .bib has, as text. */
export function bibNeeds(source: string, fromBib: string, toBib: string): { keys: string[]; text: string } {
  const have = bibKeysOf(toBib);
  const wanted = citedKeys(source).filter((key) => !have.has(key));
  const entries = parseBibEntries(fromBib).filter((entry) => wanted.includes(entry.key));
  const keys = [...new Set(entries.map((entry) => entry.key))];
  return { keys, text: keys.map((key) => entries.find((entry) => entry.key === key)!.text.trim()).join('\n\n') };
}

/* ------------------------------------------------------------------ copies and the blocks they come from */

export type { SyncState };

/** Where a copy's block lives now, if it still does. */
export function homeOf(origin: BlockOrigin, papers: ResultPaper[]): { paper: ResultPaper; block: ResultBlock } | null {
  const paper = papers.find((item) => item.id === origin.paper);
  const block = paper?.blocks.find((item) => item.id === origin.block);
  return paper && block ? { paper, block } : null;
}

const normal = (source = ''): string => source.replace(/\s+$/, '');

/** How a copy compares with its home: both are compared with the source the copy last took from it or gave it. */
export function syncState(copy: ResultBlock, papers: ResultPaper[]): SyncState | null {
  const origin = copy.origin;
  if (!origin) return null;
  const home = homeOf(origin, papers);
  if (!home) return 'orphan';
  const theirs = normal(mapArguments(home.block.source ?? '', origin.files ?? {}));
  const mine = normal(copy.source);
  const base = normal(origin.base);
  if (mine === theirs) return 'synced';
  if (mine === base) return 'behind';
  if (theirs === base) return 'ahead';
  return 'diverged';
}

/** The home's source as the copy writes it (its attachments under their names in the copy's paper). */
export const homeSource = (origin: BlockOrigin, home: ResultBlock): string => mapArguments(home.source ?? '', origin.files ?? {});

/** The copy's source as its home writes it. */
export const sourceForHome = (origin: BlockOrigin, source: string): string => mapArguments(source, inverse(origin.files ?? {}));

/** The copies of a block in the given papers: each paper and block whose origin names it. */
export function copiesOf(paperId: string, blockId: string, papers: ResultPaper[]): { paper: ResultPaper; block: ResultBlock }[] {
  return papers.flatMap((paper) =>
    paper.blocks.filter((block) => block.origin?.paper === paperId && block.origin.block === blockId).map((block) => ({ paper, block })),
  );
}

/* ------------------------------------------------------------------ three-way merge */

/** The longest common subsequence of two lists of lines, as pairs of indices. */
function commonLines(a: string[], b: string[]): [number, number][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

export interface MergeResult {
  text: string;
  /** How many places both sides changed differently, written with conflict markers. */
  conflicts: number;
}

/**
 * A three-way merge by lines (diff3): changes made on one side only are taken; where both sides changed the same
 * lines differently, both versions are written between git's conflict markers, this paper's first.
 */
export function mergeThree(base: string, mine: string, theirs: string, labels = { mine: 'this paper', theirs: 'library' }): MergeResult {
  const o = base.split('\n');
  const a = mine.split('\n');
  const b = theirs.split('\n');
  // Lines of the base kept unchanged on both sides anchor the merge.
  const inA = new Map(commonLines(o, a));
  const inB = new Map(commonLines(o, b));
  const anchors: [number, number, number][] = [];
  for (let i = 0; i < o.length; i += 1) {
    const ia = inA.get(i);
    const ib = inB.get(i);
    if (ia !== undefined && ib !== undefined) anchors.push([i, ia, ib]);
  }
  anchors.push([o.length, a.length, b.length]);
  const out: string[] = [];
  let conflicts = 0;
  let po = 0;
  let pa = 0;
  let pb = 0;
  for (const [io, ia, ib] of anchors) {
    const chunkO = o.slice(po, io);
    const chunkA = a.slice(pa, ia);
    const chunkB = b.slice(pb, ib);
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, k) => line === y[k]);
    if (same(chunkA, chunkO)) out.push(...chunkB);
    else if (same(chunkB, chunkO) || same(chunkA, chunkB)) out.push(...chunkA);
    else {
      conflicts += 1;
      out.push(`<<<<<<< ${labels.mine}`, ...chunkA, '=======', ...chunkB, `>>>>>>> ${labels.theirs}`);
    }
    if (io < o.length) out.push(o[io]);
    po = io + 1;
    pa = ia + 1;
    pb = ib + 1;
  }
  return { text: out.join('\n'), conflicts };
}

/** Two texts line by line: lines both have, lines only the first has ('del'), lines only the second has ('add'). */
export function diffLines(from: string, to: string): { kind: 'same' | 'del' | 'add'; text: string }[] {
  const a = from.split('\n');
  const b = to.split('\n');
  const out: { kind: 'same' | 'del' | 'add'; text: string }[] = [];
  let i = 0;
  let j = 0;
  for (const [ia, ib] of [...commonLines(a, b), [a.length, b.length] as [number, number]]) {
    while (i < ia) out.push({ kind: 'del', text: a[i++] });
    while (j < ib) out.push({ kind: 'add', text: b[j++] });
    if (ia < a.length) out.push({ kind: 'same', text: a[ia] });
    i = ia + 1;
    j = ib + 1;
  }
  return out;
}
