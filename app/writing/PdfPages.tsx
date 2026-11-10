import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { loadPdfjs, openPdf } from '../../components/results/pdfjs';
import { renderPdfLinks } from '../../components/results/pdfLinks';
import '../../components/results/pdfView.css';
import { t } from '../../lib/phrases/app';
import { Hit } from './document';
import type { Spot } from './pageAlign';
import { Box, imageBoxes } from './pageImages';
import { PageText, itemIndex, itemPage } from './pageRegions';
import { GlyphRun, glyphRuns } from './pdfGlyphs';
import { pdfClickWord, pdfTextAt, selectedPdfWord } from './pdfText';

/** A double click in the PDF: where (see Hit), the word under it and the text of its line. */
export interface PdfClick extends Hit {
  word: string;
  context: string;
  contextOffset?: number;
  rowContext?: string;
  rowContextOffset?: number;
}

/** A single click in the PDF: the glyph under it and the side of it the click was on (item -1 off the text). */
export interface PageClick extends Hit {
  /** The text item, numbered by page and index (see pageRegions). */
  item: number;
  /** UTF-16 offset of the glyph in the item's text. */
  offset: number;
  side: 'before' | 'after';
  /** Where in the window. */
  clientX: number;
  clientY: number;
}

/** Where to draw the caret: beside a glyph. */
export interface CaretSpot extends Spot {
  side: 'before' | 'after';
}

export interface PdfPagesHandle {
  /** Scrolls to a point (PDF points from the page's bottom left) and marks it for a moment. */
  show: (page: number, y: number) => void;
  /** The text pdf.js reads from a page of the PDF on screen, items numbered as the text layer's spans. */
  pageText: (page: number) => Promise<PageText | undefined>;
  /** What a click at a point of the window would hit. */
  hitAt: (clientX: number, clientY: number) => PageClick | null;
  /** The caret's box in the window while one is drawn. */
  caretBox: () => DOMRect | null;
  /** The pictures a page of the PDF on screen draws, in drawing order. */
  pictures: (page: number) => Promise<Box[]>;
  /** How many pages the PDF on screen has. */
  pageCount: () => number;
  /** The page under a point of the window, and where on it in PDF points from its bottom left. */
  pointAt: (clientX: number, clientY: number) => { page: number; x: number; y: number } | null;
}

