/**
 * The paper typeset as one document, the way its page shows it: every shown block in order under its marker
 * line (as the writing view's main.tex), with the position marks that say where each line landed. Saving a
 * paper compiles it again when what it prints changed, and stores its PDF and marks for readers; whoever
 * edits the paper compiles it in the browser instead, hidden blocks included.
 */
import { REFERENCES_FILE } from './compile';
import { bibliographyStyle, packageSetsStyle } from './bibtex';
import { citedKeys, hashText } from './numbering';
import { DEFAULT_PREAMBLE } from '../tex/document';
import { Mark, bodyOf, fullDocument, parseMarks } from '../../app/writing/document';
import type { TexEngine } from '../tex/engine';
import { parseAuxCitations, parseAuxLabels, parseErrors } from '../tex/log';
import type { ResultArticle, ResultBlock, ResultPaper } from '../../types';

export { blockHeadingLines, bodyBlocks, packMarks, unpackMarks } from '../../app/writing/articleBlocks';
export type { ArticleBlock, PackedMark } from '../../app/writing/articleBlocks';
import { ArticleBlock, bodyBlocks, packMarks } from '../../app/writing/articleBlocks';

/** The blocks an article shows, in order: those with code, hidden ones only when asked for. */
const shown = (blocks: ResultBlock[], hidden: boolean) => blocks.filter((block) => block.source?.trim() && (hidden || !block.hidden));

/** main.tex of the article, and the lines (1-based, its marker line first) each block holds in it. */
export function articleBody(blocks: ResultBlock[], { hidden = false }: { hidden?: boolean } = {}): { body: string; blocks: ArticleBlock[] } {
  const body = bodyOf(shown(blocks, hidden));
  return { body, blocks: bodyBlocks(body) };
}

