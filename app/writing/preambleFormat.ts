/**
 * The preamble, loaded once. Loading a paper's packages costs pdfTeX more than setting ten pages of its text, and
 * the preamble rarely changes while the text is being written. So LaTeX and the preamble are dumped into a format
 * of their own, in a second engine beside the one that compiles, and compiles of the same preamble load that
 * format and start at \begin{document}'s side of it. Until the format is ready, and for a preamble that cannot
 * be dumped, the paper compiles whole as before.
 *
 * The preamble's lines become comment lines in main.tex, so its line numbers stay what they were. pdfTeX makes
 * its colour stack anew in every run, so the last of them starts it the way the preamble did in a whole run.
 */
import { hashText } from '../../editor/results/numbering';
import { startFormatBuilder, type FormatBuilder, type TexFormat } from '../../editor/tex/engine';
import type { FullDocument } from './document';

type Files = Record<string, string | Uint8Array>;

interface Entry {
  source: string;
  /** The working directory's files the preamble read, as they were. */
  deps: [string, string | Uint8Array][];
  format: TexFormat;
}

/** Formats kept: the preamble now and the one before it (each is some 10 MB). */
const KEEP = 2;
/** The builder's worker is let go after this long without a build. */
const BUILDER_IDLE_MS = 60_000;
/** Files the preamble may read itself; the others (pictures, data) cannot change what it defines. */
const TEX_FILE = /\.(tex|sty|cls|def|cfg|clo|fd|ltx)$/i;
/**
 * What a format cannot carry: the job's name is "pdflatex" while the format is built, and files opened for
 * writing (\makeindex, \makeglossaries) are closed by the dump.
 */
const UNSAFE_SOURCE = /\\(jobname|makeindex|makeglossaries|openout)(?![A-Za-z@])/;

/** Starts the colour stack before the first page, as the preamble's colour commands do in a whole run. */
const COLOR_STACK = String.raw`\makeatletter\ifdefined\@pdfcolorstack\pdfcolorstack\@pdfcolorstack current\fi\makeatother`;
/** A preamble that sets a colour for the text (\color at its top level) pushes it in the build, not in each run. */
const COLOR_CHECK = String.raw`\makeatletter\ifx\current@color\@undefined\else\def\lemma@black{0 g 0 G}\ifx\current@color\lemma@black\else\errmessage{The preamble sets a colour}\fi\fi\makeatother`;

let entries: Entry[] = [];
const failed = new Set<string>();
let wanted: { source: string; files: Files; key: string } | null = null;
let building = false;
let builder: Promise<FormatBuilder> | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

/** The lines of main.tex a format can hold (the class and the paper's preamble), and main.tex without them. */
export function splitForFormat(doc: FullDocument): { source: string; main: string } {
  const lines = doc.main.split('\n');
  const count = doc.preambleStart - 1 + doc.preambleLines;
  return {
    source: lines.slice(0, count).join('\n'),
    main: [...lines.slice(0, count - 1).map(() => '%'), COLOR_STACK, ...lines.slice(count)].join('\n'),
  };
}

function sameContent(a: string | Uint8Array | undefined, b: string | Uint8Array): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (!a || a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

const decoder = new TextDecoder();

function fits(entry: Entry, source: string, files: Files): boolean {
  return entry.source === source && entry.deps.every(([path, content]) => sameContent(files[path], content));
}

/** Names the preamble and the TeX files it could read, for remembering a preamble that cannot be dumped. */
function keyOf(source: string, files: Files): string {
  const texFiles = Object.keys(files)
    .filter((path) => TEX_FILE.test(path))
    .sort()
    .map((path) => {
      const content = files[path];
      return `${path}\0${typeof content === 'string' ? content : decoder.decode(content)}`;
    });
  return hashText([source, ...texFiles].join('\0'));
}

/** The working directory's files a run read, from its log: "(./name" as pdfTeX opens each. */
export function filesRead(log: string, files: Files): string[] {
  const read = new Set<string>();
  // pdfTeX breaks the log's lines at 79 characters, names included: read it with the breaks and without.
  for (const text of [log, log.replace(/\n/g, '')]) {
    for (const match of text.matchAll(/\(\.\/([^\s()]+)/g)) if (files[match[1]] !== undefined) read.add(match[1]);
  }
  return [...read];
}

/** Whether a build's log says the format holds what the preamble meant. */
export function cleanBuild(log: string): boolean {
  return !/^! /m.test(log) && !/\\openout/.test(log);
}

/**
 * The format for this preamble when one is ready; otherwise none, and one is built for it in the background
 * (the latest preamble asked for, one at a time).
 */
export function preambleFormat(source: string, files: Files): TexFormat | undefined {
  const entry = entries.find((item) => fits(item, source, files));
  if (entry) {
    entries = [entry, ...entries.filter((item) => item !== entry)];
    return entry.format;
  }
  if (UNSAFE_SOURCE.test(source)) return undefined;
  const key = keyOf(source, files);
  if (!failed.has(key)) {
    wanted = { source, files, key };
    void pump();
  }
  return undefined;
}

/** A format whose compile failed where the whole paper compiled: it is not used or built again. */
export function rejectFormat(format: TexFormat): void {
  const entry = entries.find((item) => item.format === format);
  if (!entry) return;
  entries = entries.filter((item) => item !== entry);
  failed.add(entry.format.id);
}

async function pump(): Promise<void> {
  if (building) return;
  building = true;
  clearTimeout(idle);
  try {
    while (wanted) {
      const { source, files, key } = wanted;
      wanted = null;
      if (failed.has(key) || entries.some((item) => fits(item, source, files))) continue;
      builder ??= startFormatBuilder();
      let data: Uint8Array | undefined;
      let log = '';
      try {
        ({ data, log } = await (await builder).build(`${source}\n${COLOR_CHECK}`, files));
      } catch {
        data = undefined;
      }
      if (!data || !cleanBuild(log)) {
        failed.add(key);
        // A failed build may have left the worker unusable; the next build starts a new one.
        letBuilderGo();
        continue;
      }
      const deps = filesRead(log, files).map((path): [string, string | Uint8Array] => [path, files[path]]);
      entries = [{ source, deps, format: { id: key, data } }, ...entries].slice(0, KEEP);
    }
  } finally {
    building = false;
    idle = setTimeout(letBuilderGo, BUILDER_IDLE_MS);
  }
}

function letBuilderGo(): void {
  const current = builder;
  builder = null;
  current?.then((engine) => engine.dispose()).catch(() => undefined);
}
