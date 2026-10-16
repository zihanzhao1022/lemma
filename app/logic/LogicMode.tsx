import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, MeasuringStrategy, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { AlignLeft, ArrowUpRight, ChevronUp, EyeOff, Image, Minus, Network, Play, Plus, RotateCcw, Scan, Table2, Undo2, X } from 'lucide-react';
import PdfView from '../../components/results/PdfView';
import { describeSaveError } from '../../editor/backend';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import type { ReadFile } from '../../editor/results/actions';
import { resultsCommitMessage } from '../../editor/results/ops';
import { useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultBlockKind, ResultPaper } from '../../types';
import { LabelWords, NodeLabel, nodeLabels } from './labels';
import { changedLogic, logicOf, savedLogic, unsavedLogic } from './latest';
import { BOXES, Layout, layoutTree, link } from './layout';
import { canMove, cleanLogic, logicTree, paperParents, subtreeOf, withMove } from './tree';

interface Props {
  paper: ResultPaper;
  readFile: ReadFile;
  onSave: ResultsSave;
  /** Where the view starts, under the paper's bar. */
  top: number;
  visible: boolean;
  /** Presents the paper block by block from this block, along its logic. */
  onPresent: (start: string | null) => void;
  /** Shows the block in the block view. */
  onOpenBlock: (blockId: string) => void;
}

type Status = 'saved' | 'changed' | 'saving' | 'failed';
type Logic = Record<string, string>;
interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
const PAD = 40;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const sameLogic = (a: Logic, b: Logic) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const KIND_ICON: Record<ResultBlockKind, typeof AlignLeft> = { text: AlignLeft, figure: Image, table: Table2 };

/** The view that shows the whole tree: as large as fits, but not larger than life. */
function fitted(drawn: Layout, width: number, height: number, low: number, high: number): View {
  if (drawn.width === 0) return { x: PAD, y: PAD, k: 1 };
  const k = clamp(Math.min((width - 2 * PAD) / drawn.width, (height - 2 * PAD) / drawn.height), low, high);
  return {
    k,
    x: drawn.width * k <= width - 2 * PAD ? (width - drawn.width * k) / 2 : PAD,
    y: drawn.height * k <= height - 2 * PAD ? (height - drawn.height * k) / 2 : PAD,
  };
}

/** Boxes glide to where a change puts them, so one sees where a moved block went. */
function useGlide(drawn: Layout): Layout {
  const [shown, setShown] = useState(drawn);
  const from = useRef(drawn);
  useEffect(() => {
    if (from.current === drawn) return undefined;
    const start = from.current;
    const settle = () => {
      from.current = drawn;
      setShown(drawn);
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      settle();
      return undefined;
    }
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - began) / 260);
      const eased = 1 - (1 - progress) ** 3;
      const at: Layout['at'] = {};
      for (const [id, end] of Object.entries(drawn.at)) {
        const begin = start.at[id] ?? end;
        at[id] = { x: begin.x + (end.x - begin.x) * eased, y: begin.y + (end.y - begin.y) * eased };
      }
      from.current = { ...drawn, at };
      setShown(from.current);
      if (progress < 1) frame = requestAnimationFrame(step);
      else settle();
    };
    frame = requestAnimationFrame(step);
    // Where frames do not come (a hidden tab), the boxes still end up in place.
    const late = window.setTimeout(settle, 400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(late);
    };
  }, [drawn]);
  return shown;
}

interface BoxProps {
  id: string;
  label: NodeLabel;
  kind: ResultBlockKind;
  hidden: boolean;
  at: { x: number; y: number };
  selected: boolean;
  /** While a block is dragged: it, or a block under it, which it cannot go under. */
  blocked: boolean;
  dragging: boolean;
  /** How many blocks are under it; folded or not. */
  under: number;
  folded: boolean;
  onSelect: (id: string) => void;
  onFold: (id: string) => void;
}

