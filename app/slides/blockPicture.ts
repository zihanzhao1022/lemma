import type { ReadFile } from '../../editor/results/actions';
import { ResultBlock } from '../../types';
import { Picture } from './blockHtml';
import { blockBytes, drawPdf } from './SlideView';

/** Each picture drawn once: a block's PDF and the width it was drawn at name it. */
const drawn = new Map<string, Promise<string>>();

/**
 * A block's compiled PDF as a picture for a slide, three pixels to the point and at most 2400 wide, so that it is
 * sharp on a large screen; null for a block with no PDF (or one that cannot be read).
 */
export const pictureOf =
  (readFile: ReadFile): Picture =>
  async (block: ResultBlock) => {
    const output = block.output;
    if (!output) return null;
    const width = Math.max(64, Math.min(2400, Math.round(output.width * 3)));
    const key = `${output.pdf}@${width}`;
    let found = drawn.get(key);
    if (!found) {
      found = blockBytes(output.pdf, readFile)
        .then((data) => drawPdf(data, width))
        .then((canvas) => canvas.toDataURL('image/png'));
      drawn.set(key, found);
      found.catch(() => drawn.delete(key));
    }
    try {
      return await found;
    } catch {
      return null;
    }
  };