interface Props {
  data?: Uint8Array;
  /** Or the address of a published PDF. */
  url?: string;
  /** In the page's own flow, scrolled with the window, instead of a pane that scrolls itself. */
  flow?: boolean;
  /** Drawn over each page, in CSS pixels from its top left (`scale` pixels to a PDF point). */
  overlay?: (page: number, scale: number, size: Size) => React.ReactNode;
  /** A new PDF (bytes or address) is open and its pages are laid out. */
  onLoaded?: () => void;
  /** A page's text layer each time it is drawn, null when it goes. */
  onTextLayer?: (page: number, layer: HTMLElement | null) => void;
  /** 1 fits the pages to the pane's width. */
  zoom: number;
  onDoubleClick: (click: PdfClick) => void;
  /** The previous PDF and its callbacks have left the React tree. */
  onDocumentReady?: (data: Uint8Array) => void;
  /** A single click that selected no text. */
  onClick?: (click: PageClick) => void;
  /** Typing on the page: whether keys come here, the caret, the glyphs of a selected atom, and where the keys go. */
  editing?: boolean;
  caret?: CaretSpot | null;
  outline?: [Spot, Spot] | null;
  /** Text typed at the caret that the PDF on screen does not show yet: drawn there until it does, the caret after it. */
  pending?: string;
  onCaretText?: (text: string) => void;
  onCaretKey?: (event: KeyboardEvent) => void;
  onCaretLeave?: () => void;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * What a drawn page offers for clicks and carets: the PDF it shows, its frame, its text as runs of glyphs (with
 * their exact places), the text layer's span and the SVG text drawing each run, and the runs as text items.
 */
interface DrawnPage {
  doc: PDFDocumentProxy;
  frame: HTMLDivElement;
  spans: HTMLElement[];
  items: TextItem[];
  view: PageViewport;
  runs: GlyphRun[];
  texts: SVGTextElement[];
  /** The page's size in PDF points. */
  width: number;
  height: number;
}

/** The runs of glyphs a page draws as text, and the operators that drew them on the canvas. */
async function pageRuns(page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>): Promise<{ runs: GlyphRun[]; drawn: Set<number> }> {
  const pdfjs = await loadPdfjs();
  const list = await page.getOperatorList();
  return glyphRuns(list.fnArray, list.argsArray, pdfjs.OPS, (name) => {
    try {
      return page.commonObjs.has(name) ? page.commonObjs.get(name) : undefined;
    } catch {
      return undefined;
    }
  });
}

/** Runs as pdf.js text items: their text, where they start, and how wide and tall they are, in PDF points. */
const runItems = (runs: GlyphRun[]): TextItem[] =>
  runs.map((run) => {
    const last = run.glyphs[run.glyphs.length - 1];
    return {
      str: run.str,
      dir: 'ltr',
      transform: [run.size * run.scaleX, 0, 0, run.size, run.x, run.y],
      width: last ? last.x + last.width : 0,
      height: run.size,
      fontName: run.font,
      hasEOL: false,
    } as TextItem;
  });

const SVG = 'http://www.w3.org/2000/svg';

/** The page's text as SVG, glyph by glyph where the PDF puts it, in the fonts pdf.js loaded from the PDF. */
function glyphLayer(runs: GlyphRun[], width: number, height: number): { svg: SVGSVGElement; texts: SVGTextElement[] } {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'pdf-glyphs');
  const texts = runs.map((run) => {
    const text = document.createElementNS(SVG, 'text');
    placeRun(text, run, height, 0, -1);
    svg.append(text);
    return text;
  });
  return { svg, texts };
}

/** Sets a run's glyphs in its SVG text; those from `from` on moved right by `shift` PDF points (typing before them). */
function placeRun(text: SVGTextElement, run: GlyphRun, height: number, shift: number, from: number): void {
  const scale = run.scaleX || 1;
  text.setAttribute('font-family', run.font);
  text.setAttribute('font-size', String(run.size));
  text.setAttribute('fill', run.color);
  text.setAttribute('y', String(height - run.y));
  text.setAttribute('x', run.glyphs.map((glyph, index) => run.x + (glyph.x + (from >= 0 && index >= from ? shift : 0)) / scale).join(' '));
  if (scale !== 1) text.setAttribute('transform', `matrix(${scale} 0 0 1 ${run.x * (1 - scale)} 0)`);
  else text.removeAttribute('transform');
  text.textContent = run.glyphs.map((glyph) => glyph.char).join('');
}

let measurer: CanvasRenderingContext2D | null = null;

/**
 * The text layer: each run's text, transparent, over the run (stretched to its width as pdf.js does), with spaces
 * between words and a line break between lines, for selecting, copying and quoting in comments.
 */
function selectionLayer(runs: GlyphRun[], width: number, height: number, scale: number): { layer: HTMLDivElement; spans: HTMLElement[] } {
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  layer.style.setProperty('--scale-factor', String(scale));
  layer.style.setProperty('--total-scale-factor', String(scale));
  measurer ??= document.createElement('canvas').getContext('2d');
  const spans = runs.map((run, index) => {
    const span = document.createElement('span');
    const last = run.glyphs[run.glyphs.length - 1];
    const runWidth = last ? last.x + last.width : 0;
    span.textContent = run.str;
    span.style.left = `${(run.x / width) * 100}%`;
    span.style.top = `${((height - run.y - 0.8 * run.size) / height) * 100}%`;
    span.style.fontFamily = 'serif';
    span.style.setProperty('--font-height', `${run.size}px`);
    if (measurer && run.str) {
      measurer.font = `${run.size}px serif`;
      const natural = measurer.measureText(run.str).width;
      if (natural > 0) span.style.setProperty('--scale-x', String(runWidth / natural));
    }
    if (run.str) layer.append(span);
    const next = runs[index + 1];
    if (!next) return span;
    if (Math.abs(next.y - run.y) > 0.5 * run.size || next.x < run.x) layer.append(document.createElement('br'));
    else if (next.x - (run.x + runWidth) > 0.15 * run.size) layer.append(document.createTextNode(' '));
    return span;
  });
  return { layer, spans };
}

