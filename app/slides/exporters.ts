/**
 * A deck as files to take elsewhere. The PDF keeps each block of the paper as the vector PDF it was compiled to;
 * the PowerPoint file has editable text and the blocks as 300 dpi pictures (PowerPoint cannot hold PDF).
 * A Beamer deck goes out as its own compiled PDF, and as one picture a slide in PowerPoint.
 */
import { openPdf } from '../../components/results/pdfjs';
import type { ReadFile } from '../../editor/results/actions';
import { ResultPaper, SlideDeck, SlideText } from '../../types';
import { SLIDE_HEIGHT, SLIDE_WIDTH, fit } from './deck';
import { BODY_FONT, TITLE_FONT, blockBytes, drawPdf, textLines } from './SlideView';

/** 1600 slide units are 960 points, or 13.333 inches: PowerPoint's widescreen page. */
const POINTS = 960 / SLIDE_WIDTH;
const INCHES = 13.333 / SLIDE_WIDTH;
/** Pictures of blocks in a .pptx, in dots per inch. */
const DPI = 300;

const fileName = (title: string, extension: string): string => `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'slides'}.${extension}`;

function download(data: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data.slice()], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const pngBytes = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject) : reject(new Error('png'))), 'image/png'),
  );

/** Lines of text broken to a width: at spaces for words, anywhere between Chinese and Japanese characters. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const pieces = text.match(/[\u3000-\u9fff\uff00-\uffef]|[^\s\u3000-\u9fff\uff00-\uffef]+|\s+/g) ?? [];
  const rows: string[] = [];
  let row = '';
  for (const piece of pieces) {
    const next = row + piece;
    if (row.trim() && context.measureText(next).width > width) {
      rows.push(row.trimEnd());
      row = piece.trimStart();
    } else row = next;
  }
  rows.push(row);
  return rows;
}

/**
 * Slide text drawn the way the slide shows it, `density` pixels per slide unit, on a clear background. Text that
 * runs past its box runs on below it, as on the slide: `height` is how tall it came out, in slide units.
 */
export function textCanvas(element: SlideText, density: number): { canvas: HTMLCanvasElement; height: number } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(element.w * density));
  const size = element.size * density;
  const line = size * 1.3;
  const font = `${element.bold ? 700 : 400} ${size}px ${element.role === 'title' ? TITLE_FONT : BODY_FONT}`;
  const measure = canvas.getContext('2d');
  if (!measure) return { canvas, height: element.h };
  measure.font = font;
  const count = textLines(element.text).reduce((sum, item) => sum + wrap(measure, item.content, canvas.width - (item.bullet ? (item.level * 1.2 + 1) * size : 0)).length, 0);
  canvas.height = Math.max(1, Math.ceil(Math.max(element.h * density, count * line)));
  const context = canvas.getContext('2d');
  if (!context) return { canvas, height: element.h };
  context.font = font;
  context.fillStyle = '#1d1d1f';
  context.textBaseline = 'middle';
  let y = 0;
  for (const item of textLines(element.text)) {
    const indent = item.bullet ? (item.level * 1.2 + 1) * size : 0;
    const rows = wrap(context, item.content, canvas.width - indent);
    rows.forEach((row, index) => {
      if (item.bullet && index === 0) {
        context.textAlign = 'left';
        context.fillText(item.level > 0 ? '–' : '•', item.level * 1.2 * size, y + line / 2);
      }
      const align = element.align ?? 'left';
      context.textAlign = align;
      const x = align === 'left' ? indent : align === 'center' ? indent + (canvas.width - indent) / 2 : canvas.width;
      context.fillText(row, x, y + line / 2);
      y += line;
    });
  }
  return { canvas, height: canvas.height / density };
}

/** Every page of a PDF as a PNG data URL `width` pixels wide, with the page's width over its height. */
async function pagePictures(data: Uint8Array, width: number): Promise<{ data: string; aspect: number }[]> {
  const task = await openPdf({ data: data.slice() });
  try {
    const doc = await task.promise;
    const pictures: { data: string; aspect: number }[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const scale = width / page.getViewport({ scale: 1 }).width;
      const canvas = document.createElement('canvas');
      const viewport = page.getViewport({ scale });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport }).promise;
      pictures.push({ data: canvas.toDataURL('image/png'), aspect: viewport.width / viewport.height });
    }
    return pictures;
  } finally {
    void task.destroy();
  }
}

