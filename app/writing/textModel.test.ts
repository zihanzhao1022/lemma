import { describe, expect, it } from 'vitest';
import { TextModel } from './textModel';

describe('TextModel', () => {
  it('changes the text and undoes and redoes the change, giving where the caret goes', () => {
    const model = new TextModel('hello world');
    model.change(5, 5, ',');
    expect(model.text).toBe('hello, world');
    expect(model.undo()).toBe(5);
    expect(model.text).toBe('hello world');
    expect(model.redo()).toBe(6);
    expect(model.text).toBe('hello, world');
    expect(model.redo()).toBeNull();
  });

  it('merges typing into one undo step', () => {
    const model = new TextModel('ab');
    model.change(1, 1, 'x', 'type');
    model.change(2, 2, 'y', 'type');
    model.undo();
    expect(model.text).toBe('ab');
  });

  it('starts a new undo step for typing somewhere else', () => {
    const model = new TextModel('one two');
    model.change(3, 3, 'X', 'type');
    model.change(8, 8, 'Y', 'type');
    model.undo();
    expect(model.text).toBe('oneX two');
  });

  it('joins deleting backwards from where the last deletion was', () => {
    const model = new TextModel('abcd');
    model.change(3, 4, '', 'delete');
    model.change(2, 3, '', 'delete');
    model.undo();
    expect(model.text).toBe('abcd');
  });

  it('maps an offset of an earlier version to the text now', () => {
    const model = new TextModel('one two three');
    const version = model.version;
    model.change(0, 0, 'zero ');
    model.change(9, 13, '');
    // "three" started at 8; five characters were put before it and "two " taken out before it.
    expect(model.map(8, version)).toBe(9);
    expect(model.map(5, version)).toBeNull();
    expect(model.map(13, version)).toBe(14);
  });

  it('starts over from new text, forgetting what came before', () => {
    const model = new TextModel('a');
    model.change(1, 1, 'b');
    const version = model.version;
    model.reset('fresh');
    expect(model.text).toBe('fresh');
    expect(model.undo()).toBeNull();
    expect(model.map(0, version)).toBeNull();
  });
});