/** A block of the tree: dragged onto another block to go under it, clicked to see it. */
const Box: React.FC<BoxProps> = ({ id, label, kind, hidden, at, selected, blocked, dragging, under, folded, onSelect, onFold }) => {
  const t = useT();
  const drag = useDraggable({ id });
  const drop = useDroppable({ id, disabled: blocked });
  const setRef = (element: HTMLDivElement | null) => {
    drag.setNodeRef(element);
    drop.setNodeRef(element);
  };
  const Icon = KIND_ICON[kind];
  const target = drop.isOver && !blocked;
  return (
    <div
      ref={setRef}
      data-logic-node={id}
      {...drag.attributes}
      {...drag.listeners}
      aria-pressed={selected}
      aria-label={label.title}
      onClick={() => onSelect(id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(id);
        }
      }}
      className={`absolute flex cursor-pointer touch-none select-none flex-col justify-center rounded-xl border bg-white px-3 py-2 text-left outline-none transition-[box-shadow,opacity,border-color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-violet-400 ${
        target
          ? 'border-violet-500 bg-violet-50 shadow-[0_0_0_4px_rgba(124,58,237,0.18)]'
          : selected
            ? 'border-violet-500 shadow-[0_0_0_3px_rgba(124,58,237,0.15),0_6px_16px_-8px_rgba(0,0,0,0.25)]'
            : `${hidden ? 'border-dashed border-gray-300' : 'border-black/[0.09]'} shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:border-violet-300`
      } ${dragging ? 'opacity-30' : blocked ? 'opacity-40' : ''}`}
      style={{ left: at.x, top: at.y, width: BOXES.w, height: BOXES.h }}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-tight text-gray-900">
        <Icon size={13} className={`shrink-0 ${kind === 'text' ? 'text-gray-400' : 'text-violet-500'}`} aria-hidden="true" />
        <span className="truncate">{label.title}</span>
        {hidden && <EyeOff size={12} className="shrink-0 text-gray-400" aria-label={t('已隐藏')} />}
      </span>
      {label.detail && <span className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-gray-500">{label.detail}</span>}
      {target && <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-violet-700 px-2 py-0.5 text-[11px] text-white">{t('放到这一块下面')}</span>}
      {under > 0 && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onFold(id);
          }}
          aria-label={folded ? t('展开下面的 {n} 块', { n: under }) : t('收起下面的块')}
          title={folded ? t('展开下面的 {n} 块', { n: under }) : t('收起下面的块')}
          className="absolute -bottom-2.5 left-1/2 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center rounded-full border border-black/[0.09] bg-white px-1 text-[10.5px] font-medium tabular-nums text-gray-500 shadow-sm hover:border-violet-300 hover:text-violet-700"
        >
          {folded ? `+${under}` : <ChevronUp size={12} />}
        </button>
      )}
    </div>
  );
};

/**
 * The paper's logic as a tree drawn from the top down: first as its headings have it (each subsection under its
 * section), then as the work goes once blocks are dragged under other blocks (each experiment under the method it
 * tests). Only the logic changes, never the paper's order. Saved a moment after each change.
 */
