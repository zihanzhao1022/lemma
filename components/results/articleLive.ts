/**
 * What typing on a paper's article needs from the editor: the TeX engine, the paper's attachments, and saving
 * its blocks. Loaded only once someone edits, so readers of the site never download it.
 */
import { describeSaveError } from '../../editor/backend';
import { attachmentPath, loadAttachments, newBlockId, putFiles, rebuildWith, withOutputs } from '../../editor/results/actions';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import { FileWrite } from '../../editor/results/backend';
import { ArticleCarry, LiveArticle, compileLive } from '../../editor/results/article';
import { describeFailure } from '../../editor/results/numbering';
import { ResultsOp, applyResultsOp, resultsCommitMessage } from '../../editor/results/ops';
import { getTexEngine } from '../../editor/tex/engine';
import { blockChanges, blocksOf } from '../../app/writing/document';
import { Message } from '../../lib/i18n';
import { ResultPaper } from '../../types';

export { describeSaveError, loadAttachments };
export type { ArticleCarry, LiveArticle };

export async function compileArticleText(paper: ResultPaper, body: string, files: Record<string, Uint8Array>, carry: ArticleCarry): Promise<LiveArticle> {
  return compileLive(await getTexEngine(), paper, body, files, carry);
}

/**
 * Saves the blocks whose code `body` changed, with pictures added on the page (`added`): each block compiled again
 * as the page shows it, and the article with them. Text typed on the article cannot add, remove or move blocks, so
 * only changes to existing blocks are taken. Returns why it could not save, or null.
 */
export async function saveArticleText(
  paper: ResultPaper,
  body: string,
  files: Record<string, Uint8Array>,
  added: Record<string, Uint8Array>,
  save: ResultsSave,
): Promise<Message | null> {
  const inBody = paper.blocks.filter((block) => block.source?.trim());
  const changes = blockChanges(inBody, blocksOf(body), newBlockId);
  const ops: ResultsOp[] = changes.put.filter((change) => change.at === undefined).map((change) => ({ kind: 'putBlock', paperId: paper.id, block: change.block }));
  if (ops.length === 0 && Object.keys(added).length === 0) return null;
  const writes: FileWrite[] = [];
  if (Object.keys(added).length > 0) {
    const uploads = await putFiles(paper.id, added);
    ops.push(...uploads.ops);
    writes.push(...Object.entries(added).map(([name, data]) => ({ path: attachmentPath(paper.id, name), data })));
  }
  const draft = ops.reduce<ResultPaper[]>((papers, op) => applyResultsOp(papers, op), [paper])[0];
  const rebuilt = await rebuildWith(draft, { ...files, ...added });
  if (rebuilt.failed) return describeFailure(draft.blocks, rebuilt.failed);
  await save(withOutputs(paper.id, ops, rebuilt), [...writes, ...rebuilt.writes], rebuilt.deletes, resultsCommitMessage('write', paper.title), `content: update result "${paper.title}"`);
  return null;
}
