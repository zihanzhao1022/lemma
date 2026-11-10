import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GripVertical, MessageSquare } from 'lucide-react';
import { ArticleBlock, blockHeadingLines, bodyBlocks, unpackMarks } from '../../app/writing/articleBlocks';
import { BlockBox, REFERENCES, blockBoxes } from '../../app/writing/blockBoxes';
import { Mark, locate } from '../../app/writing/document';
import type { Spot } from '../../app/writing/pageAlign';
import { deleteAfter, deleteBefore, escapeTyped, moveCaret, typedSince } from '../../app/writing/pageEdits';
import { graphicsOf, replaceGraphic } from '../../app/writing/pageImages';
import { RegionMap, atomRange, caretToSpot, clickToCaret, lineAt, lineStarts, mapRegion } from '../../app/writing/pageMap';
import type { PageText } from '../../app/writing/pageRegions';
import PdfPages, { CaretSpot, PageClick, PdfClick, PdfPagesHandle, Size } from '../../app/writing/PdfPages';
import PicturePicker, { samePicture } from '../../app/writing/PicturePicker';
import { printedUnits } from '../../app/writing/printed';
import { inverseSearch } from '../../app/writing/sourceSearch';
import { useT } from '../../lib/phrases/site';
import { publicFilePath } from '../../lib/results';
import { ResultPaper } from '../../types';
import { EditModeContext, HiddenBadge, useEditMode } from '../EditMode';
import { readsPrivately, useResultsAccess } from './access';
import type { ArticleCarry } from './articleLive';
import { BlockMenu, BlockReaders, useBlockMenuClose } from './BlockTools';
import { QuoteMark } from './BlockView';
import { findQuote } from './comments/commentText';
import { Box, LayerText, layerText, quoteBoxes } from './comments/textLayer';
import { Part, showMessage, useArticleText } from './useArticleText';

/** Marks name main.tex as file 0 and the preamble, whose title and authors are marked, as file 1. */
const fileOf = (part: Part) => (part === 'preamble' ? 1 : 0);
const partOf = (file: number | undefined): Part | null => (file === 1 ? 'preamble' : file ? null : 'main');
const sourceOf = (from: Shown, part: Part) => (part === 'preamble' ? from.preamble : from.source);
const versionOf = (from: Shown, part: Part) => (part === 'preamble' ? from.preambleVersion : from.version);


const MAIN = 'main.tex';

/** A block's comments, for its tools, its badge and the highlights on its text. */
export interface ArticleComments {
  count: number;
  first?: string;
  quotes: QuoteMark[];
  active: string | null;
  onAdd: () => void;
  onOpen: (id: string) => void;
}

export interface ArticleViewHandle {
  /** The block at a point of the window. */
  blockAt: (clientX: number, clientY: number) => string | null;
  /** Scrolls to a block's n-th heading; false when that cannot be found. */
  showHeading: (blockId: string, index: number) => boolean;
}

interface Props {
  paper: ResultPaper;
  /** Whoever may edit the paper, with editing on: block tools, and typing where the page can save. */
  editing: boolean;
  /** The paper is public, so showing a hidden block publishes it. */
  published: boolean;
  comments?: (blockId: string) => ArticleComments | undefined;
}

/** A PDF of the article and what says where its blocks landed: compiled here (with its source) or stored. */
interface Shown {
  pdf?: Uint8Array;
  marks: Mark[];
  blocks: ArticleBlock[];
  /** The main.tex it was compiled from, and the text's version then, when compiled while typing. */
  source?: string;
  version?: number;
  /** The preamble it was compiled from (its title and authors are typed on too), and its version then. */
  preamble?: string;
  preambleVersion?: number;
  /** The caret when the compile started, in that text. */
  caret?: { part: Part; offset: number; atom?: { from: number; to: number } };
}

/** Where typing on the article goes: an offset in the text now, and the lines of the region it is in. */
interface PageEdit {
  /** The text typed into: main.tex, or the preamble (the title and the authors). */
  part: Part;
  offset: number;
  from: number;
  until: number;
  float?: boolean;
  atom?: { from: number; to: number };
}


/** Where a box comes in reading order: page, then column, then down the page. */
const readingOrder = (box: BlockBox, size?: Size) => box.page * 1e7 + (size && box.left > size.width / 2 ? 1e6 : 0) + (1e5 - box.top);