/** The deck as a PDF: blocks stay vector; text is drawn as on screen (any language, the slide's own fonts). */
export async function exportPdf(deck: SlideDeck, paper: ResultPaper, readFile: ReadFile, beamerPdf?: Uint8Array): Promise<void> {
  if (deck.kind === 'beamer') {
    if (beamerPdf) download(beamerPdf, fileName(paper.title, 'pdf'), 'application/pdf');
    return;
  }
  const { PDFDocument } = await import('pdf-lib');
  await document.fonts.ready;
  const pdf = await PDFDocument.create();
  pdf.setTitle(paper.title);
  const pages = new Map<string, Awaited<ReturnType<typeof pdf.embedPdf>>[number]>();
  for (const slide of deck.slides) {
    const page = pdf.addPage([SLIDE_WIDTH * POINTS, SLIDE_HEIGHT * POINTS]);
    for (const element of slide.elements) {
      // PDF pages measure from the bottom.
      const box = (area: { x: number; y: number; w: number; h: number }) => ({ x: area.x * POINTS, y: (SLIDE_HEIGHT - area.y - area.h) * POINTS, width: area.w * POINTS, height: area.h * POINTS });
      if (element.type === 'block') {
        const output = paper.blocks.find((block) => block.id === element.blockId)?.output;
        if (!output) continue;
        let embedded = pages.get(output.pdf);
        if (!embedded) {
          [embedded] = await pdf.embedPdf(await blockBytes(output.pdf, readFile), [0]);
          pages.set(output.pdf, embedded);
        }
        page.drawPage(embedded, box(fit(embedded.width / embedded.height, element)));
      } else if (element.text.trim()) {
        const { canvas, height } = textCanvas(element, 3);
        page.drawImage(await pdf.embedPng(await pngBytes(canvas)), box({ ...element, h: height }));
      }
    }
  }
  download(await pdf.save(), fileName(paper.title, 'pdf'), 'application/pdf');
}

/** The deck as a PowerPoint file: text stays editable, blocks become 300 dpi pictures, notes go to the notes. */
export async function exportPptx(deck: SlideDeck, paper: ResultPaper, readFile: ReadFile, beamerPdf?: Uint8Array): Promise<void> {
  const { default: Pptx } = await import('pptxgenjs');
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = paper.title;
  const inches = (value: number) => Number((value * INCHES).toFixed(3));
  if (deck.kind === 'beamer') {
    // Slides as tall as PowerPoint's and as wide as the deck's pages are (16:9, or 4:3 for plain Beamer).
    const pictures = beamerPdf ? await pagePictures(beamerPdf, 2560) : [];
    const height = 7.5;
    const width = Number((height * (pictures.length > 0 ? pictures[0].aspect : 16 / 9)).toFixed(3));
    pptx.defineLayout({ name: 'BEAMER', width, height });
    pptx.layout = 'BEAMER';
    for (const picture of pictures) {
      const area = fit(picture.aspect, { x: 0, y: 0, w: width, h: height });
      pptx.addSlide().addImage({ data: picture.data, x: area.x, y: area.y, w: area.w, h: area.h });
    }
  } else {
    for (const slide of deck.slides) {
      const page = pptx.addSlide();
      for (const element of slide.elements) {
        const box = { x: inches(element.x), y: inches(element.y), w: inches(element.w), h: inches(element.h) };
        if (element.type === 'text') {
          const lines = textLines(element.text);
          page.addText(
            lines.map((line, index) => ({
              text: line.content,
              options: { ...(line.bullet ? { bullet: true, indentLevel: line.level } : {}), breakLine: index < lines.length - 1 },
            })),
            {
              ...box,
              fontSize: Math.round(element.size * POINTS * 10) / 10,
              bold: Boolean(element.bold),
              align: element.align ?? 'left',
              valign: 'top',
              fontFace: element.role === 'title' ? 'Georgia' : 'Arial',
              color: '1D1D1F',
              margin: 0,
            },
          );
        } else {
          const output = paper.blocks.find((block) => block.id === element.blockId)?.output;
          if (!output) continue;
          const canvas = await drawPdf(await blockBytes(output.pdf, readFile), Math.round(box.w * DPI));
          const area = fit(canvas.width / canvas.height, element);
          page.addImage({ data: canvas.toDataURL('image/png'), x: inches(area.x), y: inches(area.y), w: inches(area.w), h: inches(area.h) });
        }
      }
      if (slide.notes) page.addNotes(slide.notes);
    }
  }
  await pptx.writeFile({ fileName: fileName(paper.title, 'pptx') });
}
