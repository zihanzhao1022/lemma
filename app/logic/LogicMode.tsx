import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CollisionDetection,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { AlignLeft, ArrowUpRight, ChevronUp, EyeOff, GripVertical, Image, Minus, Network, Play, Plus, Scan, Table2, Trash2, Undo2, X } from 'lucide-react';
import PdfView from '../../components/results/PdfView';
import { describeSaveError } from '../../editor/backend';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import type { ReadFile } from '../../editor/results/actions';
import { resultsCommitMessage } from '../../editor/results/ops';
import { useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultBlock, ResultBlockKind, ResultPaper } from '../../types';
import { LabelWords, NodeLabel, nodeLabels } from './labels';
import { changedLogic, logicOf, savedLogic, unsavedLogic } from './latest';
import { BOXES, Layout, layoutTree, link } from './layout';
import { Logic, canMove, cleanLogic, logicTree, subtreeOf, withPlacement, withoutBlock } from './tree';

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
interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
const PAD = 40;
/** The list's preview of a block is cut off below this height, in pixels. */
const PREVIEW_HEIGHT = 144;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const sameLogic = (a: Logic, b: Logic) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const KIND_ICON: Record<ResultBlockKind, typeof AlignLeft> = { text: AlignLeft, figure: Image, table: Table2 };

/** What is dragged: a block of the list (`card:`) or of the tree (`node:`); where it lands: a block of the tree, the canvas, or back on the list. */
const LIST = 'list';
const CANVAS = 'canvas';
const cardId = (id: string) => `card:${id}`;
const nodeId = (id: string) => `node:${id}`;
const blockOf = (dragged: string) => dragged.replace(/^(card|node):/, '');

/** A block of the tree under the pointer first, then the canvas or the list around it. */
const landing: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const box = hits.find((hit) => String(hit.id).startsWith('node:'));
  if (box) return [box];
  const area = hits.find((hit) => hit.id === CANVAS || hit.id === LIST);
  return area ? [area] : [];
};

/** The view that shows the whole tree: as large as fits, within `low` and `high`. */
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

/** An area blocks are dropped on: the canvas (a new block at the top) or the list (out of the tree). */
const DropArea: React.FC<{ id: string; className: string; areaRef?: React.MutableRefObject<HTMLDivElement | null>; children: (over: boolean) => React.ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>> = ({
  id,
  className,
  areaRef,
  children,
  ...rest
}) => {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        if (areaRef) areaRef.current = element;
      }}
      className={className}
      {...rest}
    >
      {children(isOver)}
    </div>
  );
};

