import { ChangeDesc, ChangeSet, Text } from '@codemirror/state';

export interface SourcePosition {
  line: number;
  start?: number;
  end?: number;
}

/** Maps the source used by one PDF to the files as they are being edited. */
export interface SourceSnapshot {
  map: (file: string, line: number, start?: number, end?: number) => SourcePosition | null;
  /** Release it after its PDF is replaced, or when a compilation does not produce a PDF. */
  dispose: () => void;
}

interface TrackedFile {
  original: Text;
  current: Text;
  changes: ChangeDesc;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : min));

class Snapshot implements SourceSnapshot {
  constructor(
    readonly files: Map<string, TrackedFile>,
    private readonly release: (snapshot: Snapshot) => void,
  ) {}

  map(file: string, line: number, start?: number, end?: number): SourcePosition | null {
    const tracked = this.files.get(file);
    if (!tracked) return null;
    const original = tracked.original.line(clamp(line, 1, tracked.original.lines));
    const anchor = original.from + clamp(start ?? 0, 0, original.length);
    // Follow text inserted before the old target, including newlines at its exact beginning.
    const mappedAnchor = tracked.changes.mapPos(anchor, 1);
    const target = tracked.current.lineAt(mappedAnchor);
    if (start === undefined && end === undefined) return { line: target.number };
    const head = original.from + clamp(end ?? start ?? 0, 0, original.length);
    const mappedHead = Math.max(mappedAnchor, tracked.changes.mapPos(head, -1));
    return {
      line: target.number,
      start: mappedAnchor - target.from,
      // SourceEditor reveals a range on one line; a newline typed inside a word ends its selection there.
      ...(end === undefined ? {} : { end: Math.min(target.to, mappedHead) - target.from }),
    };
  }

  dispose(): void {
    this.files.clear();
    this.release(this);
  }
}

/** Only retained PDF snapshots receive edits; their maps compose instead of storing an edit history. */
export class SourceSnapshots {
  private readonly snapshots = new Set<Snapshot>();

  capture(texts: Record<string, string>, documents: ReadonlyMap<string, Text>): SourceSnapshot {
    const files = new Map<string, TrackedFile>();
    for (const [file, source] of Object.entries(texts)) {
      const doc = documents.get(file);
      // A stale caller or an external source reload must not silently map a different compilation.
      if (!doc || !doc.eq(Text.of(source.split(/\r\n?|\n/)))) continue;
      files.set(file, { original: doc, current: doc, changes: ChangeSet.empty(doc.length) });
    }
    const snapshot = new Snapshot(files, (released) => this.snapshots.delete(released));
    this.snapshots.add(snapshot);
    return snapshot;
  }

  update(file: string, changes: ChangeDesc, document: Text): void {
    for (const snapshot of this.snapshots) {
      const tracked = snapshot.files.get(file);
      if (!tracked) continue;
      if (changes.length !== tracked.current.length || changes.newLength !== document.length) {
        snapshot.files.delete(file);
        continue;
      }
      tracked.changes = tracked.changes.composeDesc(changes);
      tracked.current = document;
    }
  }

  clear(): void {
    for (const snapshot of this.snapshots) snapshot.dispose();
  }
}
