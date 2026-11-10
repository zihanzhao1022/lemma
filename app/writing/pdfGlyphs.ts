/**
 * Every glyph a PDF page draws as text, where it is, from pdf.js's operator list: the same text state pdf.js's
 * canvas follows (text and line matrices, moves, leading, spacing, horizontal scale, rise, the current transform),
 * so a page can show its text as HTML in the PDF's own fonts at exactly the canvas's places. A run is the glyphs of
 * one showText between TeX's moves; a glyph knows the character pdf.js draws it with (`char`, in the font pdf.js
 * loaded) and the text it stands for. Text this cannot place exactly (a Type 3 font, text not filled, turned text)
 * stays on the canvas: `drawn` lists the showText operators wholly given as runs.
 */

export interface GlyphOps {
  save: number;
  restore: number;
  transform: number;
  beginText: number;
  endText: number;
  setCharSpacing: number;
  setWordSpacing: number;
  setHScale: number;
  setLeading: number;
  setFont: number;
  setTextRenderingMode: number;
  setTextRise: number;
  moveText: number;
  setLeadingMoveText: number;
  setTextMatrix: number;
  nextLine: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
  setFillRGBColor: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
}

export interface FontInfo {
  fontMatrix?: number[];
  isType3Font?: boolean;
  vertical?: boolean;
}

export interface Glyph {
  /** The character pdf.js draws the glyph with in its loaded font, and the text the glyph stands for. */
  char: string;
  text: string;
  /** UTF-16 offset of `text` in the run's string. */
  offset: number;
  /** From the run's start, and its advance, in PDF points. */
  x: number;
  width: number;
}

