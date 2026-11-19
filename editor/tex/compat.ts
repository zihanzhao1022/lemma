/**
 * What the TeX Live files the engine reads cannot take as written. The server has pgfplots 1.16, which stops
 * with an error at `compat=1.17` and later (the value Overleaf's templates set); those values are read as
 * `compat=newest`, its own most recent behaviour. The text keeps its lines, so problems keep their line numbers.
 */
const NEWER_COMPAT = /(\bcompat\s*=\s*)(1\.(?:1[7-9]|[2-9]\d)|[2-9]\.\d+)(?![\d.])/g;

export const withKnownCompat = (text: string): string => (text.includes('compat') ? text.replace(NEWER_COMPAT, '$1newest') : text);
