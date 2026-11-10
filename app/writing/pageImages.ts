/**
 * Pictures on a PDF page and the \includegraphics that put them there: where each picture is drawn (from
 * pdf.js's operator list), where each graphic's file name is in the source, and the name that replaces it.
 */

/** In PDF points from the page's bottom left. */
export interface Box {
  left: number;
  bottom: number;
  right: number;
  top: number;
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

function boxOf(matrix: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const corners = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
}

export interface ImageOps {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
}

/**
 * The pictures a page draws, in drawing order: images by the unit square they fill, included PDFs (form
 * XObjects) by their box; whatever an included PDF draws inside itself is part of it.
 */
export function imageBoxes(fnArray: number[], argsArray: unknown[], ops: ImageOps): Box[] {
  const boxes: Box[] = [];
  const stack: Matrix[] = [];
  let matrix = IDENTITY;
  let forms = 0;
  fnArray.forEach((fn, index) => {
    const args = (argsArray[index] ?? []) as unknown[];
    if (fn === ops.save) stack.push(matrix);
    else if (fn === ops.restore) matrix = stack.pop() ?? IDENTITY;
    else if (fn === ops.transform) matrix = compose(matrix, args as Matrix);
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(matrix);
      const inner = Array.isArray(args[0]) && args[0].length === 6 ? (args[0] as Matrix) : IDENTITY;
      matrix = compose(matrix, inner);
      const bbox = Array.isArray(args[1]) && args[1].length === 4 ? (args[1] as number[]) : null;
      if (forms === 0 && bbox) boxes.push(boxOf(matrix, bbox[0], bbox[1], bbox[2], bbox[3]));
      forms += 1;
    } else if (fn === ops.paintFormXObjectEnd) {
      matrix = stack.pop() ?? IDENTITY;
      forms = Math.max(0, forms - 1);
    } else if (forms === 0 && (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject)) {
      boxes.push(boxOf(matrix, 0, 0, 1, 1));
    }
  });
  return boxes;
}

export interface Graphic {
  /** The file name as written, and its range in the source. */
  path: string;
  from: number;
  to: number;
}

/** The \includegraphics in source [from, to), commented ones left out. */
export function graphicsOf(source: string, from: number, to: number): Graphic[] {
  const found: Graphic[] = [];
  const pattern = /\\includegraphics\s*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(source); match && match.index < to; match = pattern.exec(source)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    // A % on the line before it, not escaped, makes it a comment.
    if (/(^|[^\\])(\\\\)*%/.test(source.slice(lineStart, match.index))) continue;
    const at = match.index + match[0].length - 1 - match[1].length;
    found.push({ path: match[1], from: at, to: at + match[1].length });
  }
  return found;
}

/** The name a graphic gets for an attachment: with its extension when the old name had one. */
export const replaceGraphic = (old: string, attachment: string): string => (/\.[A-Za-z0-9]+$/.test(old) ? attachment : attachment.replace(/\.[A-Za-z0-9]+$/, ''));