export interface GlyphRun {
  /** The showText operator it comes from. */
  op: number;
  /** The font's name in pdf.js (its loaded font face). */
  font: string;
  color: string;
  /** Baseline start in PDF points from the page's bottom left. */
  x: number;
  y: number;
  /** Font size in PDF points, and how much wider than tall it is set. */
  size: number;
  scaleX: number;
  str: string;
  glyphs: Glyph[];
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `outer` after `inner`, as canvas's transform() composes them. */
const compose = (outer: Matrix, inner: Matrix): Matrix => [
  outer[0] * inner[0] + outer[2] * inner[1],
  outer[1] * inner[0] + outer[3] * inner[1],
  outer[0] * inner[2] + outer[2] * inner[3],
  outer[1] * inner[2] + outer[3] * inner[3],
  outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
  outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
];

const round = (value: number) => Math.round(value * 1e6) / 1e6;

interface RawGlyph {
  fontChar?: string;
  unicode?: string;
  width?: number;
  isSpace?: boolean;
}

export function glyphRuns(fnArray: number[], argsArray: unknown[], ops: GlyphOps, fontOf: (name: string) => FontInfo | undefined): { runs: GlyphRun[]; drawn: Set<number> } {
  const reader = glyphReader(ops, fontOf);
  reader.readTo(fnArray, argsArray, fnArray.length - 1);
  return { runs: reader.runs, drawn: reader.drawn };
}

export interface GlyphReader {
  runs: GlyphRun[];
  drawn: Set<number>;
  /** Reads the operators up to `last` not read yet; whether `last` is drawn as runs. */
  readTo(fnArray: number[], argsArray: unknown[], last: number): boolean;
}

/**
 * Reads an operator list as it arrives, in order: pdf.js's canvas renders from its own list (merged by its
 * optimizer, so its indices are not those of getOperatorList), and asks about each operator before drawing it.
 */
export function glyphReader(ops: GlyphOps, fontOf: (name: string) => FontInfo | undefined): GlyphReader {
  const runs: GlyphRun[] = [];
  const drawn = new Set<number>();
  interface State {
    ctm: Matrix;
    color: string;
    font: string;
    size: number;
    charSpacing: number;
    wordSpacing: number;
    hScale: number;
    leading: number;
    rise: number;
    mode: number;
  }
  let state: State = { ctm: IDENTITY, color: '#000000', font: '', size: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, mode: 0 };
  const stack: State[] = [];
  let textMatrix: Matrix = IDENTITY;
  let lineX = 0;
  let lineY = 0;
  let x = 0;
  let y = 0;

  const moveText = (dx: number, dy: number) => {
    lineX += dx;
    lineY += dy;
    x = lineX;
    y = lineY;
  };

  const show = (op: number, glyphs: unknown[]) => {
    const font = fontOf(state.font);
    const size = Math.abs(state.size);
    const direction = state.size < 0 ? -1 : 1;
    const advanceScale = size * (font?.fontMatrix?.[0] ?? 0.001);
    const m = compose(state.ctm, textMatrix);
    // Only text set upright, unturned and filled is drawn as HTML; the rest stays on the canvas.
    const exact = Boolean(font) && !font!.isType3Font && !font!.vertical && state.mode === 0 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && m[0] > 0 && m[3] > 0 && size > 0;
    let advance = 0;
    let run: GlyphRun | null = null;
    let complete = exact;
    const close = () => {
      if (run && run.glyphs.length > 0) runs.push(run);
      run = null;
    };
    for (const item of glyphs) {
      if (typeof item === 'number') {
        close();
        advance -= (item * size) / 1000;
        continue;
      }
      const glyph = item as RawGlyph;
      const width = (glyph.width ?? 0) * advanceScale + ((glyph.isSpace ? state.wordSpacing : 0) + state.charSpacing) * direction;
      if (exact && glyph.fontChar) {
        const left = m[0] * (x + advance * state.hScale) + m[4];
        if (!run) {
          run = {
            op,
            font: state.font,
            color: state.color,
            x: round(left),
            y: round(m[3] * (y + state.rise) + m[5]),
            size: round(size * m[3]),
            scaleX: round((state.hScale * m[0]) / m[3]),
            str: '',
            glyphs: [],
          };
        }
        const current = run as GlyphRun;
        const text = glyph.unicode ?? '';
        current.glyphs.push({ char: glyph.fontChar, text, offset: current.str.length, x: round(left - current.x), width: round(width * state.hScale * m[0]) });
        current.str += text;
      } else complete = false;
      advance += width;
    }
    close();
    x += advance * state.hScale;
    if (complete) drawn.add(op);
  };

  const read = (fn: number, rawArgs: unknown, op: number) => {
    const args = (rawArgs ?? []) as unknown[];
    switch (fn) {
      case ops.save:
        stack.push({ ...state });
        break;
      case ops.restore:
        state = stack.pop() ?? state;
        break;
      case ops.transform:
        state.ctm = compose(state.ctm, args as Matrix);
        break;
      case ops.paintFormXObjectBegin:
        stack.push({ ...state });
        if (Array.isArray(args[0]) && args[0].length === 6) state.ctm = compose(state.ctm, args[0] as Matrix);
        break;
      case ops.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;
      case ops.setFillRGBColor:
        if (typeof args[0] === 'string') state.color = args[0];
        break;
      case ops.beginText:
        textMatrix = IDENTITY;
        lineX = lineY = x = y = 0;
        break;
      case ops.setFont:
        state.font = String(args[0]);
        state.size = Number(args[1]);
        break;
      case ops.setCharSpacing:
        state.charSpacing = Number(args[0]);
        break;
      case ops.setWordSpacing:
        state.wordSpacing = Number(args[0]);
        break;
      case ops.setHScale:
        state.hScale = Number(args[0]) / 100;
        break;
      case ops.setLeading:
        state.leading = -Number(args[0]);
        break;
      case ops.setTextRise:
        state.rise = Number(args[0]);
        break;
      case ops.setTextRenderingMode:
        state.mode = Number(args[0]);
        break;
      case ops.moveText:
        moveText(Number(args[0]), Number(args[1]));
        break;
      case ops.setLeadingMoveText:
        state.leading = Number(args[1]);
        moveText(Number(args[0]), Number(args[1]));
        break;
      case ops.setTextMatrix:
        textMatrix = (Array.isArray(args[0]) ? args[0] : args) as Matrix;
        lineX = lineY = x = y = 0;
        break;
      case ops.nextLine:
        moveText(0, state.leading);
        break;
      case ops.showText:
      case ops.showSpacedText:
        show(op, (args[0] ?? []) as unknown[]);
        break;
      case ops.nextLineShowText:
        moveText(0, state.leading);
        show(op, (args[0] ?? []) as unknown[]);
        break;
      case ops.nextLineSetSpacingShowText:
        state.wordSpacing = Number(args[0]);
        state.charSpacing = Number(args[1]);
        moveText(0, state.leading);
        show(op, (args[2] ?? []) as unknown[]);
        break;
      default:
    }
  };
  let next = 0;
  return {
    runs,
    drawn,
    readTo(fnArray, argsArray, last) {
      for (; next <= last && next < fnArray.length; next += 1) read(fnArray[next], argsArray[next], next);
      return drawn.has(last);
    },
  };
}
