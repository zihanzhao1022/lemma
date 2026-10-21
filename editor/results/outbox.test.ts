import { describe, expect, it } from 'vitest';
import { Waiting, combine, memoryStore } from './outbox';

const entry = (id: string, op: Waiting['op'], extra: Partial<Waiting> = {}): Waiting => ({
  id,
  op,
  writes: [],
  deletes: [],
  message: `results: ${id}`,
  publicMessage: 'content: update results',
  at: 0,
  ...extra,
});
const bytes = (n: number) => new Uint8Array([n]);

describe('saves waiting in the browser', () => {
  it('go up as they are when alone', () => {
    const one = entry('a', { kind: 'setBlockHidden', paperId: 'p', blockId: 'b', hidden: true });
    expect(combine([one])).toEqual({ op: one.op, writes: [], deletes: [], message: 'results: a', publicMessage: 'content: update results' });
  });

  it('go up together in order: one batch, the last write of a path, every deletion, a message listing them', () => {
    const first = entry('a', { kind: 'deleteBlock', paperId: 'p', blockId: 'b' }, { writes: [{ path: 'x.pdf', data: bytes(1) }], deletes: ['old.pdf'] });
    const second = entry('b', { kind: 'setBlockHidden', paperId: 'p', blockId: 'c', hidden: true }, { writes: [{ path: 'x.pdf', data: bytes(2) }], deletes: ['old.pdf', 'other.pdf'] });
    const both = combine([first, second]);
    expect(both.op).toEqual({ kind: 'batch', ops: [first.op, second.op] });
    expect(both.writes).toEqual([{ path: 'x.pdf', data: bytes(2) }]);
    expect(both.deletes).toEqual(['old.pdf', 'other.pdf']);
    expect(both.message).toBe('results: 2 changes\n\n- results: a\n- results: b');
  });

  it('are kept for the tab when the browser keeps nothing', async () => {
    const store = memoryStore();
    expect(store.durable).toBe(false);
    await store.put(entry('a', { kind: 'reorderPapers', ids: [] }));
    await store.put(entry('b', { kind: 'reorderPapers', ids: [] }));
    await store.remove(['a']);
    await store.keepPapers([]);
    const kept = await store.load();
    expect(kept.waiting.map((item) => item.id)).toEqual(['b']);
    expect(kept.papers).toEqual([]);
  });
});
