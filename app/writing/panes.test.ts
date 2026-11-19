import { describe, expect, it } from 'vitest';
import { DEFAULT_PANES, SIDE_MAX, SPLIT_MIN, readPanes } from './panes';

describe('readPanes', () => {
  it('starts from the defaults when nothing is stored or it does not parse', () => {
    expect(readPanes(null)).toEqual(DEFAULT_PANES);
    expect(readPanes('{oops')).toEqual(DEFAULT_PANES);
  });

  it('keeps what was stored, put back in range', () => {
    expect(readPanes(JSON.stringify({ side: 9999, sideOpen: false, split: 0 }))).toEqual({ side: SIDE_MAX, sideOpen: false, split: SPLIT_MIN });
    expect(readPanes(JSON.stringify({ split: 0.6 }))).toEqual({ ...DEFAULT_PANES, split: 0.6 });
  });
});