/** A block of the paper in the list, as the block view shows it, dragged into the tree from here. */
const Card: React.FC<{ block: ResultBlock; label: NodeLabel; pdf?: Uint8Array; inTree: boolean; selected: boolean; onSelect: (id: string) => void }> = ({ block, label, pdf, inTree, selected, onSelect }) => {
  const t = useT();
  const drag = useDraggable({ id: cardId(block.id) });
  const Icon = KIND_ICON[block.kind];
  const output = block.output;
  // A preview taller than the room it gets fades out at the bottom.
  const tall = output ? (output.height / output.width) * 280 > PREVIEW_HEIGHT : false;
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      aria-label={label.title}
      onClick={() => onSelect(block.id)}
      title={inTree ? undefined : t('拖到右边的画布上，放进逻辑树')}
      className={`relative cursor-grab touch-pan-y select-none rounded-xl border bg-white transition-[border-color,box-shadow,opacity] duration-150 active:cursor-grabbing ${
        selected ? 'border-violet-500 shadow-[0_0_0_3px_rgba(124,58,237,0.15)]' : inTree ? 'border-violet-200' : 'border-black/[0.08] hover:border-violet-300'
      } ${drag.isDragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-1.5 px-2.5 pt-2 text-[12.5px] font-medium text-gray-800">
        <GripVertical size={13} className="shrink-0 text-gray-300" aria-hidden="true" />
        <Icon size={13} className={`shrink-0 ${block.kind === 'text' ? 'text-gray-400' : 'text-violet-500'}`} aria-hidden="true" />
        <span className="min-w-0 truncate">{label.title}</span>
        {block.hidden && <EyeOff size={12} className="shrink-0 text-gray-400" aria-label={t('已隐藏')} />}
        {inTree && <span className="ml-auto shrink-0 rounded-full bg-violet-50 px-1.5 py-px text-[10.5px] font-normal text-violet-700">{t('在树里')}</span>}
      </div>
      {/* The block as compiled; dragging it never selects its text. */}
      <div className="pointer-events-none relative mx-2.5 mb-2.5 mt-1.5 overflow-hidden" style={{ maxHeight: PREVIEW_HEIGHT }}>
        {output ? (
          <PdfView data={pdf} width={output.width} height={output.height} maxScale={1.5} />
        ) : (
          <p className="py-2 text-xs text-gray-400">{label.detail ?? t('这一块还没有编译好的结果。')}</p>
        )}
        {tall && <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent" />}
      </div>
    </div>
  );
};

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
  const drag = useDraggable({ id: nodeId(id) });
  const drop = useDroppable({ id: nodeId(id), disabled: blocked });
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
 * The paper's logic, built by hand: its blocks listed on the left as the block view shows them, the tree on a
 * canvas on the right, drawn from the top down. A block dragged onto the canvas starts a branch; onto a block of
 * the tree, it goes under that block (an experiment under the method it tests); back onto the list, it leaves
 * the tree. Only the logic changes, never the paper's order. Saved a moment after each change.
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
  const viewport = useRef<HTMLDivElement | null>(null);
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
  const tree = useMemo(() => logicTree({ blocks: paper.blocks, logic }), [paper.blocks, logic]);
  const labels = useMemo(() => nodeLabels(paper, words), [paper, words]);
  const drawn = useMemo(() => layoutTree(tree, folded), [tree, folded]);
  const shown = useGlide(drawn);
  const blocks = useMemo(() => Object.fromEntries(paper.blocks.map((block) => [block.id, block])), [paper.blocks]);
  const blocked = useMemo(() => {
    if (!dragging) return null;
    return tree.nodes[dragging] ? subtreeOf(tree, dragging) : new Set([dragging]);
  }, [dragging, tree]);

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

  // Each block's PDF, for the list and the panel, read once.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const block of paper.blocks) {
      const pdf = block.output?.pdf;
      if (!pdf || requested.current.has(pdf)) continue;
      requested.current.add(pdf);
      readFile(pdf).then(
        (bytes) => setPdfs((loaded) => ({ ...loaded, [pdf]: bytes })),
        () => requested.current.delete(pdf),
      );
    }
  }, [paper.blocks, readFile]);

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

  /** Puts block `id` (from the list or the tree) under `target`, or at the top (null). */
  const place = (id: string, target: string | null) => {
    if (target !== null && !canMove(tree, id, target)) return;
    if (tree.nodes[id] && tree.nodes[id].parent === target) return;
    const next = withPlacement(paper.blocks, logicRef.current, id, target);
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

  /** Takes block `id` out of the tree; the blocks under it go up to where it was. */
  const remove = (id: string) => {
    if (!tree.nodes[id]) return;
    change(withoutBlock(paper.blocks, logicRef.current, id));
    if (selected === id) setSelected(null);
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

  // The whole tree in sight the first time the view is shown with one.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!visible || placed.current || !element || tree.order.length === 0) return;
    const { width, height } = element.getBoundingClientRect();
    if (width === 0) return;
    placed.current = true;
    setView(fitted(drawn, width, height, 0.5, 1));
  }, [visible, drawn, tree.order.length]);

  const fitAll = () => {
    const element = viewport.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setView(fitted(drawn, width, height, MIN_ZOOM, 1.5));
  };

  /** Zooms by `factor` keeping the point (px, py) of the view where it is. */
  const zoom = useCallback((factor: number, px?: number, py?: number) => {
    const rect = viewport.current?.getBoundingClientRect();
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

  // Dragging a block to an edge of the canvas moves the canvas, so a block can go anywhere in a large tree.
  const edge = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!dragging) return undefined;
    let frame = 0;
    const step = () => {
      const point = edge.current;
      const rect = viewport.current?.getBoundingClientRect();
      if (point && rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
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

  useEffect(() => {
    if (selected && !tree.nodes[selected]) setSelected(null);
  }, [selected, tree]);

  /** A block chosen in the list: the same block in the tree, brought into sight. */
  const choose = (id: string) => {
    if (!tree.nodes[id]) return;
    setSelected(id);
    reveal.current = id;
  };

  const underCount = (id: string) => subtreeOf(tree, id).size - 1;
  const node = selected ? tree.nodes[selected] : undefined;
  const chosen = selected ? blocks[selected] : undefined;
  const own = selected ? subtreeOf(tree, selected) : new Set<string>();
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
        <span className="hidden min-w-0 truncate text-xs text-gray-400 xl:block">{t('把左边的块拖到画布上；拖到一个块上，它就归到那一块下面；拖回左边就从树里拿掉。中键或空白处拖动画布，滚轮缩放。')}</span>
        <span className="ml-auto flex items-center gap-1">
          {tree.order.length > 0 && (
            <button
              type="button"
              className={bar}
              title={t('清空逻辑树')}
              onClick={() => {
                if (window.confirm(t('清空这棵逻辑树？论文本身不受影响。'))) change({});
              }}
            >
              <Trash2 size={14} />
              <span className="hidden sm:inline">{t('清空')}</span>
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
      <DndContext
        sensors={sensors}
        collisionDetection={landing}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        autoScroll={false}
        onDragStart={({ active }) => setDragging(blockOf(String(active.id)))}
        onDragMove={({ activatorEvent, delta }) => {
          const start = activatorEvent as PointerEvent;
          edge.current = { x: start.clientX + delta.x, y: start.clientY + delta.y };
        }}
        onDragEnd={({ active, over }) => {
          setDragging(null);
          edge.current = null;
          const id = blockOf(String(active.id));
          const where = over ? String(over.id) : null;
          if (where === LIST) remove(id);
          else if (where === CANVAS) place(id, null);
          else if (where?.startsWith('node:')) place(id, blockOf(where));
        }}
        onDragCancel={() => {
          setDragging(null);
          edge.current = null;
        }}
      >
        <div className="flex min-h-0 flex-1">
          {/* The paper's blocks, in its order; a block taken out of the tree comes back here. */}
          <DropArea id={LIST} className="flex w-40 shrink-0 flex-col border-r border-black/[0.06] bg-[#f5f5f7] sm:w-72 lg:w-80">
            {(over) => (
              <>
                <p className="flex shrink-0 items-baseline gap-2 px-3 pb-1.5 pt-3 text-xs font-medium text-gray-500">
                  {t('论文的块')}
                  <span className="font-normal tabular-nums text-gray-400">{t('{n} / {m} 在树里', { n: tree.order.length, m: paper.blocks.length })}</span>
                </p>
                <div className={`min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3 transition-colors duration-150 ${over && dragging && tree.nodes[dragging] ? 'bg-violet-50/70' : ''}`}>
                  {over && dragging && tree.nodes[dragging] && (
                    <p className="sticky top-0 z-10 rounded-lg border border-dashed border-violet-300 bg-violet-50 py-3 text-center text-xs text-violet-700">{t('放开，从树里拿掉')}</p>
                  )}
                  {paper.blocks.length === 0 && <p className="py-6 text-center text-xs text-gray-400">{t('这篇论文还没有块。先在「分块」里添加文字、图或表格。')}</p>}
                  {paper.blocks.map((block) => (
                    <Card
                      key={block.id}
                      block={block}
                      label={labels[block.id] ?? { title: block.id }}
                      pdf={block.output ? pdfs[block.output.pdf] : undefined}
                      inTree={!!tree.nodes[block.id]}
                      selected={selected === block.id}
                      onSelect={choose}
                    />
                  ))}
                </div>
              </>
            )}
          </DropArea>

          <div className="relative min-w-0 flex-1">
            <DropArea
              id={CANVAS}
              areaRef={viewport}
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
              {(over) =>
                tree.order.length === 0 ? (
                  <div className={`pointer-events-none absolute inset-6 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-colors duration-150 ${over ? 'border-violet-400 bg-violet-50/60' : 'border-black/[0.08]'}`}>
                    <Network size={28} className="text-violet-400" />
                    <p className="mt-3 text-[15px] font-medium text-gray-800">{t('从左边把块拖到这里，开始搭逻辑树')}</p>
                    <p className="mt-1 max-w-sm px-4 text-sm text-gray-500">{t('先放方法，再把实验拖到对应的方法上，它们就挂在那个方法下面。')}</p>
                  </div>
                ) : (
                  <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: drawn.width, height: drawn.height }}>
                    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={drawn.width} height={drawn.height} aria-hidden="true">
                      <defs>
                        <marker id={`${markers}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#8b5cf6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </marker>
                      </defs>
                      {Object.keys(shown.at).map((id) => {
                        const parent = tree.nodes[id]?.parent;
                        if (!parent || !shown.at[parent]) return null;
                        return <path key={id} d={link(shown.at[parent], shown.at[id])} fill="none" stroke="#8b5cf6" strokeWidth={1.75} markerEnd={`url(#${markers}-arrow)`} />;
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
                )
              }
            </DropArea>

            {/* The zoom, over the canvas. */}
            {tree.order.length > 0 && (
              <div className="absolute bottom-3 left-3 flex items-center rounded-lg bg-white/95 p-0.5 shadow-sm ring-1 ring-black/[0.06]">
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
            )}

            {selected && node && (
              <aside
                aria-label={labels[selected]?.title}
                className="absolute inset-x-3 bottom-3 z-10 flex max-h-[75%] flex-col overflow-hidden rounded-xl bg-white shadow-[0_16px_48px_-16px_rgba(0,0,0,0.35)] ring-1 ring-black/[0.06] sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[340px]"
              >
                <header className="flex items-start gap-2 border-b border-black/[0.06] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">{labels[selected]?.title}</p>
                    {node.parent && <p className="mt-0.5 text-xs text-violet-700">{t('在「{name}」下面', { name: labels[node.parent]?.title ?? '' })}</p>}
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
                      value={node.parent ?? ''}
                      onChange={(event) => place(selected, event.target.value || null)}
                      className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[13px] text-gray-800 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
                    >
                      <option value="">{t('最上层')}</option>
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
                    <button type="button" onClick={() => remove(selected)} className={`${bar} ring-1 ring-black/[0.08]`}>
                      <Undo2 size={14} />
                      {t('从树里拿掉')}
                    </button>
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
        <DragOverlay dropAnimation={null}>
          {dragging && labels[dragging] ? (
            <div className="pointer-events-none flex max-w-[240px] items-center gap-1.5 rounded-xl border border-violet-400 bg-white px-3 py-2 text-[13px] font-medium text-gray-900 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35)]">
              <Network size={13} className="shrink-0 text-violet-500" />
              <span className="truncate">{labels[dragging].title}</span>
              {tree.nodes[dragging] && underCount(dragging) > 0 && <span className="shrink-0 text-xs font-normal text-gray-500">{t('连同下面 {n} 块', { n: underCount(dragging) })}</span>}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
};

export default LogicMode;