const GAP = 12;

/** The clicked glyph and the side of it the click was on, from the runs' glyph places; item -1 off the text. */
function glyphAt(drawn: DrawnPage, number: number, clientX: number, clientY: number): PageClick | null {
  const { frame, runs, view } = drawn;
  const box = frame.getBoundingClientRect();
  if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
  const [x, y] = view.convertToPdfPoint((clientX - box.left) * view.width / box.width, (clientY - box.top) * view.height / box.height) as [number, number];
  const hit = { page: number, x, y, pageWidth: Math.abs(view.viewBox[2] - view.viewBox[0]), clientX, clientY };
  // The runs on the clicked line, the nearest along it first.
  let best: { run: number; distance: number } | null = null;
  runs.forEach((run, index) => {
    if (y < run.y - 0.3 * run.size || y > run.y + 0.9 * run.size || run.glyphs.length === 0) return;
    const last = run.glyphs[run.glyphs.length - 1];
    const right = run.x + last.x + last.width;
    const distance = x < run.x ? run.x - x : x > right ? x - right : 0;
    if (distance > 1.5 * run.size) return;
    const vertical = Math.abs(y - (run.y + 0.3 * run.size));
    if (!best || distance + vertical * 0.01 < best.distance) best = { run: index, distance: distance + vertical * 0.01 };
  });
  if (!best) return { ...hit, item: -1, offset: 0, side: 'before' };
  const index = (best as { run: number }).run;
  const run = runs[index];
  const along = x - run.x;
  const glyph = run.glyphs.find((candidate) => along < candidate.x + candidate.width) ?? run.glyphs[run.glyphs.length - 1];
  const side = along < glyph.x + glyph.width / 2 ? 'before' : 'after';
  return { ...hit, item: number * 100000 + index, offset: glyph.offset, side };
}

/** A glyph's box in the window: across, the glyph's advance; down, a font size from just above its baseline. */
function glyphBox(drawn: DrawnPage, spot: Spot): DOMRect | null {
  const run = drawn.runs[itemIndex(spot.item)];
  if (!run || run.glyphs.length === 0) return null;
  const glyph = [...run.glyphs].reverse().find((candidate) => candidate.offset <= spot.offset) ?? run.glyphs[0];
  const box = drawn.frame.getBoundingClientRect();
  const across = box.width / drawn.width;
  const down = box.height / drawn.height;
  return new DOMRect(box.left + (run.x + glyph.x) * across, box.top + (drawn.height - run.y - 0.8 * run.size) * down, glyph.width * across, 1.05 * run.size * down);
}

/** The glyphs a doc's fonts have, by the text they stand for: the character to draw and its advance per em. */
const fontGlyphs = new WeakMap<PDFDocumentProxy, Map<string, Map<string, { char: string; em: number }>>>();

function learnGlyphs(doc: PDFDocumentProxy, runs: GlyphRun[]): void {
  let fonts = fontGlyphs.get(doc);
  if (!fonts) fontGlyphs.set(doc, (fonts = new Map()));
  for (const run of runs) {
    let known = fonts.get(run.font);
    if (!known) fonts.set(run.font, (known = new Map()));
    for (const glyph of run.glyphs) if (glyph.text && !known.has(glyph.text)) known.set(glyph.text, { char: glyph.char, em: glyph.width / (run.size * (run.scaleX || 1)) });
  }
}

/**
 * Typed text TeX has not set yet, drawn at the caret in the run's own font (a character the font has never shown
 * falls back to a serif), the rest of the line moved right to make room. Returns its width in PDF points and how
 * to put the page back.
 */
