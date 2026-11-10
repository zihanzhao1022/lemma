import { ChangeSet, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { SourceSnapshots } from './sourceMapping';

const documentOf = (source: string) => Text.of(source.split('\n'));

describe('PDF source snapshots', () => {
  it('follows a clicked word through line and column edits made after compilation', () => {
    const maps = new SourceSnapshots();
    const source = 'Before\nA target word.\nAfter';
    let doc = documentOf(source);
    const snapshot = maps.capture({ 'main.tex': source }, new Map([['main.tex', doc]]));
    const prefix = ChangeSet.of({ from: 0, insert: 'New paragraph.\n' }, doc.length);
    doc = prefix.apply(doc);
    maps.update('main.tex', prefix, doc);
    const edit = ChangeSet.of({ from: doc.line(3).from + 2, insert: 'new ' }, doc.length);
    doc = edit.apply(doc);
    maps.update('main.tex', edit, doc);
    expect(snapshot.map('main.tex', 2, 2, 8)).toEqual({ line: 3, start: 6, end: 12 });
    expect(doc.line(3).text.slice(6, 12)).toBe('target');
    expect(snapshot.map('main.tex', 2)).toEqual({ line: 3 });
  });

  it('maps independent files and snapshots while another compilation is in progress', () => {
    const maps = new SourceSnapshots();
    const main = documentOf('Body');
    let section = documentOf('Section target');
    const first = maps.capture({ 'main.tex': 'Body', 'files/part.tex': 'Section target' }, new Map([['main.tex', main], ['files/part.tex', section]]));
    const edit = ChangeSet.of({ from: 0, insert: '\n' }, section.length);
    section = edit.apply(section);
    maps.update('files/part.tex', edit, section);
    const second = maps.capture({ 'files/part.tex': section.toString() }, new Map([['files/part.tex', section]]));
    const next = ChangeSet.of({ from: 0, insert: 'Intro\n' }, section.length);
    section = next.apply(section);
    maps.update('files/part.tex', next, section);
    expect(first.map('main.tex', 1)).toEqual({ line: 1 });
    expect(first.map('files/part.tex', 1, 8, 14)).toEqual({ line: 3, start: 8, end: 14 });
    expect(second.map('files/part.tex', 2, 8, 14)).toEqual({ line: 3, start: 8, end: 14 });
    first.dispose();
    expect(first.map('main.tex', 1)).toBeNull();
    expect(second.map('files/part.tex', 2)).toEqual({ line: 3 });
  });

  it('clamps deleted selections and handles undo without retaining old edits', () => {
    const maps = new SourceSnapshots();
    const original = documentOf('First\nA target word.');
    const snapshot = maps.capture({ 'main.tex': original.toString() }, new Map([['main.tex', original]]));
    const deletion = ChangeSet.of({ from: 0, to: original.line(2).from + 8 }, original.length);
    const after = deletion.apply(original);
    maps.update('main.tex', deletion, after);
    expect(snapshot.map('main.tex', 2, 2, 8)).toEqual({ line: 1, start: 0, end: 0 });
    const undo = deletion.invert(original);
    maps.update('main.tex', undo, undo.apply(after));
    expect(snapshot.map('main.tex', 2, 9, 13)).toEqual({ line: 2, start: 9, end: 13 });
  });

  it('invalidates reloaded sources and refuses mismatched snapshots', () => {
    const maps = new SourceSnapshots();
    const doc = documentOf('Current text');
    const snapshot = maps.capture({ 'main.tex': doc.toString() }, new Map([['main.tex', doc]]));
    const stale = maps.capture({ 'main.tex': 'Old text' }, new Map([['main.tex', doc]]));
    expect(stale.map('main.tex', 1)).toBeNull();
    maps.clear();
    expect(snapshot.map('main.tex', 1)).toBeNull();
  });

  it('caps a word selection when the live word is split onto another line', () => {
    const maps = new SourceSnapshots();
    const doc = documentOf('A target word.');
    const snapshot = maps.capture({ 'main.tex': doc.toString() }, new Map([['main.tex', doc]]));
    const split = ChangeSet.of({ from: 5, insert: '\n' }, doc.length);
    maps.update('main.tex', split, split.apply(doc));
    expect(snapshot.map('main.tex', 1, 2, 8)).toEqual({ line: 1, start: 2, end: 5 });
    expect(snapshot.map('unknown.tex', 1)).toBeNull();
  });
});
