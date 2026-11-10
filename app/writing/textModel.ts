/**
 * The text typed on a paper's article, where no code editor holds it: the text, its undo history, and a log of
 * its changes, so a place in the text a compile started from can be found in the text as it is now.
 */

interface Change {
  from: number;
  /** What was taken out and what was put in. */
  removed: string;
  inserted: string;
}

interface Step {
  changes: Change[];
  kind?: string;
  at: number;
}

/** Typing within this long of the last key joins its undo step. */
const MERGE_MS = 1000;

export class TextModel {
  text: string;
  /** Counts changes; `map` takes a version to map from. */
  version = 0;
  /** Changes since `base`, the version the log starts at. */
  private log: { from: number; to: number; length: number }[] = [];
  private base = 0;
  private undone: Step[] = [];
  private done: Step[] = [];

  constructor(text: string) {
    this.text = text;
  }

  /** New text from elsewhere: no history, and no place in the text before it maps into it. */
  reset(text: string): void {
    this.text = text;
    this.version += 1;
    this.base = this.version;
    this.log = [];
    this.done = [];
    this.undone = [];
  }

  private apply(change: Change): void {
    const to = change.from + change.removed.length;
    this.text = `${this.text.slice(0, change.from)}${change.inserted}${this.text.slice(to)}`;
    this.log.push({ from: change.from, to, length: change.inserted.length });
    this.version += 1;
  }

  /** Replaces `from`–`to` with `insert`; `kind` "type" joins quick typing into one undo step. */
  change(from: number, to: number, insert: string, kind?: string): void {
    const change = { from, removed: this.text.slice(from, to), inserted: insert };
    this.apply(change);
    this.undone = [];
    const last = this.done[this.done.length - 1];
    const now = Date.now();
    // Typing on from where the last change ended, or deleting on from it, joins its step; elsewhere starts a new one.
    const previous = last?.changes[last.changes.length - 1];
    const adjacent = previous !== undefined && (from === previous.from + previous.inserted.length || to === previous.from || from === previous.from);
    if (kind && last && last.kind === kind && now - last.at < MERGE_MS && adjacent) {
      last.changes.push(change);
      last.at = now;
    } else this.done.push({ changes: [change], kind, at: now });
  }

  /** Undoes the last step; returns where the caret goes, or null when there is nothing to undo. */
  undo(): number | null {
    const step = this.done.pop();
    if (!step) return null;
    for (const change of [...step.changes].reverse()) this.apply({ from: change.from, removed: change.inserted, inserted: change.removed });
    this.undone.push(step);
    const first = step.changes[0];
    return first.from + first.removed.length;
  }

  redo(): number | null {
    const step = this.undone.pop();
    if (!step) return null;
    for (const change of step.changes) this.apply(change);
    this.done.push({ ...step, at: 0 });
    const last = step.changes[step.changes.length - 1];
    return last.from + last.inserted.length;
  }

  /** An offset in the text at `version`, in the text now; null when the text around it was changed. */
  map(offset: number, version: number): number | null {
    if (version < this.base || version > this.version) return null;
    let at = offset;
    for (const change of this.log.slice(version - this.base)) {
      if (at <= change.from) continue;
      if (at < change.to) return null;
      at += change.length - (change.to - change.from);
    }
    return at;
  }
}
