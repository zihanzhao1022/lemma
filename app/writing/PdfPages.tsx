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
import { Glyph, GlyphRun, glyphReader, glyphRuns } from './pdfGlyphs';
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
  /** The first (-1) or last (1) glyph of the line the caret is on, as a click on its outer side. */
  lineEdge: (direction: -1 | 1) => PageClick | null;
  /** Sends the keys to the caret's text box now, so the key being pressed types there. */
  focusInput: () => void;
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
  /** Glyphs taken out since TeX set the page, left out until it is set again. */
  hidden?: Spot[];
  /** Text selected on the pages: its first and last glyphs, as clicks before the first and after the last. */
  onSelection?: (ends: { start: PageClick; end: PageClick } | null) => void;
  /** A key pressed while text is selected on the pages and no text box has the keys. */
  onSelectionKey?: (event: KeyboardEvent) => void;
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
type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;

const fontsOf = (page: PdfPage) => (name: string) => {
  try {
    return page.commonObjs.has(name) ? page.commonObjs.get(name) : undefined;
  } catch {
    return undefined;
  }
};

async function pageRuns(page: PdfPage): Promise<{ runs: GlyphRun[]; drawn: Set<number> }> {
  const pdfjs = await loadPdfjs();
  const list = await page.getOperatorList();
  return glyphRuns(list.fnArray, list.argsArray, pdfjs.OPS, fontsOf(page));
}

/**
 * Renders the page on the canvas without the text the runs draw. The canvas works from pdf.js's own operator
 * list, whose indices differ from getOperatorList's (its optimizer merges operators), so the runs are read from
 * that list as the canvas reaches each operator. Without access to it, the canvas draws the text as well.
 */
async function renderWithoutText(page: PdfPage, canvas: HTMLCanvasElement, viewport: PageViewport): Promise<GlyphRun[]> {
  const pdfjs = await loadPdfjs();
  const reader = glyphReader(pdfjs.OPS, fontsOf(page));
  let task: ReturnType<PdfPage['render']> | null = null;
  const list = () => (task as unknown as { _internalRenderTask?: { operatorList?: { fnArray: number[]; argsArray: unknown[] } } } | null)?._internalRenderTask?.operatorList;
  let read = false;
  task = page.render({
    canvas,
    viewport,
    operationsFilter: (index: number) => {
      const ops = list();
      if (!ops || !Array.isArray(ops.fnArray)) return true;
      read = true;
      return !reader.readTo(ops.fnArray, ops.argsArray, index);
    },
  });
  await task.promise;
  return read ? reader.runs : (await pageRuns(page)).runs;
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
    placeRun(text, run, height, null);
    svg.append(text);
    return text;
  });
  return { svg, texts };
}

/** Sets a run's glyphs in its SVG text, each moved right by its `shifts` (PDF points), those in `skip` left out. */
function placeRun(text: SVGTextElement, run: GlyphRun, height: number, shifts: number[] | null, skip?: Set<number>): void {
  const scale = run.scaleX || 1;
  const kept = run.glyphs.map((glyph, index) => ({ glyph, index })).filter(({ index }) => !skip?.has(index));
  text.setAttribute('font-family', run.font);
  text.setAttribute('font-size', String(run.size));
  text.setAttribute('fill', run.color);
  text.setAttribute('y', String(height - run.y));
  text.setAttribute('x', kept.map(({ glyph, index }) => run.x + (glyph.x + (shifts?.[index] ?? 0)) / scale).join(' '));
  if (scale !== 1) text.setAttribute('transform', `matrix(${scale} 0 0 1 ${run.x * (1 - scale)} 0)`);
  else text.removeAttribute('transform');
  text.textContent = kept.map(({ glyph }) => glyph.char).join('');
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

/** A click on a run's glyph, on one side of it. */
function clickOn(drawn: DrawnPage, number: number, index: number, glyph: Glyph, side: 'before' | 'after'): PageClick {
  const run = drawn.runs[index];
  const box = drawn.frame.getBoundingClientRect();
  const x = run.x + glyph.x + glyph.width / 2;
  const y = run.y + 0.3 * run.size;
  return {
    page: number, x, y, baseline: run.y, pageWidth: drawn.width,
    clientX: box.left + (x * box.width) / drawn.width, clientY: box.top + ((drawn.height - y) * box.height) / drawn.height,
    item: number * 100000 + index, offset: glyph.offset, side,
  };
}

const glyphHolding = (run: GlyphRun, offset: number): Glyph | undefined =>
  run.glyphs.find((glyph) => offset >= glyph.offset && offset < glyph.offset + Math.max(1, glyph.text.length)) ?? (offset >= run.str.length ? run.glyphs[run.glyphs.length - 1] : undefined);

/** The first and last glyphs of the window's selection on the drawn pages: a click before the first, after the last. */
function selectionEnds(selection: Selection | null, pages: Map<number, DrawnPage>): { start: PageClick; end: PageClick } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  let start: PageClick | null = null;
  let end: PageClick | null = null;
  for (const number of [...pages.keys()].sort((a, b) => a - b)) {
    const drawn = pages.get(number)!;
    drawn.spans.forEach((span, index) => {
      const run = drawn.runs[index];
      if (!run || run.glyphs.length === 0 || !span.isConnected || !range.intersectsNode(span)) return;
      const from = span.contains(range.startContainer) ? range.startOffset : 0;
      const to = span.contains(range.endContainer) ? range.endOffset : run.str.length;
      if (to <= from) return;
      const first = glyphHolding(run, from);
      const last = glyphHolding(run, to - 1);
      if (!start && first) start = clickOn(drawn, number, index, first, 'before');
      if (last) end = clickOn(drawn, number, index, last, 'after');
    });
  }
  return start && end ? { start, end } : null;
}

