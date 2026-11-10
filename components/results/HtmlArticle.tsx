import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { GripVertical, MessageSquare } from 'lucide-react';
import { ArticleBlock, bodyBlocks } from '../../app/writing/articleBlocks';
import { bodyOf } from '../../app/writing/document';
import { Numbering, PaperStyle, citationText, numberPaper, paperStyle, parseBibRecords } from '../../app/writing/htmlPaper';
import { Context, Element, Graphic, Inline, Look, LooseLabel, TextRun, hasUnsupported, parseBlocks, parseInline, plainText, readDefinitions } from '../../app/writing/latexHtml';
import { escapeTyped } from '../../app/writing/pageEdits';
import { replaceGraphic } from '../../app/writing/pageImages';
import { lineStarts } from '../../app/writing/pageMap';
import PicturePicker, { samePicture } from '../../app/writing/PicturePicker';
import { bibliographyStyle } from '../../editor/results/bibtex';
import { useT } from '../../lib/phrases/site';
import { ResultPaper } from '../../types';
import { EditModeContext, HiddenBadge } from '../EditMode';
import { readsPrivately, useResultsAccess } from './access';
import type { ArticleComments, ArticleViewHandle } from './ArticleView';
import { BlockMenu, BlockReaders, useBlockMenuClose } from './BlockTools';
import BlockView from './BlockView';
import { findQuote } from './comments/commentText';
import { layerText } from './comments/textLayer';
import { openPdf } from './pdfjs';
import { showMessage, useArticleText } from './useArticleText';
import './htmlArticle.css';

const REFERENCES_FILE = 'references.bib';

interface Props {
  paper: ResultPaper;
  editing: boolean;
  published: boolean;
  comments?: (blockId: string) => ArticleComments | undefined;
}

/** A block of the article read as a web page: its elements, or none when its own PDF must show instead. */
interface PageBlock extends ArticleBlock {
  elements: Element[];
  labels: LooseLabel[];
  supported: boolean;
}

