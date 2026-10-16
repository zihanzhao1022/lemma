import { ResultPaper } from '../../types';

/**
 * Each paper's logic as last changed in this tab, kept until a save of exactly that logic lands. The logic view
 * opened again before then, a presentation and a new deck use it rather than the paper's older saved logic.
 */
const changed = new Map<string, Record<string, string>>();

/** The logic to show for a paper: the one changed here while it is not saved yet, else the paper's own. */
export const logicOf = (paper: ResultPaper): Record<string, string> => changed.get(paper.id) ?? paper.logic ?? {};

/** The paper with the logic to show. */
export const withLatestLogic = (paper: ResultPaper): ResultPaper => {
  const logic = changed.get(paper.id);
  return logic ? { ...paper, logic } : paper;
};

export const changedLogic = (paperId: string, logic: Record<string, string>): void => {
  changed.set(paperId, logic);
};

/** A save of `logic` landed: the paper has it now, unless the logic changed again since. */
export const savedLogic = (paperId: string, logic: Record<string, string>): void => {
  if (changed.get(paperId) === logic) changed.delete(paperId);
};

/** Whether the paper's logic was changed here and that change is not saved yet. */
export const unsavedLogic = (paperId: string): boolean => changed.has(paperId);