const LogicMode: React.FC<Props> = ({ paper, readFile, onSave, top, visible, onPresent, onOpenBlock }) => {
  const t = useT();
  const markers = useId().replace(/:/g, '');
  const [logic, setLogic] = useState<Logic>(() => logicOf(paper));
  // Logic changed here whose save had not landed when the view opened (or failed) is saved again.
  const [status, setStatus] = useState<Status>(() => (unsavedLogic(paper.id) ? 'changed' : 'saved'));
  const [problem, setProblem] = useMessage();
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [view, setView] = useState<View>({ x: PAD, y: PAD, k: 1 });
  const [dragging, setDragging] = useState<string | null>(null);
  const [pdfs, setPdfs] = useState<Record<string, Uint8Array>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const logicRef = useRef(logic);
  logicRef.current = logic;
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const unsaved = useRef(status === 'changed');
  const saving = useRef<Promise<void> | null>(null);

  const words = useMemo<LabelWords>(
    () => ({
      figure: (n) => (n ? t('图 {n}', { n }) : t('图')),
      table: (n) => (n ? t('表 {n}', { n }) : t('表格')),
      abstract: t('摘要'),
      empty: t('（空白）'),
    }),
    [t],
  );
  const tree = useMemo(() => logicTree({ blocks: paper.blocks, preamble: paper.preamble, logic }), [paper.blocks, paper.preamble, logic]);
  const labels = useMemo(() => nodeLabels(paper, words), [paper, words]);
  const drawn = useMemo(() => layoutTree(tree, folded), [tree, folded]);
  const shown = useGlide(drawn);
  const blocks = useMemo(() => Object.fromEntries(paper.blocks.map((block) => [block.id, block])), [paper.blocks]);
  const paperBase = useMemo(() => paperParents({ blocks: paper.blocks, preamble: paper.preamble }), [paper.blocks, paper.preamble]);
  const moves = Object.values(tree.nodes).filter((node) => node.moved).length;
  const blocked = useMemo(() => (dragging ? subtreeOf(tree, dragging) : null), [dragging, tree]);

  /** Saves the logic as it is now; changes made while saving are saved after. */
  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    const run = (async () => {
      const shot = logicRef.current;
      const current = paperRef.current;
      setStatus('saving');
      try {
        const kept = cleanLogic(current.blocks, shot);
        await onSave(
          { kind: 'patchPaper', id: current.id, fields: { logic: Object.keys(kept).length > 0 ? kept : null } },
          [],
          [],
          resultsCommitMessage('update logic of', current.title),
          `content: update result "${current.title}"`,
        );
        savedLogic(current.id, shot);
        if (logicRef.current === shot) unsaved.current = false;
        setStatus(logicRef.current === shot ? 'saved' : 'changed');
      } catch (error) {
        setStatus('failed');
        setProblem(() => describeSaveError(error));
      } finally {
        saving.current = null;
      }
    })();
    saving.current = run;
    return run;
  }, [onSave, setProblem]);

  useEffect(() => {
    if (status !== 'changed') return undefined;
    const timer = window.setTimeout(() => void flush(), 800);
    return () => window.clearTimeout(timer);
  }, [logic, status, flush]);

  // Leaving the paper saves what is not saved yet, after any save on its way; closing the tab cannot wait for a
  // save, so the browser asks first.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!unsaved.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      const later = () => (unsaved.current ? flushRef.current() : undefined);
      if (unsaved.current) void (saving.current ? saving.current.then(later) : later());
    };
  }, []);

  // The paper's logic saved elsewhere (another tab) shows here when nothing changed here meanwhile.
  useEffect(() => {
    if (!unsaved.current && !saving.current) setLogic(paper.logic ?? {});
  }, [paper.logic]);

  const change = (next: Logic) => {
    logicRef.current = next;
    unsaved.current = true;
    changedLogic(paper.id, next);
    setLogic(next);
    setStatus('changed');
    setProblem(null);
  };

  /** A block brought into sight after a change moved it, once the tree is drawn anew. */
  const reveal = useRef<string | null>(null);

  /** Puts block `id` under `target`, or back where the paper's headings put it (null). */
  const moveUnder = (id: string, target: string | null) => {
    const node = tree.nodes[id];
    if (!node || (target !== null && (!canMove(tree, id, target) || node.parent === target))) return;
    const next = withMove(paper, logicRef.current, id, target);
    if (sameLogic(next, logicRef.current)) return;
    change(next);
    if (target !== null && folded.has(target)) {
      setFolded((current) => {
        const open = new Set(current);
        open.delete(target);
        return open;
      });
    }
    reveal.current = id;
  };

  useLayoutEffect(() => {
    const id = reveal.current;
    const element = viewport.current;
    if (!id || !element || !drawn.at[id]) return;
    reveal.current = null;
    const { width, height } = element.getBoundingClientRect();
    const box = drawn.at[id];
    const left = view.x + box.x * view.k;
    const topEdge = view.y + box.y * view.k;
    // The panel takes the right side on wider screens, the lower part on phones.
    const wide = width >= 640;
    const room = selected && wide ? width - 360 : width;
    const tall = selected && !wide ? height * 0.25 : height;
    if (left >= 0 && topEdge >= 0 && left + BOXES.w * view.k <= room && topEdge + BOXES.h * view.k <= tall) return;
    setView((current) => ({ ...current, x: room / 2 - (box.x + BOXES.w / 2) * current.k, y: tall / 2 - (box.y + BOXES.h / 2) * current.k }));
  }, [drawn, view, selected]);

  // The whole tree in sight the first time the view is shown.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!visible || placed.current || !element) return;
    const { width, height } = element.getBoundingClientRect();
    if (width === 0) return;
    placed.current = true;
    setView(fitted(drawn, width, height, 0.5, 1));
  }, [visible, drawn]);

  const fitAll = () => {
    const element = viewport.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setView(fitted(drawn, width, height, MIN_ZOOM, 1.5));
  };

  /** Zooms by `factor` keeping the point (px, py) of the view where it is. */
  const zoom = useCallback((factor: number, px?: number, py?: number) => {
    const element = viewport.current;
    const rect = element?.getBoundingClientRect();
    const x = px ?? (rect ? rect.width / 2 : 0);
    const y = py ?? (rect ? rect.height / 2 : 0);
    setView((current) => {
      const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = k / current.k;
      return { k, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio };
    });
  }, []);

  // The wheel zooms around the pointer (a pinch on a trackpad too); the page itself never scrolls here.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta = (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1) * event.deltaY;
      zoom(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom]);

  // The middle button drags the canvas anywhere; the left one where there is no block.
  const pan = useRef<{ pointer: number; x: number; y: number; from: View; moved: boolean } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const onBox = (event.target as Element).closest('[data-logic-node]') !== null;
    if (event.button !== 1 && (event.button !== 0 || onBox)) return;
    // The middle button would otherwise scroll the page (or paste, on Linux).
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows it over the canvas.
    }
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: view, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const grab = pan.current;
    if (!grab || grab.pointer !== event.pointerId) return;
    const dx = event.clientX - grab.x;
    const dy = event.clientY - grab.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) grab.moved = true;
    setView({ ...grab.from, x: grab.from.x + dx, y: grab.from.y + dy });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const grab = pan.current;
    if (!grab || grab.pointer !== event.pointerId) return;
    pan.current = null;
    // A click on the canvas, not a drag of it, puts the block in hand down.
    if (!grab.moved && event.button === 0) setSelected(null);
  };

  // Dragging a block to an edge of the view moves the canvas, so a block can go anywhere in a large tree.
  const edge = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!dragging) return undefined;
    let frame = 0;
    const step = () => {
      const point = edge.current;
      const rect = viewport.current?.getBoundingClientRect();
      if (point && rect) {
        const push = (distance: number) => (distance < 56 ? Math.round(((56 - distance) / 56) * 14) : 0);
        const dx = push(point.x - rect.left) - push(rect.right - point.x);
        const dy = push(point.y - rect.top) - push(rect.bottom - point.y);
        if (dx !== 0 || dy !== 0) setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const toggleFold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The selected block's PDF for the panel.
  const chosen = selected ? blocks[selected] : undefined;
  useEffect(() => {
    const pdf = chosen?.output?.pdf;
    if (!pdf || pdfs[pdf]) return;
    readFile(pdf).then(
      (bytes) => setPdfs((current) => ({ ...current, [pdf]: bytes })),
      () => undefined,
    );
  }, [chosen, pdfs, readFile]);
  useEffect(() => {
    if (selected && !tree.nodes[selected]) setSelected(null);
  }, [selected, tree]);

  const underCount = (id: string) => subtreeOf(tree, id).size - 1;
  const node = selected ? tree.nodes[selected] : undefined;
  const own = selected ? subtreeOf(tree, selected) : new Set<string>();
  const base = selected ? paperBase[selected] : null;
  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  const control = 'flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-gray-600 hover:bg-black/[0.05] hover:text-gray-900';

  return (
    <div className={`fixed inset-x-0 bottom-0 z-20 flex flex-col bg-white ${visible ? '' : 'hidden'}`} style={{ top }}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.06] px-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-gray-800">
          <Network size={15} className="text-violet-600" />
          {t('逻辑结构')}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs text-gray-400">
          {{ saved: t('已保存'), changed: t('有未保存的修改'), saving: t('保存中…'), failed: t('没有保存') }[status]}
        </span>
        <span className="hidden min-w-0 truncate text-xs text-gray-400 lg:block">{t('把一块拖到另一块上，它就归到那一块下面；按住中键或空白处拖动画布，滚轮缩放。')}</span>
        <span className="ml-auto flex items-center gap-1">
          {moves > 0 && (
            <button
              type="button"
              className={bar}
              title={t('恢复论文结构')}
              onClick={() => {
                if (window.confirm(t('把所有块放回论文里的位置？'))) change({});
              }}
            >
              <RotateCcw size={14} />
              <span className="hidden sm:inline">{t('恢复论文结构')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onPresent(selected)}
            disabled={tree.order.length === 0}
            className="galley-press ml-1 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-violet-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-violet-800 disabled:opacity-40"
          >
            <Play size={14} />
            {selected ? (
              <>
                <span className="sm:hidden">{t('演示')}</span>
                <span className="hidden sm:inline">{t('从选中的块演示')}</span>
              </>
            ) : (
              t('演示')
            )}
          </button>
        </span>
      </div>
      {problem && (
        <p role="alert" className="shrink-0 border-b border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-700">
          {problem}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          autoScroll={false}
          onDragStart={({ active }) => setDragging(String(active.id))}
          onDragMove={({ activatorEvent, delta }) => {
            const start = activatorEvent as PointerEvent;
            edge.current = { x: start.clientX + delta.x, y: start.clientY + delta.y };
          }}
          onDragEnd={({ active, over }) => {
            setDragging(null);
            edge.current = null;
            if (over) moveUnder(String(active.id), String(over.id));
          }}
          onDragCancel={() => {
            setDragging(null);
            edge.current = null;
          }}
        >
          <div
            ref={viewport}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onAuxClick={(event) => event.preventDefault()}
            className={`absolute inset-0 touch-none overflow-hidden bg-[#f6f6f8] ${pan.current ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.09) 1px, transparent 1.2px)',
              backgroundSize: `${22 * view.k}px ${22 * view.k}px`,
              backgroundPosition: `${view.x}px ${view.y}px`,
            }}
          >
            {tree.order.length === 0 ? (
              <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500">{t('这篇论文还没有块。先在「分块」里添加文字、图或表格。')}</p>
            ) : (
              <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: drawn.width, height: drawn.height }}>
                <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={drawn.width} height={drawn.height} aria-hidden="true">
                  <defs>
                    {(
                      [
                        ['paper', '#b9b9c3'],
                        ['moved', '#7c3aed'],
                      ] as const
                    ).map(([name, color]) => (
                      <marker key={name} id={`${markers}-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </marker>
                    ))}
                  </defs>
                  {Object.keys(shown.at).map((id) => {
                    const parent = tree.nodes[id]?.parent;
                    if (!parent || !shown.at[parent]) return null;
                    const moved = tree.nodes[id].moved;
                    return (
                      <path
                        key={id}
                        d={link(shown.at[parent], shown.at[id])}
                        fill="none"
                        stroke={moved ? '#7c3aed' : '#b9b9c3'}
                        strokeWidth={moved ? 2 : 1.5}
                        markerEnd={`url(#${markers}-${moved ? 'moved' : 'paper'})`}
                      />
                    );
                  })}
                </svg>
                {Object.entries(shown.at).map(([id, at]) => (
                  <Box
                    key={id}
                    id={id}
                    label={labels[id] ?? { title: id }}
                    kind={blocks[id]?.kind ?? 'text'}
                    hidden={!!blocks[id]?.hidden}
                    at={at}
                    selected={selected === id}
                    blocked={!!blocked?.has(id)}
                    dragging={dragging === id}
                    under={tree.nodes[id]?.children.length ? underCount(id) : 0}
                    folded={folded.has(id)}
                    onSelect={setSelected}
                    onFold={toggleFold}
                  />
                ))}
              </div>
            )}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging && labels[dragging] ? (
              <div className="pointer-events-none flex max-w-[220px] items-center gap-1.5 rounded-xl border border-violet-400 bg-white px-3 py-2 text-[13px] font-medium text-gray-900 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35)]">
                <Network size={13} className="shrink-0 text-violet-500" />
                <span className="truncate">{labels[dragging].title}</span>
                {underCount(dragging) > 0 && <span className="shrink-0 text-xs font-normal text-gray-500">{t('连同下面 {n} 块', { n: underCount(dragging) })}</span>}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {/* The legend and the zoom, over the canvas. */}
        <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg bg-white/95 p-0.5 shadow-sm ring-1 ring-black/[0.06]">
            <button type="button" onClick={() => zoom(1 / 1.25)} aria-label={t('缩小')} title={t('缩小')} className={control}>
              <Minus size={15} />
            </button>
            <button type="button" onClick={() => zoom(1 / view.k)} title={t('原始大小')} className={`${control} w-12 text-xs tabular-nums`}>
              {Math.round(view.k * 100)}%
            </button>
            <button type="button" onClick={() => zoom(1.25)} aria-label={t('放大')} title={t('放大')} className={control}>
              <Plus size={15} />
            </button>
            <button type="button" onClick={fitAll} aria-label={t('显示全部')} title={t('显示全部')} className={control}>
              <Scan size={15} />
            </button>
          </div>
          <div className="hidden items-center gap-3 rounded-lg bg-white/95 px-3 py-1.5 text-[11.5px] text-gray-500 shadow-sm ring-1 ring-black/[0.06] sm:flex">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-[#b9b9c3]" />
              {t('论文里的层级')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-violet-600" />
              {t('拖过来的')}
            </span>
          </div>
        </div>

        {selected && node && (
          <aside
            aria-label={labels[selected]?.title}
            className="absolute inset-x-3 bottom-3 z-10 flex max-h-[75%] flex-col overflow-hidden rounded-xl bg-white shadow-[0_16px_48px_-16px_rgba(0,0,0,0.35)] ring-1 ring-black/[0.06] sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[340px]"
          >
            <header className="flex items-start gap-2 border-b border-black/[0.06] px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900">{labels[selected]?.title}</p>
                {node.moved && node.parent && (
                  <p className="mt-0.5 text-xs text-violet-700">{t('已归到「{name}」下面', { name: labels[node.parent]?.title ?? '' })}</p>
                )}
              </div>
              <button type="button" onClick={() => setSelected(null)} aria-label={t('关闭')} className="rounded p-1 text-gray-400 hover:bg-black/[0.05] hover:text-gray-700">
                <X size={16} />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto bg-neutral-50 p-3">
              {chosen?.output ? (
                <div className="bg-white shadow-sm">
                  <PdfView key={chosen.output.pdf} data={pdfs[chosen.output.pdf]} width={chosen.output.width} height={chosen.output.height} maxScale={2} />
                </div>
              ) : (
                <p className="py-8 text-center text-xs text-gray-400">{t('这一块还没有编译好的结果。')}</p>
              )}
            </div>
            <div className="space-y-3 border-t border-black/[0.06] px-4 py-3">
              <label className="block text-xs text-gray-500">
                {t('归在哪一块下面')}
                <select
                  value={node.moved && node.parent ? node.parent : ''}
                  onChange={(event) => moveUnder(selected, event.target.value || null)}
                  className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[13px] text-gray-800 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
                >
                  <option value="">{base ? t('论文里的位置：{name}', { name: labels[base]?.title ?? '' }) : t('论文里的位置：最上层')}</option>
                  {tree.order
                    .filter((id) => !own.has(id))
                    .map((id) => (
                      <option key={id} value={id}>
                        {'   '.repeat(tree.nodes[id].depth)}
                        {labels[id]?.title ?? id}
                      </option>
                    ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {node.moved && (
                  <button type="button" onClick={() => moveUnder(selected, null)} className={`${bar} ring-1 ring-black/[0.08]`}>
                    <Undo2 size={14} />
                    {t('放回论文里的位置')}
                  </button>
                )}
                <button type="button" onClick={() => onPresent(selected)} className={`${bar} ring-1 ring-black/[0.08]`}>
                  <Play size={14} />
                  {t('从这里演示')}
                </button>
                <button type="button" onClick={() => onOpenBlock(selected)} className={`${bar} ring-1 ring-black/[0.08]`}>
                  <ArrowUpRight size={14} />
                  {t('在分块里打开')}
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};

export default LogicMode;