/** What a theorem-like environment is called and which counter it uses. */
const THEOREMS = ['theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'example', 'claim', 'conjecture', 'assumption', 'observation', 'hypothesis', 'fact', 'note', 'problem'];

/** Reads every block of main.tex as a web page. */
function readArticle(text: string, preamble: string): { blocks: PageBlock[]; context: Context } {
  const context: Context = { definitions: readDefinitions(preamble), labels: [] };
  const starts = lineStarts(text);
  const blocks = bodyBlocks(text).map((block): PageBlock => {
    // The block's code: after its marker line, up to the end of its last line.
    const from = starts[block.from] ?? text.length;
    const to = block.to < starts.length ? starts[block.to] - 1 : text.length;
    const own: Context = { definitions: context.definitions, labels: [] };
    const elements = from < to ? parseBlocks(text, from, to, own) : [];
    return { ...block, elements, labels: own.labels, supported: !hasUnsupported(elements) };
  });
  return { blocks, context };
}

/** Where the preamble's offsets start among the page's: the title and the authors live there, apart from main.tex's. */
const PRE = 1_000_000_000;

interface TitleField {
  content: Inline[];
  /** The argument's inside, in the page's offsets (past PRE). */
  from: number;
  to: number;
}

/** Moves a stretch of inline content's offsets by `by`. */
function shifted(items: Inline[], by: number): Inline[] {
  return items.map((item) =>
    item.kind === 'text'
      ? { ...item, starts: item.starts.map((at) => at + by), ends: item.ends.map((at) => at + by) }
      : item.kind === 'footnote'
        ? { ...item, from: item.from + by, to: item.to + by, content: shifted(item.content, by) }
        : { ...item, from: item.from + by, to: item.to + by },
  );
}

const STYLE_CLASS: Record<TextRun['styles'][number], string> = { em: 'italic', bf: 'font-bold', tt: 'html-tt', sc: 'html-sc', sf: 'html-sf', ul: 'underline', sup: '', sub: '' };
const textClasses = (run: TextRun) => run.styles.map((name) => STYLE_CLASS[name]).join(' ');

/** The colour and size the source set, as CSS. */
const lookStyle = (look?: Look): React.CSSProperties | undefined =>
  look ? { ...(look.color ? { color: look.color } : {}), ...(look.size !== undefined && look.size !== 1 ? { fontSize: `${look.size}em` } : {}) } : undefined;

const ruleStyle = (rule: Extract<Inline, { kind: 'rule' }>): React.CSSProperties => ({
  width: rule.width,
  height: rule.height,
  ...(rule.raise ? { verticalAlign: rule.raise } : {}),
  ...(rule.color ? { background: rule.color } : {}),
});

/**
 * A table set in \resizebox to the line's width: scaled to the width it has here, as LaTeX scales it ('shrink':
 * only made smaller, as adjustbox's max width).
 */
const FitTable: React.FC<{ fit?: 'scale' | 'shrink'; children: React.ReactNode }> = ({ fit, children }) => {
  const box = useRef<HTMLDivElement>(null);
  const zoom = useRef(1);
  useLayoutEffect(() => {
    const element = box.current;
    const table = element?.firstElementChild as HTMLElement | null;
    if (!fit || !element || !table) return undefined;
    const measure = () => {
      // Both as drawn on screen (the sheet itself may be zoomed); the table's own zoom taken out.
      const natural = table.getBoundingClientRect().width / zoom.current;
      const room = element.getBoundingClientRect().width;
      if (natural <= 0 || room <= 0) return;
      const next = fit === 'scale' ? room / natural : Math.min(1, room / natural);
      if (Math.abs(next - zoom.current) < 0.002) return;
      zoom.current = next;
      table.style.setProperty('zoom', String(next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(table);
    return () => {
      observer.disconnect();
      table.style.removeProperty('zoom');
      zoom.current = 1;
    };
  }, [fit]);
  return (
    <div ref={box} className={fit ? 'html-table-fit' : undefined}>
      {children}
    </div>
  );
};

/** The preamble's \title and \author, read as text; `fields` are their arguments in the preamble's own offsets. */
function readTitle(preamble: string, context: Context): { title?: TitleField; author?: TitleField; fields: { from: number; to: number }[] } {
  const fields: { from: number; to: number }[] = [];
  const field = (name: 'title' | 'author'): TitleField | undefined => {
    const pattern = name === 'title' ? /(^|\n)[ \t]*\\title\s*(?:\[[^\]{}]*\]\s*)?\{/ : /(^|\n)[ \t]*\\author\s*(?:\[[^\]{}]*\]\s*)?\{/;
    const match = pattern.exec(preamble);
    if (!match) return undefined;
    const from = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let to = from;
    for (; to < preamble.length && depth > 0; to += 1) {
      if (preamble[to] === '\\') to += 1;
      else if (preamble[to] === '{') depth += 1;
      else if (preamble[to] === '}') depth -= 1;
    }
    to -= 1;
    fields.push({ from, to });
    const own: Context = { definitions: context.definitions, labels: [] };
    return { content: shifted(parseInline(preamble, from, to, own), PRE), from: from + PRE, to: to + PRE };
  };
  return { title: field('title'), author: field('author'), fields };
}

/* ------------------------------------------------------------------ pictures */

/** An attachment as a picture: a PNG or JPEG as it is, a PDF's first page drawn at the width it is shown. */
const Picture: React.FC<{ name: string; data: Uint8Array; graphic: Graphic; onClick?: (event: React.MouseEvent) => void }> = ({ name, data, graphic, onClick }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const pdf = name.toLowerCase().endsWith('.pdf');
  useEffect(() => {
    if (pdf) return undefined;
    const made = URL.createObjectURL(new Blob([data.slice()], { type: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [name, data, pdf]);
  useEffect(() => {
    const target = canvas.current;
    if (!pdf || !target) return undefined;
    let cancelled = false;
    let task: Awaited<ReturnType<typeof openPdf>> | null = null;
    void (async () => {
      task = await openPdf({ data: data.slice() });
      const page = await (await task.promise).getPage(1);
      if (cancelled) return;
      // Sharp at the width the column gives it, on any screen.
      const base = page.getViewport({ scale: 1 });
      const ratio = (window.devicePixelRatio || 1) * 2;
      const view = page.getViewport({ scale: ratio });
      target.width = Math.floor(view.width);
      target.height = Math.floor(view.height);
      target.style.aspectRatio = `${base.width} / ${base.height}`;
      await page.render({ canvas: target, viewport: view }).promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data, pdf]);
  const width = graphic.width && 'share' in graphic.width ? `${graphic.width.share * 100}%` : graphic.width ? `${graphic.width.points}pt` : '100%';
  return (
    <span className="html-picture html-atom" contentEditable={false} data-s={graphic.from} data-e={graphic.to} style={{ width }} onClick={onClick}>
      {pdf ? <canvas ref={canvas} style={{ width: '100%' }} /> : url && <img src={url} alt="" />}
    </span>
  );
};

/* ------------------------------------------------------------------ the page */

/**
 * The paper as one web page, set like its template, in place of its separate blocks: the same block tools,
 * dragging and comments as the typeset article, but typing changes the page at once, since the browser lays it out.
 * The PDF is compiled when the change is saved. A block this cannot show as a page shows its own PDF.
 */
const HtmlArticle = forwardRef<ArticleViewHandle, Props>(function HtmlArticle({ paper, editing, published, comments }, ref) {
  const t = useT();
  const access = useResultsAccess();
  const wrapper = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const isPrivate = readsPrivately(access, paper.id);
  const canSave = useEditModeSave();
  // Typing needs the private files and a way to save.
  const live = editing && canSave && access?.state === 'private';
  const article = useArticleText(paper, live, { delay: 2000 });
  const { model, preamble: preambleModel, history, files, tick, problem, attachmentNames, saveState, save, saveSoon, change, flushed, addPicture } = article;

  // Whoever only reads (a collaborator who may not edit) still needs the pictures and the bibliography.
  const [readFiles, setReadFiles] = useState<Record<string, Uint8Array> | null>(null);
  useEffect(() => {
    if (live || !isPrivate || !access) return undefined;
    let cancelled = false;
    import('./articleLive')
      .then((mod) => mod.loadAttachments(paper, access.readFile))
      .then((loaded) => !cancelled && setReadFiles(loaded))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [live, isPrivate, access, paper]);
  const attachments = live ? files.current : readFiles;

  /* ------------------------------------------------------------------ reading the text */

  const source = live && model.current ? model.current.text : bodyOf(paper.blocks.filter((block) => block.source?.trim()));
  const preamble = live && preambleModel.current ? preambleModel.current.text : paper.preamble ?? '';
  const bibStyle = bibliographyStyle(paper);
  const style = useMemo<PaperStyle>(() => paperStyle(preamble, bibStyle), [preamble, bibStyle]);
  const bibText = attachments?.[REFERENCES_FILE] ? new TextDecoder().decode(attachments[REFERENCES_FILE]) : '';
  const bib = useMemo(() => parseBibRecords(bibText), [bibText]);
  // `tick` follows the typing.
  const read = useMemo(() => readArticle(source, preamble), [source, preamble, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const theoremCounters = useMemo(() => {
    const counters: Record<string, string> = {};
    for (const name of THEOREMS) counters[name] = name;
    for (const [name, theorem] of Object.entries(read.context.definitions.theorems)) if (theorem.numbered) counters[name] = theorem.counter;
    return counters;
  }, [read]);
  const numbering = useMemo<Numbering>(() => numberPaper(read.blocks, style, bib, bibStyle, theoremCounters), [read, style, bib, bibStyle, theoremCounters]);
  // The title and the authors the preamble sets, as \maketitle prints them; their offsets are the preamble's, past PRE.
  const titlePage = useMemo(() => readTitle(preamble, read.context), [preamble, read]);
  const blockOf = useMemo(() => new Map(paper.blocks.map((block) => [block.id, block])), [paper.blocks]);
  const hidden = useMemo(() => new Set(paper.blocks.filter((block) => block.hidden).map((block) => block.id)), [paper.blocks]);
  const shownBlocks = read.blocks.filter((block) => editing || !hidden.has(block.id));

  /* ------------------------------------------------------------------ the sheet's size */

  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const element = wrapper.current;
    if (!element) return undefined;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pagePx = (style.pageWidth * 4) / 3;
  const zoom = available ? available / pagePx : 1;
  const margin = (style.pageWidth - style.textWidth) / 2;

  /* ------------------------------------------------------------------ from the page to the source and back */

  const runs = useRef(new Map<number, { element: HTMLElement; run: TextRun }>());
  const registerRun = (run: TextRun) => (element: HTMLElement | null) => {
    if (element) runs.current.set(run.starts[0], { element, run });
    else runs.current.delete(run.starts[0]);
  };

  /** The source offset of a point in the page's text. */
  const toSource = useCallback((node: Node, offset: number): number | null => {
    const holder = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement))?.closest<HTMLElement>('[data-run], [data-s]');
    if (node.nodeType === Node.TEXT_NODE && holder?.dataset.run !== undefined) {
      const found = runs.current.get(Number(holder.dataset.run));
      if (!found) return null;
      const { run } = found;
      return offset < run.text.length ? run.starts[offset] : run.ends[run.text.length - 1];
    }
    if (node.nodeType === Node.TEXT_NODE) {
      // Inside an atom: before or after it.
      return holder?.dataset.s ? Number(offset === 0 ? holder.dataset.s : holder.dataset.e) : null;
    }
    const element = node as HTMLElement;
    const startOf = (child: Node | null | undefined): number | null => {
      for (let current = child; current; current = current.nextSibling) {
        if (current instanceof HTMLElement) {
          if (current.dataset.run !== undefined) return runs.current.get(Number(current.dataset.run))?.run.starts[0] ?? null;
          if (current.dataset.s !== undefined) return Number(current.dataset.s);
          const inner = startOf(current.firstChild);
          if (inner !== null) return inner;
        }
      }
      return null;
    };
    const endOf = (child: Node | null | undefined): number | null => {
      for (let current = child; current; current = current.previousSibling) {
        if (current instanceof HTMLElement) {
          if (current.dataset.run !== undefined) {
            const run = runs.current.get(Number(current.dataset.run))?.run;
            return run ? run.ends[run.text.length - 1] : null;
          }
          if (current.dataset.e !== undefined) return Number(current.dataset.e);
          const inner = endOf(current.lastChild);
          if (inner !== null) return inner;
        }
      }
      return null;
    };
    if (offset < element.childNodes.length) return startOf(element.childNodes[offset]) ?? endOf(element.childNodes[offset - 1]);
    return endOf(element.lastChild) ?? (element.dataset.e ? Number(element.dataset.e) : null);
  }, []);

  /** A place in the page's text for a source offset: in the run that holds it, else the nearest. */
  const fromSource = useCallback((offset: number, near?: HTMLElement | null): { node: Node; offset: number } | null => {
    let best: { node: Node; offset: number; distance: number } | null = null;
    for (const { element, run } of runs.current.values()) {
      const node = element.firstChild;
      if (!node || !element.isConnected) continue;
      const bias = near && !near.contains(element) ? 0.5 : 0;
      for (let index = 0; index < run.text.length; index += 1) {
        const distance = Math.abs(run.starts[index] - offset) + bias;
        if (!best || distance < best.distance) best = { node, offset: index, distance };
      }
      const end = Math.abs(run.ends[run.text.length - 1] - offset) + bias;
      if (!best || end < best.distance) best = { node, offset: run.text.length, distance: end };
    }
    return best;
  }, []);

  /* ------------------------------------------------------------------ typing */

  const caretAfter = useRef<number | null>(null);
  // Remounts the text after an input method has written into it, so React draws it again from the source.
  const [epoch, setEpoch] = useState(0);
  const composing = useRef<{ from: number; to: number } | null>(null);

  useLayoutEffect(() => {
    const offset = caretAfter.current;
    if (offset === null || !editor.current) return;
    caretAfter.current = null;
    const place = fromSource(offset);
    if (!place) return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(place.node, place.offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  /** The character or atom just before (-1) or after (1) a point of the text, as a source range. */
  const besideCaret = (node: Node, offset: number, direction: -1 | 1): { from: number; to: number } | null => {
    const holder = node.nodeType === Node.TEXT_NODE ? node.parentElement?.closest<HTMLElement>('[data-run]') : null;
    const found = holder ? runs.current.get(Number(holder.dataset.run)) : undefined;
    if (found) {
      const index = direction < 0 ? offset - 1 : offset;
      if (index >= 0 && index < found.run.text.length) return { from: found.run.starts[index], to: found.run.ends[index] };
    }
    // At the edge of a run: the atom or run next to it.
    const sibling: Node | null | undefined = holder
      ? direction < 0
        ? holder.previousElementSibling
        : holder.nextElementSibling
      : direction < 0
        ? node.childNodes[offset - 1]
        : node.childNodes[offset];
    if (!(sibling instanceof HTMLElement)) return null;
    if (sibling.dataset.run !== undefined) {
      const run = runs.current.get(Number(sibling.dataset.run))?.run;
      if (!run) return null;
      const index = direction < 0 ? run.text.length - 1 : 0;
      return { from: run.starts[index], to: run.ends[index] };
    }
    return sibling.dataset.s !== undefined ? { from: Number(sibling.dataset.s), to: Number(sibling.dataset.e) } : null;
  };

  /** The block whose code holds an offset of the text. */
  const blockAtOffset = useCallback((offset: number) => read.blocks.find((block) => {
    const starts = lineStarts(source);
    const from = starts[block.from] ?? source.length;
    const to = block.to < starts.length ? starts[block.to] - 1 : source.length;
    return offset >= from && offset <= to;
  }), [read, source]);

  /** Whether removing source[from, to) leaves the LaTeX whole: within one block (or title line), braces and math balanced. */
  const removable = (from: number, to: number) => {
    let cut: string;
    if (from >= PRE) {
      const field = titlePage.fields.find((item) => from - PRE >= item.from && to - PRE <= item.to);
      if (!field) return false;
      cut = preamble.slice(from - PRE, to - PRE);
    } else {
      const first = blockAtOffset(from);
      if (!first || first !== blockAtOffset(to)) return false;
      cut = source.slice(from, to);
    }
    cut = cut.replace(/\\[\\{}$%&#_]/g, '');
    let depth = 0;
    for (const char of cut) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0 && (cut.match(/\$/g)?.length ?? 0) % 2 === 0 && !/\\(begin|end)\b/.test(cut);
  };

  const replace = (from: number, to: number, insertText: string, kind?: string) => {
    if (from !== to && !removable(from, to)) return;
    if (from >= PRE) {
      // The title and the authors are the preamble's.
      change(from - PRE, to - PRE, insertText, kind, 'preamble');
      caretAfter.current = from + insertText.length;
      return;
    }
    // Joining two paragraphs leaves a space between them, not nothing.
    const insert = !insertText && /^\s*\n[ \t]*\n\s*$/.test(source.slice(from, to)) ? ' ' : insertText;
    change(from, to, insert, kind);
    caretAfter.current = from + insert.length;
  };
  /** The character before an offset, of whichever text it is in. */
  const charBefore = (offset: number) => (offset >= PRE ? preamble[offset - PRE - 1] : source[offset - 1]) ?? '';
  const undo = (redo: boolean) => {
    const head = history(redo);
    if (head) caretAfter.current = head.part === 'preamble' ? head.offset + PRE : head.offset;
  };

  /** The element the selection is in: a paragraph, a caption, a table cell, a heading or a list item. */
  const placeOf = (node: Node | null) => (node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null))?.closest<HTMLElement>('[data-kind]')?.dataset.kind;

  useEffect(() => {
    const element = editor.current;
    if (!element || !live) return undefined;
    const rangeOf = (event: InputEvent): StaticRange | Range | null => event.getTargetRanges?.()[0] ?? (window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null);
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertCompositionText') return;
      event.preventDefault();
      const range = rangeOf(event);
      if (!range) return;
      const from = toSource(range.startContainer, range.startOffset);
      const to = toSource(range.endContainer, range.endOffset);
      if (from === null || to === null) return;
      const [start, end] = from <= to ? [from, to] : [to, from];
      const where = placeOf(range.startContainer);
      const type = event.inputType;
      if (type === 'historyUndo' || type === 'historyRedo') {
        undo(type === 'historyRedo');
        return;
      }
      if (type === 'insertParagraph' || type === 'insertLineBreak') {
        if (where === 'paragraph') replace(start, end, '\n\n', 'type');
        else if (where === 'item') replace(start, end, '\n\\item ', 'type');
        return;
      }
      if (type.startsWith('insert')) {
        const typed = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
        if (!typed) return;
        const flat = where === 'paragraph' || where === 'item' ? typed : typed.replace(/\s*\n\s*/g, ' ');
        replace(start, end, escapeTyped(flat, charBefore(start)), 'type');
        return;
      }
      if (type.startsWith('delete')) {
        if (start !== end) {
          replace(start, end, '', 'delete');
          return;
        }
        // No range from the browser: the character (or atom) beside the caret.
        const beside = besideCaret(range.startContainer, range.startOffset, type.includes('Backward') ? -1 : 1);
        if (beside) replace(beside.from, beside.to, '', 'delete');
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
        event.preventDefault();
        undo(key === 'y' || event.shiftKey);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === 's') {
        event.preventDefault();
        void save();
      }
      if (event.key === 'Tab') event.preventDefault();
    };
    const compositionStart = () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      const from = toSource(range.startContainer, range.startOffset);
      const to = toSource(range.endContainer, range.endOffset);
      composing.current = from !== null && to !== null ? { from: Math.min(from, to), to: Math.max(from, to) } : null;
    };
    const compositionEnd = (event: CompositionEvent) => {
      const at = composing.current;
      composing.current = null;
      setEpoch((value) => value + 1);
      if (at && event.data) replace(at.from, at.to, escapeTyped(event.data, charBefore(at.from)), 'type');
    };
    element.addEventListener('beforeinput', beforeInput);
    element.addEventListener('keydown', keyDown);
    element.addEventListener('compositionstart', compositionStart);
    element.addEventListener('compositionend', compositionEnd);
    return () => {
      element.removeEventListener('beforeinput', beforeInput);
      element.removeEventListener('keydown', keyDown);
      element.removeEventListener('compositionstart', compositionStart);
      element.removeEventListener('compositionend', compositionEnd);
    };
  });

  // Leaving the text saves soon.
  const onBlur = () => {
    if (live && model.current) saveSoon(300);
  };

  /* ------------------------------------------------------------------ pictures */

  const [picker, setPicker] = useState<{ path: string; from: number; to: number; left: number; top: number } | null>(null);
  const pickPicture = (graphic: Graphic, event: React.MouseEvent) => {
    if (!live) return;
    const open = source.lastIndexOf('{', graphic.to);
    if (open < graphic.from) return;
    setPicker({ path: graphic.path, from: open + 1, to: graphic.to - 1, left: Math.max(8, Math.min(event.clientX, window.innerWidth - 280)), top: Math.max(8, Math.min(event.clientY + 12, window.innerHeight - 360)) });
  };

  /* ------------------------------------------------------------------ drawing the text */

  const footnotes = useRef(0);
  const math = (tex: string, display: boolean) => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', macros: { ...read.context.definitions.math }, strict: 'ignore' });
    } catch {
      return tex;
    }
  };

  /** Content shown inside a command that is not edited here (a macro's text): looks only, no source places. */
  const shown = (items: Inline[]): React.ReactNode[] =>
    items.map((item, index) => {
      switch (item.kind) {
        case 'text': {
          const node = (
            <span key={index} className={textClasses(item) || undefined} style={lookStyle(item.look)}>
              {item.text}
            </span>
          );
          if (item.styles.includes('sup')) return <sup key={index}>{node}</sup>;
          if (item.styles.includes('sub')) return <sub key={index}>{node}</sub>;
          return node;
        }
        case 'math':
          return <span key={index} style={lookStyle(item.look)} dangerouslySetInnerHTML={{ __html: math(item.tex, item.display) }} />;
        case 'rule':
          return <span key={index} className="html-rule" style={ruleStyle(item)} />;
        case 'raw':
          return <span key={index}>{item.content ? shown(item.content) : item.text}</span>;
        case 'break':
          return <br key={index} />;
        case 'link':
          return <span key={index}>{item.text}</span>;
        default:
          return null;
      }
    });

  const refText = (command: string, labels: string[]) => {
    const shown = labels.map((label) => numbering.labels[label] ?? '??').join(', ');
    if (command === 'eqref') return `(${shown})`;
    if (command === 'autoref' || command === 'cref' || command === 'Cref' || command === 'Autoref') {
      const prefix = labels[0]?.split(':')[0];
      const name = { fig: 'Figure', tab: 'Table', sec: 'Section', eq: 'Equation', app: 'Appendix', thm: 'Theorem', lem: 'Lemma', alg: 'Algorithm' }[prefix ?? ''];
      return name ? `${name} ${shown}` : shown;
    }
    return shown;
  };

  const inline = (items: Inline[]): React.ReactNode[] =>
    items.map((item) => {
      switch (item.kind) {
        case 'text': {
          const classes = textClasses(item);
          const node = (
            <span key={`t${item.starts[0]}`} data-run={item.starts[0]} ref={registerRun(item)} className={classes || undefined} style={lookStyle(item.look)}>
              {item.text}
            </span>
          );
          if (item.styles.includes('sup')) return <sup key={`t${item.starts[0]}`}>{node}</sup>;
          if (item.styles.includes('sub')) return <sub key={`t${item.starts[0]}`}>{node}</sub>;
          return node;
        }
        case 'math':
          return (
            <span
              key={`m${item.from}`}
              className={`html-atom${item.display ? ' html-equation' : ''}`}
              contentEditable={false}
              data-s={item.from}
              data-e={item.to}
              title={item.tex}
              style={lookStyle(item.look)}
              dangerouslySetInnerHTML={{ __html: math(item.tex, item.display) }}
            />
          );
        case 'rule':
          return <span key={`u${item.from}`} className="html-rule" contentEditable={false} data-s={item.from} data-e={item.to} style={ruleStyle(item)} />;
        case 'cite':
          return (
            <span key={`c${item.from}`} className="html-atom" contentEditable={false} data-s={item.from} data-e={item.to} title={item.keys.join(', ')}>
              {citationText(item.command, item.keys, numbering, style, item.pre, item.post)}
            </span>
          );
        case 'ref':
          return (
            <span key={`r${item.from}`} className="html-atom" contentEditable={false} data-s={item.from} data-e={item.to} title={item.labels.join(', ')}>
              {refText(item.command, item.labels)}
            </span>
          );
        case 'link':
          return (
            <a key={`l${item.from}`} className="html-atom html-tt text-purple-800" contentEditable={false} data-s={item.from} data-e={item.to} href={item.href} target="_blank" rel="noreferrer">
              {item.text}
            </a>
          );
        case 'footnote': {
          footnotes.current += 1;
          return (
            <span key={`f${item.from}`} className="html-atom html-footnote" contentEditable={false} data-s={item.from} data-e={item.to} title={plainText(item.content.map((part) => (part.kind === 'text' ? part.text : '')).join(''))}>
              {footnotes.current}
            </span>
          );
        }
        case 'break':
          return <br key={`b${item.from}`} />;
        case 'raw':
          return (
            <span key={`x${item.from}`} className="html-atom html-raw" contentEditable={false} data-s={item.from} data-e={item.to}>
              {item.content ? shown(item.content) : item.text}
            </span>
          );
      }
    });

  const caption = (element: Extract<Element, { kind: 'figure' | 'table' }>, first: boolean) => {
    if (!element.caption) return null;
    const number = numbering.numbers.get(element);
    const ieee = style.template === 'ieee';
    const lead = element.kind === 'figure' ? (ieee ? `Fig. ${number}.` : `Figure ${number}:`) : ieee ? `Table ${number}` : `Table ${number}:`;
    const Tag = element.kind === 'figure' ? 'figcaption' : 'div';
    return (
      <Tag className={`html-caption${first ? ' html-caption-first' : ''}`} data-kind="caption" data-s={element.caption.from} data-e={element.caption.to}>
        <span contentEditable={false} className="mr-1">
          {lead}
        </span>
        {ieee && element.kind === 'table' ? <br /> : null}
        {inline(element.caption.content)}
      </Tag>
    );
  };

  const draw = (element: Element, index: number): React.ReactNode => {
    const key = `${element.kind}${element.from}-${index}`;
    switch (element.kind) {
      case 'heading': {
        const Tag = (['h2', 'h2', 'h2', 'h3', 'h4', 'h5', 'h5'] as const)[Math.max(0, Math.min(6, element.level + 1))];
        const number = numbering.numbers.get(element);
        return (
          <Tag key={key} data-kind="heading" data-s={element.from} data-e={element.to}>
            {number && (
              <span className="html-number" contentEditable={false}>
                {number}
              </span>
            )}
            {inline(element.title)}
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={key} data-kind="paragraph" data-s={element.from} data-e={element.to} className={element.noindent ? 'noindent' : undefined}>
            {inline(element.content)}
          </p>
        );
      case 'equation': {
        const number = numbering.numbers.get(element);
        return (
          <div key={key} className="html-equation html-atom" contentEditable={false} data-s={element.from} data-e={element.to} title={element.tex.trim()}>
            <span dangerouslySetInnerHTML={{ __html: math(element.tex, true) }} />
            {number && <span className="html-equation-number">({number})</span>}
          </div>
        );
      }
      case 'figure':
        return (
          <figure key={key} className={element.wide ? 'wide' : undefined}>
            {element.captionFirst && caption(element, true)}
            {element.graphics.map((graphic) => {
              const name = attachmentNamesOf(attachments).find((item) => samePicture(item, graphic.path));
              return name && attachments?.[name] ? (
                <Picture key={graphic.from} name={name} data={attachments[name]} graphic={graphic} onClick={(event) => pickPicture(graphic, event)} />
              ) : (
                <span key={graphic.from} className="html-atom inline-block border border-dashed border-gray-300 px-3 py-6 text-xs text-gray-400" contentEditable={false} data-s={graphic.from} data-e={graphic.to}>
                  {graphic.path}
                </span>
              );
            })}
            {!element.captionFirst && caption(element, false)}
          </figure>
        );
      case 'table':
        return (
          <div key={key} className={`html-table${element.wide ? ' wide' : ''}`}>
            {(element.captionFirst || style.template === 'ieee') && caption(element, true)}
            <FitTable fit={element.fit}>
              <table style={element.size !== undefined ? { fontSize: `${element.size}em` } : undefined}>
                <tbody>
                  {element.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className={[row.above && `above-${row.above}`, row.below && `below-${row.below}`].filter(Boolean).join(' ') || undefined} style={row.background ? { background: row.background } : undefined}>
                      {row.cells.map((cell) => (
                        <td key={cell.from} colSpan={cell.span > 1 ? cell.span : undefined} className={cell.wrap ? 'wrap' : undefined} style={{ textAlign: cell.align === 'c' ? 'center' : cell.align === 'r' ? 'right' : 'left', ...(cell.background ? { background: cell.background } : {}) }} data-kind="cell" data-s={cell.from} data-e={cell.to}>
                          {inline(cell.content)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </FitTable>
            {!element.captionFirst && style.template !== 'ieee' && caption(element, false)}
          </div>
        );
      case 'list': {
        const Tag = element.ordered ? 'ol' : 'ul';
        return (
          <Tag key={key}>
            {element.items.map((item) => (
              <li key={item.from} data-kind="item" data-s={item.from} data-e={item.to}>
                {item.children.map(draw)}
              </li>
            ))}
          </Tag>
        );
      }
      case 'environment': {
        const theorem = theoremCounters[element.name] !== undefined || read.context.definitions.theorems[element.name];
        const title = read.context.definitions.theorems[element.name]?.title ?? (element.name === 'abstract' ? 'Abstract' : element.name === 'proof' ? 'Proof' : element.name[0].toUpperCase() + element.name.slice(1));
        const number = numbering.numbers.get(element);
        const head = theorem || element.name === 'proof' || element.name === 'abstract';
        return (
          <div key={key} className={`html-env ${theorem ? 'theorem' : element.name}`}>
            {head && (
              <span className="html-env-head" contentEditable={false}>
                {title}
                {number ? ` ${number}` : ''}
                {element.title ? <> ({inline(element.title)})</> : null}
                {element.name === 'abstract' ? '' : '.'}
              </span>
            )}
            <div className="html-env-body">{element.children.map(draw)}</div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  /* ------------------------------------------------------------------ hovering, dragging, comments */

  const [hovered, setHovered] = useState<string | null>(null);
  // The block whose menu is open, from the handle beside it.
  const [menu, setMenu] = useState<string | null>(null);
  useBlockMenuClose(menu, setMenu);
  const [drag, setDrag] = useState<{ id: string; target?: { id: string; after: boolean } } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [frame, setFrame] = useState(0);
  // The overlay follows the text as it reflows.
  useEffect(() => {
    const element = sheet.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setFrame((value) => value + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sectionOf = (id: string) => sheet.current?.querySelector<HTMLElement>(`section[data-result-block-id="${CSS.escape(id)}"]`) ?? null;
  const blockAtPoint = useCallback((clientX: number, clientY: number): string | null => {
    const element = document.elementFromPoint(clientX, clientY);
    return element?.closest<HTMLElement>('section[data-result-block-id]')?.dataset.resultBlockId ?? null;
  }, []);

  /** A block's boxes relative to the wrapper: one for each column it runs through. */
  const boxesOf = (id: string): DOMRect[] => {
    const element = sectionOf(id);
    const origin = wrapper.current?.getBoundingClientRect();
    if (!element || !origin) return [];
    return Array.from(element.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height));
  };

  const onMouseMove = (event: React.MouseEvent) => {
    if (!editing || dragRef.current) return;
    if ((event.target as HTMLElement).closest?.('[data-page-control]')) return;
    const id = blockAtPoint(event.clientX, event.clientY);
    setHovered(id === 'references' ? null : id);
  };

  /** The handle: a click opens the block's menu, a drag moves the block. */
  const startDrag = (event: React.PointerEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY };
    let moving = false;
    const move = (moved: PointerEvent) => {
      if (!moving && Math.hypot(moved.clientX - origin.x, moved.clientY - origin.y) < 4) return;
      if (!moving) {
        moving = true;
        setMenu(null);
      }
      const target = blockAtPoint(moved.clientX, moved.clientY);
      if (!target || target === id || target === 'references') return setDrag({ id });
      const rect = Array.from(sectionOf(target)?.getClientRects() ?? []).find((box) => moved.clientX >= box.left && moved.clientX <= box.right && moved.clientY >= box.top && moved.clientY <= box.bottom);
      setDrag({ id, target: { id: target, after: rect ? moved.clientY > rect.top + rect.height / 2 : false } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const done = dragRef.current;
      setDrag(null);
      if (!moving) {
        setMenu((open) => (open === id ? null : id));
        return;
      }
      if (!done?.target) return;
      const ids = paperRef.current.blocks.map((block) => block.id).filter((item) => item !== done.id);
      const at = ids.indexOf(done.target.id);
      if (at < 0) return;
      ids.splice(done.target.after ? at + 1 : at, 0, done.id);
      if (ids.join() !== paperRef.current.blocks.map((block) => block.id).join()) flushed.reorderBlocks(paper.id, ids);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Comments on text: highlighted where their quote is found in the block's text.
  const ids = shownBlocks.map((block) => block.id);
  const wanted = [...ids, 'references'].flatMap((id) => (comments?.(id)?.quotes ?? []).map((quote) => ({ ...quote, block: id })));
  const wantedKey = JSON.stringify(wanted);
  const [highlights, setHighlights] = useState<{ id: string; block: string; boxes: DOMRect[] }[]>([]);
  useLayoutEffect(() => {
    const origin = wrapper.current?.getBoundingClientRect();
    if (!origin) return;
    const list = JSON.parse(wantedKey) as { id: string; quote: string; prefix?: string; suffix?: string; block: string }[];
    const next: { id: string; block: string; boxes: DOMRect[] }[] = [];
    for (const mark of list) {
      const element = sheet.current?.querySelector<HTMLElement>(`[data-result-block-id="${CSS.escape(mark.block)}"]`);
      if (!element) continue;
      const layer = layerText(element);
      const found = findQuote(layer.text, mark.quote, mark.prefix, mark.suffix);
      const first = found ? layer.at[found.start] : undefined;
      const last = found ? layer.at[found.end - 1] : undefined;
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      next.push({ id: mark.id, block: mark.block, boxes: Array.from(range.getClientRects()).map((rect) => new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height)) });
    }
    setHighlights(next);
  }, [wantedKey, read, frame, zoom]);

  const onClickCapture = (event: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed && !live) return;
    const origin = wrapper.current?.getBoundingClientRect();
    if (!origin) return;
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    const hit = highlights.find((mark) => mark.boxes.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom));
    if (hit && window.getSelection()?.isCollapsed) comments?.(hit.block)?.onOpen(hit.id);
  };

  useImperativeHandle(
    ref,
    () => ({
      blockAt: blockAtPoint,
      showHeading: (blockId, index) => {
        const heading = sectionOf(blockId)?.querySelectorAll<HTMLElement>('h2, h3, h4, h5')[index];
        if (!heading) return false;
        window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - 140, behavior: 'smooth' });
        return true;
      },
    }),
    [blockAtPoint],
  );

  /* ------------------------------------------------------------------ the overlay */

  const overlay = () => {
    const origin = wrapper.current?.getBoundingClientRect();
    const sheetBox = sheet.current?.getBoundingClientRect();
    if (!origin || !sheetBox) return null;
    const textRight = sheetBox.right - origin.left - margin * (4 / 3) * zoom;
    const textLeft = sheetBox.left - origin.left + margin * (4 / 3) * zoom;
    const elements: React.ReactNode[] = [];
    for (const block of shownBlocks) {
      const id = block.id;
      // Hovering shows the handle only; its menu, or a drag, outlines the block.
      const grip = editing && (hovered === id || menu === id || drag?.id === id);
      const lit = editing && (menu === id || drag?.id === id);
      const own = comments?.(id);
      const isHidden = hidden.has(id);
      const showBadge = own && own.count > 0 && own.first;
      if (!grip && !showBadge && !(editing && isHidden) && drag?.target?.id !== id) continue;
      const boxes = boxesOf(id);
      if (boxes.length === 0) continue;
      const first = boxes[0];
      const last = boxes[boxes.length - 1];
      const stored = blockOf.get(id);
      if (lit)
        boxes.forEach((box, index) =>
          elements.push(
            <div key={`o${id}${index}`} className="pointer-events-none absolute z-[2] rounded-lg border border-purple-400 shadow-[0_0_0_2px_rgb(192_132_252/12%)]" style={{ left: box.left - 8, top: box.top - 6, width: box.width + 16, height: box.height + 12 }} />,
          ),
        );
      if (showBadge)
        elements.push(
          <button key={`c${id}`} type="button" data-page-control onClick={() => own.onOpen(own.first!)} className="absolute z-[3] inline-flex -translate-y-full items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 xl:hidden" style={{ left: first.left, top: first.top - 8 }}>
            <MessageSquare size={12} />
            {own.count}
          </button>,
        );
      if (editing && isHidden && !lit)
        elements.push(
          <span key={`h${id}`} className="absolute z-[3]" style={{ left: textRight + 16, top: first.top }}>
            <HiddenBadge />
          </span>,
        );
      if (grip && stored)
        elements.push(
          <button
            key={`d${id}`}
            type="button"
            data-page-control
            data-block-grip
            aria-label={t('这一块的操作')}
            aria-expanded={menu === id}
            title={t('点击打开菜单，拖动来移动这一块')}
            onPointerDown={(event) => startDrag(event, id)}
            className={`absolute z-[4] flex h-6 w-5 cursor-grab items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-black/[0.06] hover:text-gray-700 active:cursor-grabbing ${menu === id ? 'bg-black/[0.06] text-gray-700' : ''}`}
            style={{ left: first.left - 26, top: first.top + 1 }}
          >
            <GripVertical size={14} />
          </button>,
        );
      if (menu === id && stored && !drag)
        elements.push(<BlockMenu key={`m${id}`} paperId={paper.id} block={stored} published={published} onComment={own?.onAdd} style={{ left: first.left - 30, top: first.top + 28 }} />);
      if (drag?.target?.id === id) {
        const at = drag.target.after ? last : first;
        elements.push(<div key={`l${id}`} className="pointer-events-none absolute z-[5] h-0.5 rounded bg-purple-600" style={{ left: at.left - 8, width: at.width + 16, top: drag.target.after ? at.bottom + 4 : at.top - 6 }} />);
      }
    }
    for (const mark of highlights)
      mark.boxes.forEach((box, index) =>
        elements.push(
          <span
            key={`q${mark.id}${index}`}
            data-comment-highlight={mark.id}
            className={`pointer-events-none absolute z-[1] rounded-sm mix-blend-multiply ${comments?.(mark.block)?.active === mark.id ? 'bg-amber-300/80' : 'bg-yellow-200/70'}`}
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          />,
        ),
      );
    for (const block of shownBlocks) {
      const boxes = boxesOf(block.id);
      if (boxes.length > 0)
        elements.push(
          // In the margin on the block's side: the left one for the left column, the right one for the right.
          <div key={`r${block.id}`} className="absolute w-0" style={{ left: boxes[0].left > (textLeft + textRight) / 2 ? textRight - 4 : textLeft - 52, top: boxes[0].top + 28 }}>
            <BlockReaders blockId={block.id} />
          </div>,
        );
    }
    return elements;
  };
  void frame;

  footnotes.current = 0;
  const editable = live;

  return (
    <EditModeContext.Provider value={flushed}>
      {live && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/90 px-3 py-1.5 text-xs text-gray-500 shadow-[0_1px_2px_rgba(0,0,0,0.06)] backdrop-blur">
          <span>{saveState === 'saving' ? t('保存中…') : saveState === 'dirty' ? t('有未保存的修改') : t('已保存')}</span>
          <span className="ml-auto hidden text-gray-400 md:inline">{t('直接在文字上修改；保存时会重新编译 PDF')}</span>
          {problem && (
            <span role="alert" className="basis-full text-red-700">
              {showMessage(problem)}
            </span>
          )}
        </div>
      )}
      <div ref={wrapper} className={`relative${drag ? ' select-none' : ''}`} onMouseMove={onMouseMove} onMouseLeave={() => !drag && setHovered(null)} onClickCapture={onClickCapture}>
        <div
          ref={sheet}
          className={`html-sheet${editable ? ' html-editing' : ''}`}
          data-template={style.template}
          data-font={style.font}
          lang="en"
          style={{ width: `${style.pageWidth}pt`, padding: `${Math.min(72, margin)}pt ${margin}pt`, fontSize: `${style.size}pt`, zoom }}
        >
          <div
            key={epoch}
            ref={editor}
            className="html-text"
            contentEditable={editable}
            suppressContentEditableWarning
            spellCheck={false}
            onBlur={onBlur}
            style={{ columnCount: style.columns, columnGap: `${style.columnGap}pt` }}
          >
            {titlePage.title && (
              <header className="html-title">
                <h1 data-kind="title" data-s={titlePage.title.from} data-e={titlePage.title.to}>
                  {inline(titlePage.title.content)}
                </h1>
                {titlePage.author && (
                  <div className="html-authors" data-kind="title" data-s={titlePage.author.from} data-e={titlePage.author.to}>
                    {inline(titlePage.author.content)}
                  </div>
                )}
              </header>
            )}
            {shownBlocks.map((block) => {
              const stored = blockOf.get(block.id);
              return (
                <section key={block.id} data-result-block-id={block.id} data-quote-layer className={`html-block scroll-mt-24${hidden.has(block.id) ? ' html-hidden' : ''}`}>
                  {block.supported || !stored ? (
                    block.elements.map(draw)
                  ) : (
                    <div className="html-fallback" contentEditable={false}>
                      <BlockView paperId={paper.id} block={stored} />
                    </div>
                  )}
                </section>
              );
            })}
            {numbering.references.length > 0 && (
              <section data-result-block-id="references" data-quote-layer className="html-block html-references" contentEditable={false}>
                <h2>References</h2>
                <ol className={style.citations === 'author-year' ? 'author-year' : undefined}>
                  {numbering.references.map((entry) => (
                    <li key={entry.key}>{entry.text}</li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        </div>
        {overlay()}
      </div>
      {picker && attachments && (
        <PicturePicker
          path={picker.path}
          left={picker.left}
          top={picker.top}
          names={attachmentNames}
          attachments={attachments}
          onChoose={(name) => {
            setPicker(null);
            replace(picker.from, picker.to, replaceGraphic(picker.path, name));
          }}
          onUpload={(chosen) =>
            void addPicture(chosen, attachmentNames.find((item) => samePicture(item, picker.path))).then((name) => {
              setPicker(null);
              replace(picker.from, picker.to, replaceGraphic(picker.path, name));
            })
          }
          onClose={() => setPicker(null)}
        />
      )}
    </EditModeContext.Provider>
  );
});

const attachmentNamesOf = (files: Record<string, Uint8Array> | null | undefined) => Object.keys(files ?? {});

/** Whether the page can save what is typed on it. */
function useEditModeSave(): boolean {
  return Boolean(React.useContext(EditModeContext).saveResults);
}

export default HtmlArticle;