function showPending(drawn: DrawnPage, spot: CaretSpot, pending: string): { width: number; undo: () => void } {
  const index = itemIndex(spot.item);
  const run = drawn.runs[index];
  const svg = drawn.texts[0]?.ownerSVGElement;
  if (!run || !svg || !pending) return { width: 0, undo: () => undefined };
  const known = fontGlyphs.get(drawn.doc)?.get(run.font) ?? new Map<string, { char: string; em: number }>();
  const at = run.glyphs.findIndex((glyph) => glyph.offset >= spot.offset);
  const split = at < 0 ? run.glyphs.length : spot.side === 'after' ? at + 1 : at;
  const start = run.x + (split < run.glyphs.length ? run.glyphs[split].x : run.glyphs[run.glyphs.length - 1].x + run.glyphs[run.glyphs.length - 1].width);
  measurer ??= document.createElement('canvas').getContext('2d');
  const text = document.createElementNS(SVG, 'text');
  text.setAttribute('font-size', String(run.size));
  text.setAttribute('fill', run.color);
  text.setAttribute('y', String(drawn.height - run.y));
  let width = 0;
  for (const char of pending) {
    const glyph = known.get(char);
    const span = document.createElementNS(SVG, 'tspan');
    span.setAttribute('x', String(start + width));
    if (glyph) {
      span.setAttribute('font-family', run.font);
      span.textContent = glyph.char;
      width += glyph.em * run.size * (run.scaleX || 1);
    } else {
      span.setAttribute('font-family', 'serif');
      span.textContent = char;
      if (measurer) {
        measurer.font = `${run.size}px serif`;
        width += measurer.measureText(char).width;
      }
    }
    text.append(span);
  }
  svg.append(text);
  // The rest of the line: this run from the caret on, and the runs after it until a gap wider than a column's.
  const moved: number[] = [];
  placeRun(drawn.texts[index], run, drawn.height, width, split);
  moved.push(index);
  let edge = run.x + (run.glyphs[run.glyphs.length - 1].x + run.glyphs[run.glyphs.length - 1].width);
  for (let next = index + 1; next < drawn.runs.length; next += 1) {
    const other = drawn.runs[next];
    if (Math.abs(other.y - run.y) > 0.3 * run.size || other.x < edge - 0.5 || other.x - edge > 3 * run.size || other.glyphs.length === 0) break;
    placeRun(drawn.texts[next], other, drawn.height, width, 0);
    moved.push(next);
    edge = other.x + other.glyphs[other.glyphs.length - 1].x + other.glyphs[other.glyphs.length - 1].width;
  }
  return {
    width,
    undo: () => {
      text.remove();
      for (const which of moved) placeRun(drawn.texts[which], drawn.runs[which], drawn.height, 0, -1);
    },
  };
}