/**
 * The paper as one typeset article, as LaTeX lays it out, in place of its separate blocks. Whoever edits it sees
 * each block's outline and tools when the pointer is on it, can drag blocks to move them, and types on the page:
 * the text goes into the block's code, the article is compiled again at once and the change saved a moment later.
 * Readers see the article stored with the paper's last save.
 */
const ArticleView = forwardRef<ArticleViewHandle, Props>(function ArticleView({ paper, editing, published, comments }, ref) {
  const t = useT();
  const editMode = useEditMode();
  const access = useResultsAccess();
  const pdf = useRef<PdfPagesHandle>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const stored = paper.article;
  const isPrivate = readsPrivately(access, paper.id);
  const saveResults = editMode.saveResults;
  // Typing needs the private files and a way to save; otherwise the page shows the stored article.
  const live = editing && Boolean(saveResults) && access?.state === 'private';

  /* ------------------------------------------------------------------ the stored article */

  const [storedData, setStoredData] = useState<Uint8Array | undefined>(undefined);
  const [readFailed, setReadFailed] = useState(false);
  useEffect(() => {
    if (!stored || !isPrivate || !access) return undefined;
    let cancelled = false;
    setReadFailed(false);
    access.readFile(stored.pdf).then(
      (bytes) => !cancelled && setStoredData(bytes),
      () => !cancelled && setReadFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [stored?.pdf, isPrivate, access]);
  const storedShown = useMemo<Shown | null>(
    () => (stored ? { pdf: isPrivate ? storedData : undefined, marks: unpackMarks(stored.marks), blocks: stored.blocks } : null),
    [stored, isPrivate, storedData],
  );

  /* ------------------------------------------------------------------ the text typed on, and its compiles */

  const text = useArticleText(paper, live, { onReset: () => setPageEdit(null) });
  const { live$, model, preamble, modelOf, history, files, tick, ready, problem, setProblem, attachmentNames, saveState, save, saveSoon, holdSave, change, flushed, addPicture } = text;
  // Why the text as typed does not compile; the last PDF stays on screen meanwhile.
  const [compileProblem, setCompileProblem] = useState<string | null>(null);

  const compiledByPdf = useRef(new Map<Uint8Array, Shown>());
  const [compiled, setCompiled] = useState<Shown | null>(null);
  const [compiling, setCompiling] = useState(false);
  const carry = useRef<ArticleCarry>({ bibKey: '' });
  const running = useRef(false);
  const again = useRef(false);
  const [pageEdit, setPageEdit] = useState<PageEdit | null>(null);
  const editRef = useRef(pageEdit);
  editRef.current = pageEdit;

  const compile = useCallback(async () => {
    const lib = live$.current;
    if (!lib || !model.current || !files.current) return;
    // One run at a time; typing during a run asks for another when it ends.
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setCompiling(true);
    let settling = 0;
    try {
      do {
        again.current = false;
        const text = model.current.text;
        const version = model.current.version;
        const head = preamble.current;
        const edit = editRef.current;
        const out = await lib.compileArticleText(paperRef.current, text, files.current, carry.current, head?.text);
        carry.current = out.carry;
        if (!out.ok) {
          setCompileProblem(out.message);
          continue;
        }
        setCompileProblem(null);
        const next: Shown = {
          pdf: out.pdf,
          marks: out.marks,
          blocks: bodyBlocks(text),
          source: text,
          version,
          ...(head ? { preamble: head.text, preambleVersion: head.version } : {}),
          ...(edit ? { caret: { part: edit.part, offset: edit.offset, ...(edit.atom ? { atom: edit.atom } : {}) } } : {}),
        };
        compiledByPdf.current.set(out.pdf, next);
        // Only the last few are kept: those on their way to the screen.
        for (const key of [...compiledByPdf.current.keys()].slice(0, -4)) compiledByPdf.current.delete(key);
        setCompiled(next);
        // The numbers \ref and \cite print settle in one more run, after what was typed is on screen (twice at most,
        // should they keep moving a line across a page).
        if (out.unsettled && settling < 2) {
          settling += 1;
          again.current = true;
        }
      } while (again.current);
    } catch (error) {
      setProblem(() => live$.current?.describeSaveError(error) ?? String(error));
    } finally {
      running.current = false;
      setCompiling(false);
    }
  }, []);

  // At once after every change: typing on the page waits for nothing.
  useEffect(() => {
    if (live && ready) void compile();
  }, [live, ready, tick, compile]);

  /* ------------------------------------------------------------------ what is on screen */

  const [shown, setShown] = useState<Shown | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const data = live && compiled ? compiled.pdf : storedShown?.pdf;
  const url = !live && stored && !isPrivate ? publicFilePath(stored.pdf) : undefined;
  const documentReady = useCallback((bytes: Uint8Array) => {
    const found = compiledByPdf.current.get(bytes);
    if (found) setShown(found);
  }, []);
  const [layout, setLayout] = useState<{ boxes: Record<string, BlockBox[]>; sizes: Size[] } | null>(null);
  const loaded = useCallback(() => {
    // A stored article is on screen when it is not one compiled here.
    if (!live || !compiled) setShown(storedShown);
  }, [live, compiled, storedShown]);
  useEffect(() => {
    if (!shown || !pdf.current) return undefined;
    let cancelled = false;
    void (async () => {
      const handle = pdf.current;
      if (!handle) return;
      const count = handle.pageCount();
      const pages: (PageText | undefined)[] = await Promise.all(Array.from({ length: count }, (_, index) => handle.pageText(index + 1)));
      if (cancelled) return;
      setLayout({ boxes: blockBoxes(shown.marks, shown.blocks, pages), sizes: pages.map((page) => ({ width: page?.width ?? 612, height: page?.height ?? 792 })) });
    })();
    return () => {
      cancelled = true;
    };
  }, [shown]);

  // Each block's boxes in reading order, its first where its tools go.
  const ordered = useMemo(() => {
    const result: Record<string, BlockBox[]> = {};
    for (const [id, list] of Object.entries(layout?.boxes ?? {})) result[id] = [...list].sort((a, b) => readingOrder(a, layout?.sizes[a.page - 1]) - readingOrder(b, layout?.sizes[b.page - 1]));
    return result;
  }, [layout]);

  /** The block whose box holds a point of a page (PDF points), the innermost when boxes overlap. */
  const boxAt = useCallback(
    (point: { page: number; x: number; y: number } | null, margin = 8, skip?: string): string | null => {
      if (!point) return null;
      let best: { id: string; area: number } | null = null;
      for (const [id, list] of Object.entries(ordered)) {
        if (id === skip) continue;
        for (const box of list) {
          if (box.page !== point.page) continue;
          if (point.x < box.left - margin || point.x > box.right + margin || point.y > box.top + margin || point.y < box.bottom - margin) continue;
          const area = (box.right - box.left) * (box.top - box.bottom);
          if (!best || area < best.area) best = { id, area };
        }
      }
      return best?.id ?? null;
    },
    [ordered],
  );

  /* ------------------------------------------------------------------ typing on the article */

  /** An offset of a text as compiled, in that text now. */
  const offsetNow = (from: Shown, offset: number, part: Part = 'main'): number | null => {
    const text = modelOf(part);
    const then = sourceOf(from, part);
    const version = versionOf(from, part);
    if (!text || then === undefined || version === undefined) return null;
    return then === text.text ? offset : text.map(offset, version);
  };
  const lineNow = (from: Shown, line: number, part: Part = 'main'): number | null => {
    const then = sourceOf(from, part);
    if (then === undefined) return null;
    const offset = offsetNow(from, lineStarts(then)[line - 1] ?? 0, part);
    const text = modelOf(part);
    return offset === null || !text ? null : lineAt(text.text, offset);
  };

  /** The text of the pages a region at `line` of a file reads: its mark's page and the one after. */
  const regionPages = useCallback(async (marks: Mark[], line: number, file = 0): Promise<(PageText | undefined)[]> => {
    const start = marks.filter((mark) => (mark.file ?? 0) === file && (mark.kind === 'L' || mark.kind === 'B') && mark.line <= line).sort((a, b) => b.line - a.line)[0];
    const pages: (PageText | undefined)[] = [];
    if (!start || !pdf.current) return pages;
    for (const page of [start.page, start.page + 1]) pages[page - 1] = await pdf.current.pageText(page);
    return pages;
  }, []);

  const leavePage = useCallback(() => {
    if (editRef.current) saveSoon(300);
    setPageEdit(null);
  }, [saveSoon]);

  const [picker, setPicker] = useState<{ path: string; from: number; to: number; left: number; top: number } | null>(null);

  const pickPicture = async (from: Shown, map: RegionMap, click: PageClick) => {
    const source = from.source ?? '';
    const graphics = graphicsOf(source, map.from, map.to);
    if (graphics.length === 0) return;
    let chosen = graphics[0];
    if (graphics.length > 1) {
      const begin = from.marks.find((mark) => mark.kind === 'B' && mark.line === map.region.from && !mark.file);
      const end = from.marks.find((mark) => mark.kind === 'E' && mark.line === map.region.until && !mark.file);
      const pictures = ((await pdf.current?.pictures(click.page)) ?? []).filter(
        (box) => !begin || !end || (box.left >= begin.x - 4 && box.right <= begin.x + begin.width + 4 && box.top <= begin.y + 4 && box.bottom >= end.y - 4),
      );
      const under = pictures.findIndex((box) => click.x >= box.left - 2 && click.x <= box.right + 2 && click.y >= box.bottom - 2 && click.y <= box.top + 2);
      if (under < 0) return;
      if (pictures.length === graphics.length) chosen = graphics[under];
    }
    const start = offsetNow(from, chosen.from);
    const end = offsetNow(from, chosen.to);
    if (start === null || end === null) return;
    setPicker({ path: chosen.path, from: start, to: end, left: Math.max(8, Math.min(click.clientX, window.innerWidth - 280)), top: Math.max(8, Math.min(click.clientY + 12, window.innerHeight - 360)) });
  };


  const choosePicture = (choice: NonNullable<typeof picker>, name: string) => {
    setPicker(null);
    change(choice.from, choice.to, replaceGraphic(choice.path, name));
  };


  const uploadPicture = async (choice: NonNullable<typeof picker>, chosen: File) => {
    const name = await addPicture(chosen, attachmentNames.find((item) => samePicture(item, choice.path)));
    choosePicture(choice, name);
  };

  const onPageClick = async (click: PageClick) => {
    const from = shownRef.current;
    if (!live || !from?.source) return leavePage();
    const located = locate(from.marks, click);
    const part = located ? partOf(located.file) : null;
    const source = part ? sourceOf(from, part) : undefined;
    if (!located || !part || source === undefined) return leavePage();
    const file = fileOf(part);
    const map = mapRegion(source, from.marks, await regionPages(from.marks, located.line, file), file, located.line);
    const caret = map && click.item >= 0 ? clickToCaret(map, click.item, click.offset, click.side) : null;
    if (!map || !caret) {
      leavePage();
      if (map?.region.float && part === 'main') await pickPicture(from, map, click);
      return;
    }
    const atom = 'atom' in caret ? caret.atom : undefined;
    const offset = offsetNow(from, atom ? atom.to : 'offset' in caret ? caret.offset : 0, part);
    const atomFrom = atom ? offsetNow(from, atom.from, part) : null;
    const start = lineNow(from, map.region.from, part);
    const until = map.region.until === Number.MAX_SAFE_INTEGER ? map.region.until : lineNow(from, map.region.until, part);
    if (offset === null || start === null || until === null || (atom && atomFrom === null)) return leavePage();
    const edit: PageEdit = { part, offset, from: start, until, float: map.region.float, ...(atom ? { atom: { from: atomFrom!, to: offset } } : {}) };
    holdSave();
    setPageEdit(edit);
    editRef.current = edit;
  };

  // Where to draw the caret, and the text typed since the PDF on screen.
  const [caretSpot, setCaretSpot] = useState<CaretSpot | null>(null);
  const [atomSpots, setAtomSpots] = useState<[Spot, Spot] | null>(null);
  const [pending, setPending] = useState('');
  useEffect(() => {
    const edit = pageEdit;
    const from = shown;
    const text = edit ? modelOf(edit.part) : null;
    const source = edit && from ? sourceOf(from, edit.part) : undefined;
    if (!edit || !from || source === undefined || !text) {
      setCaretSpot(null);
      setAtomSpots(null);
      setPending('');
      return undefined;
    }
    const fresh = source === text.text;
    const caret = fresh ? edit : from.caret?.part === edit.part ? from.caret : null;
    setPending(!fresh && caret && !caret.atom && !edit.atom ? typedSince(text.text, offsetNow(from, caret.offset, edit.part), edit.offset) : '');
    if (!caret) return undefined;
    let cancelled = false;
    const file = fileOf(edit.part);
    void (async () => {
      const line = lineAt(source, caret.offset);
      const map = mapRegion(source, from.marks, await regionPages(from.marks, line, file), file, line);
      if (cancelled) return;
      setCaretSpot(map ? caretToSpot(map, caret.offset) : null);
      setAtomSpots(map && caret.atom ? atomRange(map, caret.atom.from) : null);
    })();
    return () => {
      cancelled = true;
    };
    // `tick` follows the text.
  }, [pageEdit, shown, tick, regionPages]);

  const regionNow = (edit: PageEdit) => {
    const text = modelOf(edit.part)?.text ?? '';
    const starts = lineStarts(text);
    const from = starts[Math.min(edit.from, starts.length) - 1] ?? 0;
    const to = edit.until < starts.length ? starts[edit.until] - 1 : text.length;
    return { text, units: printedUnits(text, from, to) };
  };

  const caretTo = (edit: PageEdit, offset: number, lines = 0) => {
    const next: PageEdit = { part: edit.part, offset, from: edit.from, until: edit.until === Number.MAX_SAFE_INTEGER ? edit.until : Math.max(edit.from, edit.until + lines), float: edit.float };
    setPageEdit(next);
    editRef.current = next;
  };

  const onPageText = (typed: string) => {
    const edit = editRef.current;
    const text = edit ? modelOf(edit.part) : null;
    if (!edit || !text) return;
    const paragraph = typed === '\n';
    // A float (a table, a caption) and the title have no paragraphs.
    if (paragraph && (edit.float || edit.part === 'preamble')) return;
    const insert = paragraph ? '\n\n' : escapeTyped(edit.float || edit.part === 'preamble' ? typed.replace(/\s*\n\s*/g, ' ') : typed, text.text[edit.offset - 1] ?? '');
    change(edit.offset, edit.offset, insert, 'type', edit.part);
    caretTo(edit, edit.offset + insert.length, insert.split('\n').length - 1);
  };

  const onPageKey = (event: KeyboardEvent) => {
    const edit = editRef.current;
    if (!edit) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
      event.preventDefault();
      const head = history(key === 'y' || event.shiftKey);
      if (!head) return;
      if (head.part === edit.part) caretTo(edit, head.offset);
      else leavePage();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        leavePage();
        return;
      case 'Backspace':
      case 'Delete': {
        event.preventDefault();
        const { text: now, units } = regionNow(edit);
        const removal = event.key === 'Backspace' ? deleteBefore(units, edit.offset) : deleteAfter(units, edit.offset);
        if (!removal) return;
        const lines = now.slice(removal.from, removal.to).split('\n').length - 1;
        change(removal.from, removal.to, '', 'delete', edit.part);
        caretTo(edit, removal.from, -lines);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        caretTo(edit, moveCaret(regionNow(edit).units, edit.offset, event.key === 'ArrowLeft' ? -1 : 1));
        return;
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const box = pdf.current?.caretBox();
        const middle = box ? box.top + box.height / 2 : 0;
        const hit = box ? pdf.current?.hitAt(box.left + 1, event.key === 'ArrowUp' ? middle - box.height * 1.2 : middle + box.height * 1.2) : null;
        if (hit && hit.item >= 0) void onPageClick(hit);
        return;
      }
      case 'Tab':
        event.preventDefault();
        return;
      default:
    }
  };

  /** A double click opens the block's editor at the code clicked. */
  const onDoubleClick = (click: PdfClick) => {
    leavePage();
    const from = shownRef.current;
    if (!editing || !from?.source) return;
    const found = inverseSearch({ [MAIN]: from.source }, from.marks, click, [MAIN]);
    const line = found?.line ?? locate(from.marks, click)?.line;
    const block = line === undefined ? undefined : from.blocks.find((item) => line >= item.from && line <= item.to);
    if (!block || line === undefined) return;
    flushed.open({ kind: 'block', paperId: paper.id, blockId: block.id, sourceLocation: { line: Math.max(1, line - block.from), start: found?.start, end: found?.end } });
  };

  /* ------------------------------------------------------------------ hovering, and dragging blocks */

  const [hovered, setHovered] = useState<string | null>(null);
  // The block whose menu is open, from the handle beside it.
  const [menu, setMenu] = useState<string | null>(null);
  useBlockMenuClose(menu, setMenu);
  const [drag, setDrag] = useState<{ id: string; target?: { id: string; after: boolean } } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const onMouseMove = (event: React.MouseEvent) => {
    if (!editing || dragRef.current) return;
    if ((event.target as HTMLElement).closest?.('[data-page-control]')) return;
    const point = pdf.current?.pointAt(event.clientX, event.clientY) ?? null;
    const id = boxAt(point, 10);
    setHovered(id === REFERENCES ? null : id);
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
      const point = pdf.current?.pointAt(moved.clientX, moved.clientY) ?? null;
      const target = boxAt(point, 16, id);
      if (!point || !target || target === REFERENCES) return setDrag({ id });
      const own = (ordered[target] ?? []).filter((box) => box.page === point.page);
      const top = Math.max(...own.map((box) => box.top));
      const bottom = Math.min(...own.map((box) => box.bottom));
      setDrag({ id, target: { id: target, after: point.y < (top + bottom) / 2 } });
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

  /* ------------------------------------------------------------------ comments on the text */

  const layers = useRef(new Map<number, HTMLElement>());
  const [layerTick, setLayerTick] = useState(0);
  const onTextLayer = useCallback((page: number, layer: HTMLElement | null) => {
    if (layer) layers.current.set(page, layer);
    else layers.current.delete(page);
    setLayerTick((value) => value + 1);
  }, []);
  const ids = useMemo(() => Object.keys(ordered), [ordered]);
  const wanted = ids.flatMap((id) => (comments?.(id)?.quotes ?? []).map((quote) => ({ ...quote, block: id })));
  const wantedKey = JSON.stringify(wanted);
  const [highlights, setHighlights] = useState<Record<number, { id: string; block: string; boxes: Box[] }[]>>({});
  useLayoutEffect(() => {
    const list = JSON.parse(wantedKey) as (QuoteMark & { block: string })[];
    const texts = new Map<number, LayerText>();
    const textOf = (page: number) => {
      const layer = layers.current.get(page);
      if (!layer) return null;
      if (!texts.has(page)) texts.set(page, layerText(layer));
      return { layer, text: texts.get(page)! };
    };
    const next: Record<number, { id: string; block: string; boxes: Box[] }[]> = {};
    for (const mark of list) {
      // The pages its block is on first, then any page.
      const pages = [...new Set([...(ordered[mark.block] ?? []).map((box) => box.page), ...layers.current.keys()])];
      for (const page of pages) {
        const found = textOf(page);
        if (!found) continue;
        const at = findQuote(found.text.text, mark.quote, mark.prefix, mark.suffix);
        if (!at) continue;
        (next[page] ??= []).push({ id: mark.id, block: mark.block, boxes: quoteBoxes(found.layer, found.text, at.start, at.end) });
        break;
      }
    }
    setHighlights(next);
  }, [wantedKey, ordered, layerTick]);

  // A click on highlighted text (not ending a selection) opens its comment.
  const onClickCapture = (event: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return;
    const root = wrapper.current;
    if (!root) return;
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-comment-highlight]'))) {
      const box = element.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) continue;
      const block = element.dataset.block;
      if (block) comments?.(block)?.onOpen(element.dataset.commentHighlight ?? '');
      return;
    }
  };

  /* ------------------------------------------------------------------ handle */

  useImperativeHandle(
    ref,
    () => ({
      blockAt: (clientX, clientY) => boxAt(pdf.current?.pointAt(clientX, clientY) ?? null, 2),
      showHeading: (blockId, index) => {
        const from = shownRef.current;
        const block = from?.blocks.find((item) => item.id === blockId);
        if (!from?.source || !block) return false;
        const line = blockHeadingLines(from.source, block)[index];
        // A heading has no mark of its own: the text after it does.
        const after = from.marks.filter((mark) => !mark.file && (mark.kind === 'L' || mark.kind === 'B') && line !== undefined && mark.line > line).sort((a, b) => a.line - b.line)[0];
        if (!after || !pdf.current) return false;
        pdf.current.show(after.page, after.y + 24);
        return true;
      },
    }),
    [boxAt],
  );

  /* ------------------------------------------------------------------ drawing */

  const hidden = useMemo(() => new Set(paper.blocks.filter((block) => block.hidden).map((block) => block.id)), [paper.blocks]);
  const blockOf = useMemo(() => new Map(paper.blocks.map((block) => [block.id, block])), [paper.blocks]);

  /** Where the text of a page ends on the right, in PDF points: its blocks' widest box. */
  const textRight = (page: number) => Math.max(0, ...Object.values(ordered).flatMap((list) => list.filter((box) => box.page === page).map((box) => box.right)));

  const overlay = (page: number, scale: number, size: Size): React.ReactNode => {
    const px = (box: BlockBox) => ({ left: box.left * scale, top: (size.height - box.top) * scale, width: (box.right - box.left) * scale, height: (box.top - box.bottom) * scale });
    const union = (list: BlockBox[]) => {
      const left = Math.min(...list.map((box) => box.left));
      const right = Math.max(...list.map((box) => box.right));
      const top = Math.max(...list.map((box) => box.top));
      const bottom = Math.min(...list.map((box) => box.bottom));
      return px({ page, left, right, top, bottom });
    };
    return (
      <>
        {Object.entries(ordered).map(([id, list]) => {
          const here = list.filter((box) => box.page === page);
          if (here.length === 0) return null;
          const first = list[0];
          const last = list[list.length - 1];
          const block = blockOf.get(id);
          const isHidden = hidden.has(id);
          // Hovering shows the handle only; its menu, or a drag, outlines the block.
          const grip = editing && (hovered === id || menu === id || drag?.id === id);
          const lit = editing && (menu === id || drag?.id === id);
          const own = comments?.(id);
          const firstPx = px(first);
          return (
            <React.Fragment key={id}>
              {first.page === page && (
                // Where the page, the outline, the comments and the others' avatars find the block.
                <div data-result-block-id={id} className="pointer-events-none absolute scroll-mt-24" style={union(list.filter((box) => box.page === page))} />
              )}
              {first.page === page && (
                // The others looking at the block, in the left margin under its drag handle (the tools take the right).
                <div className="absolute w-0" style={{ left: first.left > size.width / 2 ? textRight(page) * scale - 4 : firstPx.left - 52, top: firstPx.top + 22 }}>
                  <BlockReaders blockId={id} />
                </div>
              )}
              {isHidden &&
                here.map((box, index) => <div key={`h${index}`} className="pointer-events-none absolute z-[1] bg-gray-100/70 mix-blend-multiply" style={px(box)} />)}
              {lit &&
                here.map((box, index) => {
                  const at = px(box);
                  return (
                    <div
                      key={`o${index}`}
                      className="pointer-events-none absolute z-[2] rounded-lg border border-purple-400 shadow-[0_0_0_2px_rgb(192_132_252/12%)]"
                      style={{ left: at.left - 8, top: at.top - 8, width: at.width + 16, height: at.height + 16 }}
                    />
                  );
                })}
              {first.page === page && own && own.count > 0 && own.first && (
                <button
                  type="button"
                  data-page-control
                  onClick={() => own.onOpen(own.first!)}
                  className="absolute z-[3] inline-flex -translate-y-full items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 xl:hidden"
                  style={{ left: firstPx.left, top: firstPx.top - 10 }}
                >
                  <MessageSquare size={12} />
                  {own.count}
                </button>
              )}
              {first.page === page && editing && isHidden && !lit && (
                <span className="absolute z-[3]" style={{ left: textRight(page) * scale + 16, top: firstPx.top - 4 }}>
                  <HiddenBadge />
                </span>
              )}
              {first.page === page && grip && block && (
                <button
                  type="button"
                  data-page-control
                  data-block-grip
                  aria-label={t('这一块的操作')}
                  aria-expanded={menu === id}
                  title={t('点击打开菜单，拖动来移动这一块')}
                  onPointerDown={(event) => startDrag(event, id)}
                  className={`absolute z-[4] flex h-6 w-5 cursor-grab items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-black/[0.06] hover:text-gray-700 active:cursor-grabbing ${menu === id ? 'bg-black/[0.06] text-gray-700' : ''}`}
                  style={{ left: firstPx.left - 10, top: firstPx.top + 2, transform: 'translateX(-100%)' }}
                >
                  <GripVertical size={14} />
                </button>
              )}
              {first.page === page && menu === id && block && !drag && (
                <BlockMenu paperId={paper.id} block={block} published={published} onComment={own?.onAdd} style={{ left: firstPx.left - 10, top: firstPx.top + 28, transform: 'translateX(-24px)' }} />
              )}
              {drag?.target?.id === id &&
                (drag.target.after ? last : first).page === page &&
                (() => {
                  const at = px(drag.target.after ? last : first);
                  return <div className="pointer-events-none absolute z-[5] h-0.5 rounded bg-purple-600" style={{ left: at.left - 8, width: at.width + 16, top: drag.target.after ? at.top + at.height + 6 : at.top - 8 }} />;
                })()}
            </React.Fragment>
          );
        })}
        {(highlights[page] ?? []).map((mark) =>
          mark.boxes.map((box, index) => {
            const active = comments?.(mark.block)?.active === mark.id;
            return (
              <span
                key={`${mark.id}-${index}`}
                data-comment-highlight={mark.id}
                data-block={mark.block}
                className={`pointer-events-none absolute z-[1] rounded-sm mix-blend-multiply ${active ? 'bg-amber-300/80' : 'bg-yellow-200/70'}`}
                style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
              />
            );
          }),
        )}
      </>
    );
  };

  const nothing = !data && !url;
  const upToDate = live && !compiling && Boolean(compiled) && compiled?.source === model.current?.text && shown === compiled;

  return (
    <EditModeContext.Provider value={flushed}>
      {live && (
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/90 px-3 py-1.5 text-xs text-gray-500 shadow-[0_1px_2px_rgba(0,0,0,0.06)] backdrop-blur">
          <span className="inline-flex items-center gap-1.5">
            {compiling || !compiled ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400" />
                {t('核对整篇…')}
              </>
            ) : upToDate ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-emerald-700">{t('和 PDF 一致')}</span>
              </>
            ) : null}
          </span>
          <span>{saveState === 'saving' ? t('保存中…') : saveState === 'dirty' ? t('有未保存的修改') : t('已保存')}</span>
          <span className="ml-auto hidden text-gray-400 md:inline">{t('单击文字直接修改，双击打开这一块的代码')}</span>
          {problem && (
            <span role="alert" className="basis-full text-red-700">
              {showMessage(problem)}
            </span>
          )}
          {compileProblem && (
            <span role="alert" className="basis-full text-red-700">
              {t('整篇论文排版失败：{message}', { message: compileProblem })}
            </span>
          )}
        </div>
      )}
      <div ref={wrapper} onMouseMove={onMouseMove} onMouseLeave={() => !drag && setHovered(null)} onClickCapture={onClickCapture} className={drag ? 'select-none' : undefined}>
        {nothing ? (
          <div className="py-12 text-center text-sm text-gray-400">{readFailed ? t('读取 PDF 失败，请刷新页面重试') : t('正在排版整篇论文…')}</div>
        ) : (
          <PdfPages
            ref={pdf}
            flow
            data={data}
            url={url}
            zoom={1}
            overlay={overlay}
            onLoaded={loaded}
            onTextLayer={onTextLayer}
            onDocumentReady={documentReady}
            onDoubleClick={onDoubleClick}
            onClick={live ? (click) => void onPageClick(click) : undefined}
            editing={pageEdit !== null}
            caret={caretSpot}
            outline={atomSpots}
            pending={pending}
            onCaretText={onPageText}
            onCaretKey={onPageKey}
            onCaretLeave={leavePage}
          />
        )}
      </div>
      {picker && files.current && (
        <PicturePicker
          path={picker.path}
          left={picker.left}
          top={picker.top}
          names={attachmentNames}
          attachments={files.current}
          onChoose={(name) => choosePicture(picker, name)}
          onUpload={(chosen) => void uploadPicture(picker, chosen)}
          onClose={() => setPicker(null)}
        />
      )}
    </EditModeContext.Provider>
  );
});

export default ArticleView;
