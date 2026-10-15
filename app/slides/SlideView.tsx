import React, { useEffect, useRef } from 'react';
import { openPdf } from '../../components/results/pdfjs';
import type { ReadFile } from '../../editor/results/actions';
import { t } from '../../lib/phrases/app';
import { ResultPaper, Slide, SlideText } from '../../types';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './deck';

/** Block PDFs by repository path, shared by every slide; a recompiled block gets a new path. */
const bytes = new Map<string, Promise<Uint8Array>>();

export function blockBytes(path: string, readFile: ReadFile): Promise<Uint8Array> {
  let loading = bytes.get(path);
  if (!loading) {
    loading = readFile(path);
    bytes.set(path, loading);
    loading.catch(() => bytes.delete(path));
  }
  return loading;
}

/** The first page of a PDF drawn into a canvas `width` pixels wide (device pixels: pass the ratio in it). */
export async function drawPdf(data: Uint8Array, width: number, page = 1): Promise<HTMLCanvasElement> {
  const task = await openPdf({ data: data.slice() });
  try {
    const doc = await task.promise;
    const sheet = await doc.getPage(page);
    const base = sheet.getViewport({ scale: 1 });
    const scale = width / base.width;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(base.width * scale));
    canvas.height = Math.max(1, Math.round(base.height * scale));
    await sheet.render({ canvas, viewport: sheet.getViewport({ scale }) }).promise;
    return canvas;
  } finally {
    void task.destroy();
  }
}

/**
 * A block's compiled PDF, as large as fits its box in its own shape (a block that changed shape since it was
 * placed is not stretched). It is drawn again, a moment after the box stops changing, only when the box has
 * grown past what was drawn, so dragging and resizing stay smooth and the picture stays sharp.
 */
export const BlockPicture: React.FC<{ path: string; readFile: ReadFile; width: number }> = ({ path, readFile, width }) => {
  const host = useRef<HTMLDivElement>(null);
  const drawn = useRef<{ path: string; width: number } | null>(null);
  useEffect(() => {
    const target = Math.round(width * (window.devicePixelRatio || 1));
    const last = drawn.current;
    if (last && last.path === path && last.width >= target) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        blockBytes(path, readFile)
          .then((data) => drawPdf(data, Math.max(target, 64)))
          .then((canvas) => {
            if (cancelled || !host.current) return;
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.objectFit = 'contain';
            canvas.style.display = 'block';
            host.current.replaceChildren(canvas);
            drawn.current = { path, width: target };
          })
          .catch(() => undefined);
      },
      last ? 250 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [path, readFile, width]);
  return <div ref={host} className="h-full w-full" />;
};

/** A line of slide text: a bullet ("- ", indented by two spaces a level) or a plain line. */
export function textLines(text: string): { bullet: boolean; level: number; content: string }[] {
  return text.split('\n').map((line) => {
    const match = /^(\s*)[-•]\s+(.*)$/.exec(line);
    return match ? { bullet: true, level: Math.floor(match[1].length / 2), content: match[2] } : { bullet: false, level: 0, content: line };
  });
}

export const TITLE_FONT = "'Source Serif 4', 'Source Serif Pro', Georgia, 'Songti SC', serif";
export const BODY_FONT = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', system-ui, sans-serif";

/** Text as a slide shows it, at a scale (pixels per slide unit). */
export const TextContent: React.FC<{ element: SlideText; scale: number }> = ({ element, scale }) => (
  // Text that does not fit runs on below its box, as in PowerPoint, rather than disappearing.
  <div
    className="h-full w-full"
    style={{
      fontFamily: element.role === 'title' ? TITLE_FONT : BODY_FONT,
      fontSize: element.size * scale,
      fontWeight: element.bold ? 700 : 400,
      lineHeight: 1.3,
      textAlign: element.align ?? 'left',
      color: '#1d1d1f',
    }}
  >
    {textLines(element.text).map((line, index) =>
      line.bullet ? (
        <div key={index} className="flex" style={{ paddingLeft: `${line.level * 1.2}em` }}>
          <span className="mr-[0.5em] shrink-0">{line.level > 0 ? '–' : '•'}</span>
          <span>{line.content}</span>
        </div>
      ) : (
        <div key={index} style={{ minHeight: '1.3em', whiteSpace: 'pre-wrap' }}>
          {line.content}
        </div>
      ),
    )}
  </div>
);

interface Props {
  slide: Slide;
  paper: ResultPaper;
  readFile: ReadFile;
  /** Width in pixels; the height follows (16:9). */
  width: number;
  /** Elements not to draw (the one being edited is drawn by the editor instead). */
  skip?: string;
  /** Drawn over the slide, in its pixels (the editor's handles and guides). */
  children?: React.ReactNode;
  className?: string;
}

/** One slide, drawn at a width: its text, and its blocks as the paper compiled them. */
const SlideView: React.FC<Props> = ({ slide, paper, readFile, width, skip, children, className = '' }) => {
  const scale = width / SLIDE_WIDTH;
  return (
    <div className={`relative overflow-hidden bg-white ${className}`} style={{ width, height: (width * SLIDE_HEIGHT) / SLIDE_WIDTH }}>
      {slide.elements.map((element) => {
        if (element.id === skip) return null;
        const box = { left: element.x * scale, top: element.y * scale, width: element.w * scale, height: element.h * scale };
        if (element.type === 'text') {
          return (
            <div key={element.id} className="absolute" style={box}>
              <TextContent element={element} scale={scale} />
            </div>
          );
        }
        const block = paper.blocks.find((item) => item.id === element.blockId);
        return (
          <div key={element.id} className="absolute" style={box}>
            {block?.output ? (
              <BlockPicture path={block.output.pdf} readFile={readFile} width={box.width} />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gray-50 text-center text-gray-400" style={{ fontSize: Math.max(10, 22 * scale) }}>
                {block ? t('这个块还没有编译') : t('这个块已经删除')}
              </div>
            )}
          </div>
        );
      })}
      {children}
    </div>
  );
};

export default SlideView;
