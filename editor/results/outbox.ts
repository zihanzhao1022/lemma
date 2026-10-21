/**
 * Saves that wait in this browser before they reach the repository, so an edit shows at once and several
 * edits made close together go up as one commit. They are kept in IndexedDB with the account's last list of
 * papers: a tab closed or a network lost before they went up keeps them, and the next visit sends them; the
 * list shows at once on the next visit while the repository is read again.
 */
import { ResultPaper } from '../../types';
import { FileWrite } from './backend';
import { ResultsOp } from './ops';

/** A save waiting to go up: what saveResults was given. */
export interface Waiting {
  id: string;
  op: ResultsOp;
  writes: FileWrite[];
  deletes: string[];
  message: string;
  publicMessage: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Where an account's waiting saves and its last list of papers are kept. */
export interface BufferStore {
  /** False when nothing outlives the tab (no IndexedDB, or it failed): leaving must wait for the saves. */
  readonly durable: boolean;
  load(): Promise<{ waiting: Waiting[]; papers: ResultPaper[] | null }>;
  put(entry: Waiting): Promise<void>;
  remove(ids: string[]): Promise<void>;
  keepPapers(papers: ResultPaper[]): Promise<void>;
}

export const waitingId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Waiting saves as one commit, in the order they were made: their operations as a batch, the files they wrote
 * (a later write of a path wins) and deleted, and a message listing them.
 */
export function combine(entries: Waiting[]): Omit<Waiting, 'id' | 'at'> {
  if (entries.length === 1) {
    const [only] = entries;
    return { op: only.op, writes: only.writes, deletes: only.deletes, message: only.message, publicMessage: only.publicMessage };
  }
  const writes = new Map<string, FileWrite>();
  for (const entry of entries) for (const write of entry.writes) writes.set(write.path, write);
  const messages = [...new Set(entries.map((entry) => entry.message))];
  return {
    op: { kind: 'batch', ops: entries.map((entry) => entry.op) },
    writes: [...writes.values()],
    deletes: [...new Set(entries.flatMap((entry) => entry.deletes))],
    message: messages.length === 1 ? messages[0] : `results: ${entries.length} changes\n\n${messages.map((message) => `- ${message}`).join('\n')}`,
    publicMessage: entries[entries.length - 1].publicMessage,
  };
}

/** Kept for this tab only. */
export function memoryStore(): BufferStore {
  let waiting: Waiting[] = [];
  let papers: ResultPaper[] | null = null;
  return {
    durable: false,
    load: async () => ({ waiting: [...waiting], papers }),
    put: async (entry) => {
      waiting.push(entry);
    },
    remove: async (ids) => {
      waiting = waiting.filter((entry) => !ids.includes(entry.id));
    },
    keepPapers: async (next) => {
      papers = next;
    },
  };
}

const DB = 'lemma-buffer';
const WAITING = 'waiting';
const PAPERS = 'papers';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * The account's buffer in IndexedDB, under `key` (account and repository); for this tab only when the browser
 * keeps no IndexedDB (a private window may refuse it).
 */
export function bufferStore(key: string): BufferStore {
  if (typeof indexedDB === 'undefined') return memoryStore();
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (opened ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore(WAITING, { keyPath: 'id' }).createIndex('key', 'key');
        db.createObjectStore(PAPERS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const store = {
    durable: true,
    async load() {
      const db = await open();
      const tx = db.transaction([WAITING, PAPERS], 'readonly');
      const [rows, papers] = await Promise.all([
        request(tx.objectStore(WAITING).index('key').getAll(key)) as Promise<(Waiting & { key: string })[]>,
        request(tx.objectStore(PAPERS).get(key)) as Promise<ResultPaper[] | undefined>,
      ]);
      return { waiting: rows.map(({ key: _key, ...entry }) => entry).sort((a, b) => a.at - b.at), papers: papers ?? null };
    },
    async put(entry: Waiting) {
      const db = await open();
      const tx = db.transaction(WAITING, 'readwrite');
      tx.objectStore(WAITING).put({ ...entry, key });
      await done(tx);
    },
    async remove(ids: string[]) {
      if (ids.length === 0) return;
      const db = await open();
      const tx = db.transaction(WAITING, 'readwrite');
      for (const id of ids) tx.objectStore(WAITING).delete(id);
      await done(tx);
    },
    async keepPapers(papers: ResultPaper[]) {
      const db = await open();
      const tx = db.transaction(PAPERS, 'readwrite');
      tx.objectStore(PAPERS).put(papers, key);
      await done(tx);
    },
  };
  // A failure to write makes the buffer this tab's only, so leaving waits for the saves.
  const guard = <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await run(...args);
      } catch (error) {
        store.durable = false;
        throw error;
      }
    };
  return {
    get durable() {
      return store.durable;
    },
    load: guard(store.load),
    put: guard(store.put),
    remove: guard(store.remove),
    keepPapers: guard(store.keepPapers),
  };
}

/**
 * Forgets every account's kept list of papers (signing out). Saves still waiting stay: they are the person's own
 * edits that have not gone up yet, and go up when they sign in again.
 */
export async function forgetKeptPapers(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(WAITING, { keyPath: 'id' }).createIndex('key', 'key');
        req.result.createObjectStore(PAPERS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(PAPERS, 'readwrite');
    tx.objectStore(PAPERS).clear();
    await done(tx);
    db.close();
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}
