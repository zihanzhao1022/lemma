/** The part of KaTeX's API the paper's web page uses (KaTeX ships no types). */
declare module 'katex' {
  interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    output?: 'html' | 'mathml' | 'htmlAndMathml';
    macros?: Record<string, string>;
    strict?: boolean | 'ignore' | 'warn' | 'error';
    trust?: boolean;
  }
  const katex: { renderToString: (tex: string, options?: KatexOptions) => string };
  export default katex;
}
