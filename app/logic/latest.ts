import { ResultPaper } from '../../types';
import type { Relation } from './graph';

/** The paper's logic and the lines drawn between its blocks, as one change. */
export interface LogicDraft {
  logic: Record<string, string>;
  relations: Relation[];
}

/**
 * Each paper's logic as last changed in this tab, kept until a save of exactly that change lands. The logic view
 * opened again before then, a presentation and a new deck use it rather than the paper's older saved logic.
 */
const changed = new Map<string, LogicDraft>();

/** The logic to show for a paper: the one changed here while it is not saved yet, else the paper's own. */
export const draftOf = (paper: ResultPaper): LogicDraft => changed.get(paper.id) ?? { logic: paper.logic ?? {}, relations: paper.relations ?? [] };

/** The paper with the logic to show. */
export const withLatestLogic = (paper: ResultPaper): ResultPaper => {
  const draft = changed.get(paper.id);
  return draft ? { ...paper, logic: draft.logic, relations: draft.relations } : paper;
};

export const changedDraft = (paperId: string, draft: LogicDraft): void => {
  changed.set(paperId, draft);
};

/** A save of `draft` landed: the paper has it now, unless the logic changed again since. */
export const savedDraft = (paperId: string, draft: LogicDraft): void => {
  if (changed.get(paperId) === draft) changed.delete(paperId);
};

/** Whether the paper's logic was changed here and that change is not saved yet. */
export const unsavedLogic = (paperId: string): boolean => changed.has(paperId);
