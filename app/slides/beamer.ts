import { ReadFile, loadAttachments } from '../../editor/results/actions';
import { getTexEngine } from '../../editor/tex/engine';
import { parseErrors } from '../../editor/tex/log';
import { ResultPaper } from '../../types';
import { beamerLine, beamerMain, blockFile, blockRefs, lemmablockLine, usedRefs } from './deck';
import { blockBytes } from './SlideView';

export interface BeamerResult {
  pdf?: Uint8Array;
  /** Problems by line of the deck's source, or without a line (in a package, or the engine's own). */
  issues: { line?: number; message: string }[];
  seconds: number;
}

/** The last compile of each paper's deck: presenting and exporting reuse it while nothing it used changed. */
const last = new Map<string, { key: string; result: Promise<BeamerResult> }>();

/**
 * Compiles a Beamer deck with the paper's attachments next to it and the PDFs of the blocks it names with
 * \lemmablock in lemma-blocks/. The same source with the same blocks is compiled once.
 */
export function compileBeamer(paper: ResultPaper, source: string, readFile: ReadFile): Promise<BeamerResult> {
  const refs = blockRefs(paper);
  const used = usedRefs(source).flatMap((name) => {
    const block = paper.blocks.find((item) => item.id === refs[name]);
    return block?.output ? [{ id: block.id, pdf: block.output.pdf }] : [];
  });
  const key = JSON.stringify([source, used, paper.fileHashes ?? {}]);
  const known = last.get(paper.id);
  if (known && known.key === key) return known.result;
  const result = (async (): Promise<BeamerResult> => {
    const started = performance.now();
    const files: Record<string, Uint8Array> = { ...(await loadAttachments(paper, readFile)) };
    for (const block of used) files[blockFile(block.id)] = await blockBytes(block.pdf, readFile);
    const engine = await getTexEngine();
    const out = await engine.compile({ main: beamerMain(source, refs), files });
    const issues = parseErrors(out.log).map((issue) => {
      // TeX reports an error inside a frame at the frame's end; a name \lemmablock does not know is shown where it is written.
      const unknown = /no block or label "([^"]*)"/.exec(issue.message)?.[1];
      const line = unknown === undefined ? undefined : lemmablockLine(source, unknown);
      if (line) return { line, message: issue.message };
      return issue.file || issue.line === undefined ? { message: issue.file ? `${issue.file}: ${issue.message}` : issue.message } : { line: beamerLine(issue.line), message: issue.message };
    });
    if (!out.pdf && issues.length === 0) issues.push({ message: out.reason ?? (/No pages of output/.test(out.log) ? 'No pages of output.' : 'No PDF') });
    return { pdf: out.pdf, issues, seconds: (performance.now() - started) / 1000 };
  })();
  last.set(paper.id, { key, result });
  result.catch(() => last.delete(paper.id));
  return result;
}