/** The first (-1) or last (1) glyph of the line a run is on: the runs beside it on its baseline, up to a column's gap. */
function lineEdgeOf(drawn: DrawnPage, number: number, index: number, direction: -1 | 1): PageClick | null {
  const { runs } = drawn;
  const run = runs[index];
  if (!run || run.glyphs.length === 0) return null;
  const right = (other: GlyphRun) => other.x + other.glyphs[other.glyphs.length - 1].x + other.glyphs[other.glyphs.length - 1].width;
  let at = index;
  for (;;) {
    const next = runs[at + direction];
    const current = runs[at];
    if (!next || next.glyphs.length === 0 || Math.abs(next.y - current.y) > 0.3 * current.size) break;
    const gap = direction > 0 ? next.x - right(current) : current.x - right(next);
    if (gap < -0.5 || gap > 3 * current.size) break;
    at += direction;
  }
  const edge = runs[at];
  return direction < 0 ? clickOn(drawn, number, at, edge.glyphs[0], 'before') : clickOn(drawn, number, at, edge.glyphs[edge.glyphs.length - 1], 'after');
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
 * What changed since TeX last set the page, drawn on it at once: the glyphs taken out (`hidden`) are left out, typed
 * text TeX has not set yet is drawn at the caret in the run's own font (a character the font has never shown falls
 * back to a serif), and the rest of the caret's line closes up or moves right to fit. Returns how to put it back.
 */