/** One page: drawn (canvas, text, links) once it comes near the screen, and again when the PDF or scale changes. */
const Page: React.FC<{
  doc: PDFDocumentProxy;
  number: number;
  size: Size;
  scale: number;
  root: HTMLElement | null;
  onLink: (page: number, y: number) => void;
  onDoubleClick: (click: PdfClick) => void;
  onClick?: (click: PageClick) => void;
  onDrawn: (number: number, drawn: DrawnPage | null) => void;
  flash: number | null;
  onTextLayer?: (page: number, layer: HTMLElement | null) => void;
  children?: React.ReactNode;
}> = ({ doc, number, size, scale, root, onLink, onDoubleClick, onClick, onDrawn, flash, onTextLayer, children }) => {
  const frame = useRef<HTMLDivElement>(null);
  const layers = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const drawn = useRef<DrawnPage | null>(null);
  const renderedDoubleClick = useRef<Props['onDoubleClick'] | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: '150% 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => () => onDrawn(number, null), [number, onDrawn]);
  const textLayerRef = useRef(onTextLayer);
  textLayerRef.current = onTextLayer;
  useEffect(() => () => textLayerRef.current?.(number, null), [number]);

  // The page keeps showing what it last drew until the new drawing is ready, so a new PDF never flashes blank.
  useEffect(() => {
    const target = layers.current;
    if (!near || !target) return undefined;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const ratio = window.devicePixelRatio || 1;
      const view = page.getViewport({ scale });
      const base = page.getViewport({ scale: 1 });
      // Text the PDF sets upright and filled is drawn as SVG in its own fonts; the canvas draws everything else.
      const { runs, drawn: asText } = await pageRuns(page);
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(view.width * ratio);
      canvas.height = Math.floor(view.height * ratio);
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
      canvas.style.display = 'block';
      await page.render({ canvas, viewport: page.getViewport({ scale: scale * ratio }), operationsFilter: (index: number) => !asText.has(index) }).promise;
      if (cancelled) return;
      const glyphs = glyphLayer(runs, base.width, base.height);
      const { layer: text, spans } = selectionLayer(runs, base.width, base.height, scale);
      const links = renderPdfLinks({
        annotations: await page.getAnnotations({ intent: 'display' }),
        viewport: view,
        onDestination: (destination) => {
          void (async () => {
            const resolved = typeof destination === 'string' ? await doc.getDestination(destination) : destination;
            if (!resolved || !resolved[0] || typeof resolved[0] !== 'object') return;
            const index = await doc.getPageIndex(resolved[0] as { num: number; gen: number });
            const y = typeof resolved[3] === 'number' ? resolved[3] : size.height;
            onLink(index + 1, y);
          })().catch(() => undefined);
        },
      });
      if (cancelled || !frame.current) return;
      renderedDoubleClick.current = onDoubleClick;
      target.replaceChildren(canvas, glyphs.svg, text, links);
      drawn.current = { doc, frame: frame.current, spans, items: runItems(runs), view, runs, texts: glyphs.texts, width: base.width, height: base.height };
      learnGlyphs(doc, runs);
      onDrawn(number, drawn.current);
      textLayerRef.current?.(number, text);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, number, scale, near, size.height, onLink, onDrawn]);

  const doubleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest?.('button, [data-page-control]')) return;
    const current = drawn.current;
    const box = frame.current?.getBoundingClientRect();
    if (!current || !box) return;
    const { view } = current;
    const [x, y] = view.convertToPdfPoint(
      (event.clientX - box.left) * view.width / box.width,
      (event.clientY - box.top) * view.height / box.height,
    ) as [number, number];
    const target = event.target;
    const index = target instanceof Node ? current.spans.findIndex((span) => span.contains(target)) : -1;
    const hit = pdfTextAt(current.items, x, y, index < 0 ? undefined : index);
    const selected = selectedPdfWord(window.getSelection(), index < 0 ? undefined : current.spans[index], event.clientX, event.clientY);
    renderedDoubleClick.current?.({
      page: number, x, y, baseline: hit?.baseline,
      pageWidth: Math.abs(view.viewBox[2] - view.viewBox[0]),
      word: pdfClickWord(selected, hit?.word || ''), context: hit?.context ?? '', rowContext: hit?.rowContext,
      contextOffset: hit?.contextOffset, rowContextOffset: hit?.rowContextOffset,
    });
  };

  const mouseUp = (event: React.MouseEvent) => {
    // The second click of a double click belongs to the double click; a drag that selected text is a selection.
    if (!onClick || event.button !== 0 || event.detail > 1 || !drawn.current) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    if ((event.target as HTMLElement).closest?.('a, button, [data-page-control]')) return;
    const click = glyphAt(drawn.current, number, event.clientX, event.clientY);
    if (click) onClick(click);
  };

  return (
    <div
      ref={frame}
      data-page={number}
      onDoubleClick={doubleClick}
      onMouseUp={mouseUp}
      className="relative mx-auto bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12),0_8px_24px_-12px_rgba(0,0,0,0.25)]"
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      <div ref={layers} className="absolute inset-0" />
      {children}
      {flash !== null && (
        <div
          aria-hidden="true"
          className="writing-flash pointer-events-none absolute inset-x-0 h-6 -translate-y-1/2 bg-violet-400/25"
          style={{ top: (size.height - flash) * scale }}
        />
      )}
    </div>
  );
};