/** What the article printed depends on: the preamble, the shown blocks in order, and the attachments. */
export function articleHash(paper: ResultPaper): string {
  const blocks = shown(paper.blocks, false).map((block) => [block.id, block.kind, block.source]);
  const files = Object.entries(paper.fileHashes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return hashText(JSON.stringify([(paper.preamble ?? DEFAULT_PREAMBLE), blocks, files]));
}

export type CompiledArticle =
  | { ok: true; pdf: Uint8Array; marks: Mark[]; blocks: ArticleBlock[]; body: string }
  | { ok: false; message: string };

const references = (aux?: string) => JSON.stringify([parseAuxLabels(aux ?? ''), parseAuxCitations(aux ?? '')]);

/** Typesets the article; `hidden` keeps hidden blocks in it. */
export async function compileArticle(engine: TexEngine, paper: ResultPaper, files: Record<string, Uint8Array>, { hidden = false }: { hidden?: boolean } = {}): Promise<CompiledArticle> {
  const { body, blocks } = articleBody(paper.blocks, { hidden });
  if (blocks.length === 0) return { ok: false, message: 'empty' };
  const preamble = (paper.preamble ?? DEFAULT_PREAMBLE);
  const keys = citedKeys(body);
  const cites = files[REFERENCES_FILE] !== undefined && keys.length > 0;
  const doc = fullDocument(preamble, body, cites ? { style: packageSetsStyle(preamble, files) ? null : bibliographyStyle(paper), file: REFERENCES_FILE } : null);
  const pass = (aux: string | undefined, bbl: string | undefined, bibtex: boolean) =>
    engine.compile({
      main: doc.main,
      files: { ...files, ...(aux ? { 'main.aux': aux } : {}), ...(bbl && !bibtex ? { 'main.bbl': bbl } : {}) },
      bibtex,
      read: ['main.gpos', 'main.bbl'],
    });
  let out = await pass(undefined, undefined, cites);
  const bbl = cites ? out.written?.['main.bbl'] : undefined;
  // Like latexmk: again while the labels and citations a run read are not the ones it wrote.
  for (let run = 0; run < 2 && out.pdf && out.aux !== undefined; run += 1) {
    const next = await pass(out.aux, bbl, false);
    const settled = references(next.aux) === references(out.aux);
    if (next.pdf) out = next;
    if (settled) break;
  }
  if (!out.pdf) return { ok: false, message: parseErrors(out.log)[0]?.message ?? out.reason ?? 'no PDF' };
  return { ok: true, pdf: out.pdf, marks: parseMarks(out.written?.['main.gpos'] ?? ''), blocks, body };
}

export interface ArticleRebuild {
  /** The new article, null when there is none any more; absent when it did not change or could not compile. */
  article?: ResultArticle | null;
  writes: { path: string; data: Uint8Array }[];
  deletes: string[];
  /** Why it could not compile; the article stored before stays. */
  failed?: string;
}

/** The article for readers, compiled again when what it prints changed. */
export async function rebuildArticle(engine: TexEngine, paper: ResultPaper, files: Record<string, Uint8Array>): Promise<ArticleRebuild> {
  const hash = articleHash(paper);
  if (paper.article?.inputHash === hash) return { writes: [], deletes: [] };
  if (shown(paper.blocks, false).length === 0) return paper.article ? { article: null, writes: [], deletes: [paper.article.pdf] } : { writes: [], deletes: [] };
  const compiled = await compileArticle(engine, paper, files);
  if (!compiled.ok) return { writes: [], deletes: [], failed: compiled.message };
  const pdf = `results/${paper.id}/article-${hash.slice(0, 8)}.pdf`;
  return {
    article: { pdf, inputHash: hash, blocks: compiled.blocks, marks: packMarks(compiled.marks) },
    writes: [{ path: pdf, data: compiled.pdf }],
    deletes: paper.article && paper.article.pdf !== pdf ? [paper.article.pdf] : [],
  };
}

/** What one compile of the article leaves for the next: the labels and citations it wrote, and BibTeX's output. */
export interface ArticleCarry {
  aux?: string;
  bbl?: string;
  bibKey: string;
}

export type LiveArticle =
  /** `unsettled`: the labels or citations it read were not the ones it wrote; one more run would settle them. */
  | { ok: true; pdf: Uint8Array; marks: Mark[]; carry: ArticleCarry; unsettled?: boolean }
  | { ok: false; message: string; carry: ArticleCarry };

/**
 * The article as it is being typed (its main.tex `body`, hidden blocks included), compiled as the writing view
 * does: once, starting from what the last run wrote, and again only when the labels or citations it read changed.
 */
export async function compileLive(
  engine: TexEngine,
  paper: ResultPaper,
  body: string,
  files: Record<string, Uint8Array>,
  carry: ArticleCarry,
  { titleFile, quick = false }: { titleFile?: number; quick?: boolean } = {},
): Promise<LiveArticle> {
  const preamble = paper.preamble ?? DEFAULT_PREAMBLE;
  const keys = citedKeys(body);
  const style = bibliographyStyle(paper);
  const cites = files[REFERENCES_FILE] !== undefined && keys.length > 0;
  const doc = fullDocument(preamble, body, cites ? { style: packageSetsStyle(preamble, files) ? null : style, file: REFERENCES_FILE } : null, { titleFile });
  const bibKey = JSON.stringify([keys, style]);
  const bibtex = cites && (bibKey !== carry.bibKey || carry.bbl === undefined);
  const pass = (aux: string | undefined, bbl: string | undefined, withBibtex: boolean) =>
    engine.compile({
      main: doc.main,
      files: { ...files, ...(aux ? { 'main.aux': aux } : {}), ...(bbl && !withBibtex ? { 'main.bbl': bbl } : {}) },
      bibtex: withBibtex,
      read: ['main.gpos', 'main.bbl'],
    });
  let out = await pass(carry.aux, cites ? carry.bbl : undefined, bibtex);
  const bbl = cites ? (bibtex ? out.written?.['main.bbl'] : carry.bbl) : undefined;
  // `quick` shows the first run and leaves settling to the next.
  let unsettled = false;
  if (out.pdf && out.aux !== undefined && references(out.aux) !== references(carry.aux)) {
    if (quick) unsettled = true;
    else {
      const next = await pass(out.aux, bbl, false);
      if (next.pdf) out = next;
    }
  }
  const next = { aux: out.aux ?? carry.aux, bbl, bibKey: cites ? bibKey : '' };
  if (!out.pdf) return { ok: false, message: parseErrors(out.log)[0]?.message ?? out.reason ?? 'no PDF', carry: next };
  return { ok: true, pdf: out.pdf, marks: parseMarks(out.written?.['main.gpos'] ?? ''), carry: next, ...(unsettled ? { unsettled } : {}) };
}