function showEdit(pages: Map<number, DrawnPage>, spot: CaretSpot, pending: string, hidden: Spot[]): { width: number; undo: () => void } {
  const drawn = pages.get(itemPage(spot.item));
  const index = itemIndex(spot.item);
  const run = drawn?.runs[index];
  const svg = drawn?.texts[0]?.ownerSVGElement;
  if (!drawn || !run || !svg || (!pending && hidden.length === 0)) return { width: 0, undo: () => undefined };
  // The glyphs left out, by page and run.
  const gone = new Map<DrawnPage, Map<number, Set<number>>>();
  for (const out of hidden) {
    const page = pages.get(itemPage(out.item));
    const other = page?.runs[itemIndex(out.item)];
    if (!page || !other) continue;
    const glyph = other.glyphs.findIndex((candidate) => out.offset >= candidate.offset && out.offset < candidate.offset + Math.max(1, candidate.text.length));
    if (glyph < 0) continue;
    if (!gone.has(page)) gone.set(page, new Map());
    const runs = gone.get(page)!;
    if (!runs.has(itemIndex(out.item))) runs.set(itemIndex(out.item), new Set());
    runs.get(itemIndex(out.item))!.add(glyph);
  }
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
  if (pending) svg.append(text);
  // The caret's line from the caret on: this run, then the runs after it until a gap wider than a column's. Each
  // glyph moves right by the typed text's width and left by the width of the glyphs left out before it on the line.
  const placed: { page: DrawnPage; run: number }[] = [];
  const line = new Set<number>([index]);
  let edge = run.x + run.glyphs[run.glyphs.length - 1].x + run.glyphs[run.glyphs.length - 1].width;
  for (let next = index + 1; next < drawn.runs.length; next += 1) {
    const other = drawn.runs[next];
    if (Math.abs(other.y - run.y) > 0.3 * run.size || other.x < edge - 0.5 || other.x - edge > 3 * run.size || other.glyphs.length === 0) break;
    line.add(next);
    edge = other.x + other.glyphs[other.glyphs.length - 1].x + other.glyphs[other.glyphs.length - 1].width;
  }
  let closed = 0;
  for (const which of [...line].sort((a, b) => a - b)) {
    const other = drawn.runs[which];
    const skip = gone.get(drawn)?.get(which) ?? new Set<number>();
    const shifts = other.glyphs.map((glyph, glyphIndex) => {
      const moved = which > index || glyphIndex >= split ? width - closed : 0;
      if (skip.has(glyphIndex) && (which > index || glyphIndex >= split)) closed += glyph.width;
      return moved;
    });
    placeRun(drawn.texts[which], other, drawn.height, shifts, skip);
    placed.push({ page: drawn, run: which });
  }
  // Glyphs left out on other lines are only left out.
  for (const [page, runs] of gone) {
    for (const [which, skip] of runs) {
      if (page === drawn && line.has(which)) continue;
      placeRun(page.texts[which], page.runs[which], page.height, null, skip);
      placed.push({ page, run: which });
    }
  }
  return {
    width,
    undo: () => {
      text.remove();
      for (const { page, run: which } of placed) placeRun(page.texts[which], page.runs[which], page.height, null);
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
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(view.width * ratio);
      canvas.height = Math.floor(view.height * ratio);
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
      canvas.style.display = 'block';
      // Text the PDF sets upright and filled is drawn as SVG in its own fonts; the canvas draws everything else.
      const runs = await renderWithoutText(page, canvas, page.getViewport({ scale: scale * ratio }));
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
  { data, url, flow = false, overlay, onLoaded, onTextLayer, zoom, onDoubleClick, onDocumentReady, onClick, editing = false, caret, outline, pending = '', hidden, onCaretText, onCaretKey, onCaretLeave, onSelection, onSelectionKey },
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
  // Puts back what showEdit changed on the page.
  const preview = useRef<(() => void) | null>(null);
  const [outlinePlace, setOutlinePlace] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const handlers = useRef({ onCaretText, onCaretKey, onCaretLeave, onSelection, onSelectionKey });
  handlers.current = { onCaretText, onCaretKey, onCaretLeave, onSelection, onSelectionKey };
  const selected = useRef<{ start: PageClick; end: PageClick } | null>(null);
  const caretRef = useRef(caret);
  caretRef.current = caret;

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
    () => ({
      show, pageText, hitAt, pictures, pointAt,
      pageCount: () => loaded?.doc.numPages ?? 0,
      caretBox: () => input.current?.getBoundingClientRect() ?? null,
      lineEdge: (direction: -1 | 1) => {
        const spot = caretRef.current;
        const page = spot ? pages.current.get(itemPage(spot.item)) : undefined;
        return spot && page ? lineEdgeOf(page, itemPage(spot.item), itemIndex(spot.item), direction) : null;
      },
      focusInput: () => input.current?.focus({ preventScroll: true }),
    }),
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
    const spots = [caret, outline?.[0], outline?.[1], ...(hidden ?? [])].filter((spot): spot is Spot => Boolean(spot));
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
    const shown = caret && caretPage && (pending || hidden?.length) ? showEdit(pages.current, caret, pending, hidden ?? []) : null;
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
  }, [caret, outline, drawing, scale, loaded, pending, hidden]);
  useLayoutEffect(() => () => preview.current?.(), []);

  // Keys go to a hidden text box at the caret, which also places an input method's candidates there.
  useEffect(() => {
    const box = input.current;
    if (box && editing && document.activeElement !== box) box.focus({ preventScroll: true });
  }, [editing, loaded]);
  useEffect(() => {
    const box = input.current;
    if (!box) return undefined;
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
  }, [loaded, Boolean(onCaretText)]);

  // Text selected on the pages, and keys pressed while it is: they act on the selection.
  useEffect(() => {
    if (!onSelection && !onSelectionKey) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const ends = selectionEnds(window.getSelection(), pages.current);
      const before = selected.current;
      selected.current = ends;
      if (ends || before) handlers.current.onSelection?.(ends);
    };
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 60);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !selected.current) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
      if (window.getSelection()?.isCollapsed !== false) return;
      handlers.current.onSelectionKey?.(event);
    };
    document.addEventListener('selectionchange', changed);
    document.addEventListener('keydown', keyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', changed);
      document.removeEventListener('keydown', keyDown);
    };
  }, [Boolean(onSelection), Boolean(onSelectionKey)]);

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
          {onCaretText && (
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