/** Every page of a PDF, one under another, fitted to the pane and drawn as they come near the screen. */
const PdfPages = React.forwardRef<PdfPagesHandle, Props>(function PdfPages(
  { data, url, flow = false, overlay, onLoaded, onTextLayer, zoom, onDoubleClick, onDocumentReady, onClick, editing = false, caret, outline, pending = '', onCaretText, onCaretKey, onCaretLeave },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [loaded, setLoaded] = useState<{ doc: PDFDocumentProxy; data?: Uint8Array; onDoubleClick: Props['onDoubleClick']; onClick: Props['onClick'] } | null>(null);
  const task = useRef<PDFDocumentLoadingTask | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [width, setWidth] = useState(0);
  const [flash, setFlash] = useState<{ page: number; y: number; key: number } | null>(null);
  const pages = useRef(new Map<number, DrawnPage>());
  const texts = useRef<{ doc: PDFDocumentProxy | null; pages: Map<number, Promise<PageText | undefined>> }>({ doc: null, pages: new Map() });
  // Bumped whenever a page is drawn again, so the caret is placed on the new drawing.
  const [drawing, setDrawing] = useState(0);
  const [caretPlace, setCaretPlace] = useState<{ left: number; top: number; height: number } | null>(null);
  // Puts back what the typed text shown at the caret moved (showPending).
  const preview = useRef<(() => void) | null>(null);
  const [outlinePlace, setOutlinePlace] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const handlers = useRef({ onCaretText, onCaretKey, onCaretLeave });
  handlers.current = { onCaretText, onCaretKey, onCaretLeave };

  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new PDF replaces the old one only once it is open, so the pane never goes blank while compiling.
  useEffect(() => {
    if (!data && !url) return undefined;
    let cancelled = false;
    // Keep the callbacks' compiled-source snapshot paired with the PDF that actually reaches the screen.
    const handleDoubleClick = onDoubleClick;
    const handleClick = onClick;
    (async () => {
      const loading = await openPdf(data ? { data: data.slice() } : { url: url as string });
      const next = await loading.promise;
      const all = await Promise.all(Array.from({ length: next.numPages }, (_, index) => next.getPage(index + 1)));
      if (cancelled) {
        void loading.destroy();
        return;
      }
      setSizes(all.map((page) => page.getViewport({ scale: 1 })).map(({ width: w, height: h }) => ({ width: w, height: h })));
      // The previous document is let go once the new one is on screen.
      const previous = task.current;
      task.current = loading;
      setLoaded({ doc: next, data, onDoubleClick: handleDoubleClick, onClick: handleClick });
      window.setTimeout(() => void previous?.destroy(), 1000);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [data, url]);

  useEffect(() => {
    if (loaded?.data) onDocumentReady?.(loaded.data);
  }, [loaded, onDocumentReady]);
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  useEffect(() => {
    if (loaded) loadedRef.current?.();
  }, [loaded]);

  const widest = Math.max(1, ...sizes.map((size) => size.width));
  const scale = (Math.max(200, width - (flow ? 0 : 2 * GAP)) / widest) * zoom;

  const show = useCallback(
    (page: number, y: number) => {
      const element = scroller.current;
      const target = element?.querySelector<HTMLElement>(`[data-page="${page}"]`);
      const size = sizes[page - 1];
      if (!element || !target || !size) return;
      if (flow) {
        const top = target.getBoundingClientRect().top + window.scrollY + (size.height - y) * scale;
        window.scrollTo({ top: Math.max(0, top - window.innerHeight / 3), behavior: 'smooth' });
      } else {
        const top = target.offsetTop + (size.height - y) * scale;
        element.scrollTo({ top: Math.max(0, top - element.clientHeight / 3), behavior: 'smooth' });
      }
      setFlash({ page, y, key: Date.now() });
    },
    [sizes, scale, flow],
  );

  const pointAt = useCallback(
    (clientX: number, clientY: number) => {
      const frames = scroller.current?.querySelectorAll<HTMLElement>('[data-page]') ?? [];
      for (const frame of Array.from(frames)) {
        const box = frame.getBoundingClientRect();
        if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) continue;
        const page = Number(frame.dataset.page);
        const size = sizes[page - 1];
        if (!size) return null;
        return { page, x: ((clientX - box.left) / box.width) * size.width, y: size.height - ((clientY - box.top) / box.height) * size.height };
      }
      return null;
    },
    [sizes],
  );

  const onDrawn = useCallback((number: number, page: DrawnPage | null) => {
    if (page) pages.current.set(number, page);
    else pages.current.delete(number);
    setDrawing((value) => value + 1);
  }, []);

  const pageText = useCallback(
    (number: number): Promise<PageText | undefined> => {
      const doc = loaded?.doc;
      if (!doc || number < 1 || number > doc.numPages) return Promise.resolve(undefined);
      if (texts.current.doc !== doc) texts.current = { doc, pages: new Map() };
      let text = texts.current.pages.get(number);
      if (!text) {
        text = (async () => {
          const page = await doc.getPage(number);
          const view = page.getViewport({ scale: 1 });
          // The same runs, in the same order, as the page draws: items and spans share their numbers.
          const { runs } = await pageRuns(page);
          return { width: view.width, height: view.height, items: runItems(runs) };
        })().catch(() => undefined);
        texts.current.pages.set(number, text);
      }
      return text;
    },
    [loaded],
  );

  const hitAt = useCallback((clientX: number, clientY: number): PageClick | null => {
    for (const [number, page] of pages.current) {
      const found = glyphAt(page, number, clientX, clientY);
      if (found) return found;
    }
    return null;
  }, []);

  const pictures = useCallback(
    async (number: number): Promise<Box[]> => {
      const doc = loaded?.doc;
      if (!doc || number < 1 || number > doc.numPages) return [];
      const [pdfjs, page] = await Promise.all([loadPdfjs(), doc.getPage(number)]);
      const list = await page.getOperatorList();
      return imageBoxes(list.fnArray, list.argsArray, pdfjs.OPS);
    },
    [loaded],
  );

  useImperativeHandle(
    ref,
    () => ({ show, pageText, hitAt, pictures, pointAt, pageCount: () => loaded?.doc.numPages ?? 0, caretBox: () => input.current?.getBoundingClientRect() ?? null }),
    [show, pageText, hitAt, pictures, pointAt, loaded],
  );

  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // The caret and the outline, placed on the pages as drawn from the PDF on screen; a page still showing the
  // previous PDF keeps them where they were until it is drawn again.
  useLayoutEffect(() => {
    const origin = sheet.current?.getBoundingClientRect();
    const spots = [caret, outline?.[0], outline?.[1]].filter((spot): spot is Spot => Boolean(spot));
    // Typing shown before stays until its page is drawn again from the new PDF, so it never blinks out.
    if (spots.some((spot) => pages.current.get(itemPage(spot.item))?.doc !== loaded?.doc)) return;
    preview.current?.();
    preview.current = null;
    const place = (spot: Spot): DOMRect | null => {
      const page = pages.current.get(itemPage(spot.item));
      return page && origin ? glyphBox(page, spot) : null;
    };
    const glyph = caret ? place(caret) : null;
    // Typing TeX has not set yet shows at the caret, in the page's own type, the caret after it.
    const caretPage = caret ? pages.current.get(itemPage(caret.item)) : undefined;
    const shown = caret && caretPage && pending ? showPending(caretPage, caret, pending) : null;
    preview.current = shown?.undo ?? null;
    const extra = shown && caretPage ? (shown.width * caretPage.frame.getBoundingClientRect().width) / caretPage.width : 0;
    setCaretPlace(glyph && origin ? { left: (caret!.side === 'before' ? glyph.left : glyph.right) - origin.left + extra, top: glyph.top - origin.top, height: glyph.height } : null);
    const first = outline ? place(outline[0]) : null;
    const last = outline ? place(outline[1]) : null;
    setOutlinePlace(
      first && last && origin
        ? {
            left: Math.min(first.left, last.left) - origin.left - 1,
            top: Math.min(first.top, last.top) - origin.top - 1,
            width: Math.max(first.right, last.right) - Math.min(first.left, last.left) + 2,
            height: Math.max(first.bottom, last.bottom) - Math.min(first.top, last.top) + 2,
          }
        : null,
    );
  }, [caret, outline, drawing, scale, loaded, pending]);
  useLayoutEffect(() => () => preview.current?.(), []);

  // Keys go to a hidden text box at the caret, which also places an input method's candidates there.
  useEffect(() => {
    const box = input.current;
    if (!box || !editing) return undefined;
    if (document.activeElement !== box) box.focus({ preventScroll: true });
    let composing = false;
    const beforeInput = (event: InputEvent) => {
      if (composing || event.isComposing) return;
      event.preventDefault();
      const text =
        event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak'
          ? '\n'
          : event.inputType.startsWith('insert')
            ? event.dataTransfer?.getData('text/plain') ?? event.data ?? ''
            : '';
      if (text) handlers.current.onCaretText?.(text);
    };
    const compositionStart = () => {
      composing = true;
    };
    const compositionEnd = (event: CompositionEvent) => {
      composing = false;
      box.value = '';
      if (event.data) handlers.current.onCaretText?.(event.data);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing || composing) return;
      handlers.current.onCaretKey?.(event);
    };
    const blur = () => handlers.current.onCaretLeave?.();
    box.addEventListener('beforeinput', beforeInput);
    box.addEventListener('compositionstart', compositionStart);
    box.addEventListener('compositionend', compositionEnd);
    box.addEventListener('keydown', keyDown);
    box.addEventListener('blur', blur);
    return () => {
      box.removeEventListener('beforeinput', beforeInput);
      box.removeEventListener('compositionstart', compositionStart);
      box.removeEventListener('compositionend', compositionEnd);
      box.removeEventListener('keydown', keyDown);
      box.removeEventListener('blur', blur);
    };
  }, [editing]);

  return (
    <div ref={scroller} className={flow ? '' : 'h-full overflow-auto bg-[#e9e9ec] py-3'}>
      {loaded && (
        <div ref={sheet} className="relative flex flex-col" style={{ gap: GAP }}>
          {sizes.map((size, index) => (
            <Page
              key={index}
              doc={loaded.doc}
              number={index + 1}
              size={size}
              scale={scale}
              root={flow ? null : scroller.current}
              onLink={show}
              onDoubleClick={loaded.onDoubleClick}
              onClick={loaded.onClick}
              onDrawn={onDrawn}
              flash={flash && flash.page === index + 1 ? flash.y : null}
              onTextLayer={onTextLayer}
            >
              {overlay?.(index + 1, scale, size)}
            </Page>
          ))}
          {outlinePlace && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-[3] rounded-[2px] border border-dashed border-violet-500 bg-violet-500/[0.06]"
              style={outlinePlace}
            />
          )}
          {caretPlace && (
            <div
              aria-hidden="true"
              className="writing-caret pointer-events-none absolute z-[3] w-[1.5px] bg-violet-700"
              style={{ left: caretPlace.left - 0.75, top: caretPlace.top, height: caretPlace.height }}
            />
          )}
          {editing && (
            <textarea
              ref={input}
              aria-label={t('在页面上输入')}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="absolute z-[4] w-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
              style={{ left: caretPlace?.left ?? outlinePlace?.left ?? 0, top: caretPlace?.top ?? outlinePlace?.top ?? 0, height: caretPlace?.height ?? outlinePlace?.height ?? 16 }}
            />
          )}
        </div>
      )}
    </div>
  );
});

export default PdfPages;
