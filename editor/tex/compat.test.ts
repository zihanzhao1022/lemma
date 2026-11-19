import { describe, expect, it } from 'vitest';
import { withKnownCompat } from './compat';

describe('withKnownCompat', () => {
  it('reads pgfplots compat values newer than the engine has as its newest', () => {
    expect(withKnownCompat('\\pgfplotsset{compat=1.18}')).toBe('\\pgfplotsset{compat=newest}');
    expect(withKnownCompat('\\pgfplotsset{width=5cm, compat = 1.17}')).toBe('\\pgfplotsset{width=5cm, compat = newest}');
    expect(withKnownCompat('\\usepackage[compat=2.0]{pgfplots}')).toBe('\\usepackage[compat=newest]{pgfplots}');
  });

  it('leaves values the engine knows, and the lines, as they are', () => {
    for (const text of ['\\pgfplotsset{compat=1.16}', '\\pgfplotsset{compat=1.9}', '\\pgfplotsset{compat=newest}', '\\pgfplotsset{compat=1.3}']) expect(withKnownCompat(text)).toBe(text);
    expect(withKnownCompat('a\n\\pgfplotsset{compat=1.18}\nb').split('\n')).toHaveLength(3);
  });
});
