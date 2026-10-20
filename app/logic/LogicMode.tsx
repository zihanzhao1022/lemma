import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { ForceLink, Simulation, SimulationLinkDatum, SimulationNodeDatum, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { AlignLeft, GripVertical, Image, Link2, ListTree, Minus, Network, Play, Plus, RotateCcw, Scan, Search, Table2, Trash2, Undo2, X } from 'lucide-react';
import { useEditMode } from '../../components/EditMode';
import { BlockWithTools } from '../../components/results/ResultPage';
import { describeSaveError } from '../../editor/backend';
import { newBlockId } from '../../editor/results/actions';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import { resultsCommitMessage } from '../../editor/results/ops';
import { N_, useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultBlock, ResultBlockKind, ResultPaper } from '../../types';
import { Placed, Relation, cleanRelations, fitAll, graphOf, nodeAt, radiusOf, related, relatedTo, startOf, withRelation, withoutRelation } from './graph';
import { LabelWords, NodeLabel, nodeLabels } from './labels';
import { LogicDraft, changedDraft, draftOf, savedDraft, unsavedLogic } from './latest';
import { Logic, TOP, branchEnd, cleanLogic, logicTree, placedIn, subtreeOf, withPlacement, withoutBlock } from './tree';

interface Props {
  paper: ResultPaper;
  onSave: ResultsSave;
  /** Where the view starts, under the paper's bar. */
  top: number;
  visible: boolean;
  /** Presents the paper block by block from this block, along its logic. */
  onPresent: (start: string | null) => void;
}

type Status = 'saved' | 'changed' | 'saving' | 'failed';
interface View {
  x: number;
  y: number;
  k: number;
}
interface GraphNode extends SimulationNodeDatum {
  id: string;
  r: number;
}
type GraphEdge = SimulationLinkDatum<GraphNode>;

const KIND_ICON: Record<ResultBlockKind, typeof AlignLeft> = { text: AlignLeft, figure: Image, table: Table2 };
const KINDS: ResultBlockKind[] = ['text', 'figure', 'table'];
const KIND_NAME: Record<ResultBlockKind, string> = { text: N_('文字'), figure: N_('图'), table: N_('表格') };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const shortTitle = (title: string) => (title.length > 28 ? `${title.slice(0, 27)}…` : title);

/** Where the author put nodes by hand, per paper and per browser: a layout, not part of the paper. */
type Pins = Record<string, [number, number]>;
const pinKey = (paperId: string) => `lemma-graph:${paperId}`;
function readPins(paperId: string): Pins {
  try {
    return JSON.parse(localStorage.getItem(pinKey(paperId)) ?? '{}') as Pins;
  } catch {
    return {};
  }
}
function writePins(paperId: string, pins: Pins): void {
  try {
    if (Object.keys(pins).length > 0) localStorage.setItem(pinKey(paperId), JSON.stringify(pins));
    else localStorage.removeItem(pinKey(paperId));
  } catch {
    // The layout stays for this visit only.
  }
}

/** A block of the paper in the list, dragged from here onto a node of the graph. */
const ListItem: React.FC<{ block: ResultBlock; label: NodeLabel; inGraph: boolean; selected: boolean; onPick: (id: string) => void }> = ({ block, label, inGraph, selected, onPick }) => {
  const t = useT();
  const drag = useDraggable({ id: `card:${block.id}` });
  const Icon = KIND_ICON[block.kind];
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      onClick={() => onPick(block.id)}
      title={inGraph ? label.title : t('拖到图里的一个节点上，就成为它的一个分支')}
      className={`flex cursor-grab touch-pan-y select-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors duration-150 active:cursor-grabbing ${
        selected ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-gray-700 hover:bg-black/[0.04]'
      } ${drag.isDragging ? 'opacity-40' : ''}`}
    >
      <GripVertical size={13} className="shrink-0 text-gray-300" aria-hidden="true" />
      <Icon size={13} className={`shrink-0 ${block.kind === 'text' ? 'text-gray-400' : 'text-violet-500'}`} aria-hidden="true" />
      <span className="min-w-0 truncate">{label.title}</span>
      {inGraph && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" title={t('在图里')} />}
    </div>
  );
};

/** The kinds a new block can be, as the block view offers them; a press elsewhere or Escape closes it. */
const KindMenu: React.FC<{
  onPick: (kind: ResultBlockKind) => void;
  onClose: () => void;
  /** Presses in here (the menu and the button that opened it) leave it open; the menu itself when omitted. */
  within?: React.RefObject<HTMLElement>;
  className?: string;
  style?: React.CSSProperties;
}> = ({ onPick, onClose, within, className = '', style }) => {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!(within ?? menu).current?.contains(event.target as Node)) close.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [within]);
  return (
    <div ref={menu} role="menu" aria-label={t('新建一块')} className={`z-40 w-36 rounded-xl bg-white p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.08] ${className}`} style={style}>
      <p className="px-2 pb-0.5 pt-1 text-[11px] text-gray-400">{t('新建一块')}</p>
      {KINDS.map((kind, index) => {
        const Icon = KIND_ICON[kind];
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            autoFocus={index === 0}
            onClick={() => onPick(kind)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-gray-700 outline-none hover:bg-violet-50 hover:text-violet-800 focus-visible:bg-violet-50 focus-visible:text-violet-800"
          >
            <Icon size={14} className={kind === 'text' ? 'text-gray-400' : 'text-violet-500'} aria-hidden="true" />
            {t(KIND_NAME[kind])}
          </button>
        );
      })}
    </div>
  );
};

/** The canvas, a place blocks from the list are dropped on. */
const Canvas = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Canvas(props, ref) {
  const { setNodeRef } = useDroppable({ id: 'graph' });
  return (
    <div
      {...props}
      ref={(element) => {
        setNodeRef(element);
        if (typeof ref === 'function') ref(element);
        else if (ref) ref.current = element;
      }}
    />
  );
});

/**
 * The paper's logic as a graph, like Obsidian's: blocks as nodes, a line from each block to the blocks that hang
 * under it, laid out by forces and starting from the introduction. Blocks dragged from the list onto a node become
 * branches of it; a node dragged onto another goes under it, anywhere else it stays where it is put. Only the
 * logic changes, never the paper's order; where nodes were put stays in this browser.
 */
const LogicMode: React.FC<Props> = ({ paper, onSave, top, visible, onPresent }) => {
  const t = useT();
  // The logic and the lines drawn between its blocks, changed and saved together.
  const [draft, setDraft] = useState<LogicDraft>(() => draftOf(paper));
  const { logic, relations } = draft;
  // Logic changed here whose save had not landed when the view opened (or failed) is saved again.
  const [status, setStatus] = useState<Status>(() => (unsavedLogic(paper.id) ? 'changed' : 'saved'));
  const [problem, setProblem] = useMessage();
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [listDrag, setListDrag] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [listOpen, setListOpen] = useState(false);
  // What the panel's picker adds to the chosen block: a branch under it, or a line to it.
  const [picker, setPicker] = useState<'branch' | 'line' | null>(null);
  // A line being drawn from a node to the pointer, and a line clicked to take it away.
  const [drawing, setDrawing] = useState<{ from: string; x: number; y: number } | null>(null);
  const [pickedLine, setPickedLine] = useState<Relation | null>(null);
  const [query, setQuery] = useState('');
  // The kinds a new block can be, offered under the bar's button or where the canvas was double-clicked; the
  // block shows at `at` once saved.
  const [adding, setAdding] = useState<{ menu: 'bar' | { left: number; top: number }; at: [number, number] } | null>(null);
  const addButton = useRef<HTMLSpanElement>(null);
  // A block asked for here: once its save lands it goes into the graph, under `parent` or alone at `at`.
  const asked = useRef<{ id: string; parent: string | null; at: [number, number] | null } | null>(null);
  const { open } = useEditMode();
  const [, setFrame] = useState(0);
  const viewport = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const unsaved = useRef(status === 'changed');
  const saving = useRef<Promise<void> | null>(null);
  const pins = useRef<Pins>(readPins(paper.id));

  const words = useMemo<LabelWords>(
    () => ({
      figure: (n) => (n ? t('图 {n}', { n }) : t('图')),
      table: (n) => (n ? t('表 {n}', { n }) : t('表格')),
      abstract: t('摘要'),
      empty: t('（空白）'),
    }),
    [t],
  );
  const start = useMemo(() => startOf(paper), [paper]);
  const startRef = useRef(start);
  startRef.current = start;
  // The start is where the logic begins: never under another block, whatever an earlier version stored.
  const tree = useMemo(
    () => logicTree({ blocks: paper.blocks, logic: start && logic[start] !== undefined && logic[start] !== TOP ? { ...logic, [start]: TOP } : logic }),
    [paper.blocks, logic, start],
  );
  const graph = useMemo(() => graphOf(tree, start), [tree, start]);
  const labels = useMemo(() => nodeLabels(paper, words), [paper, words]);
  const blocks = useMemo(() => Object.fromEntries(paper.blocks.map((block) => [block.id, block])), [paper.blocks]);
  const inGraph = useMemo(() => new Set(graph.ids), [graph.ids]);
  // The lines drawn between blocks that are both in the graph.
  const lines = useMemo(() => cleanRelations(relations, inGraph), [relations, inGraph]);

  /** Saves the logic as it is now; changes made while saving are saved after. */
  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    const run = (async () => {
      const shot = draftRef.current;
      const current = paperRef.current;
      setStatus('saving');
      try {
        const kept = cleanLogic(current.blocks, shot.logic);
        const first = startRef.current;
        if (first && kept[first] !== undefined) kept[first] = TOP;
        // Lines only between blocks that are still in the graph.
        const lines = cleanRelations(shot.relations, new Set([...placedIn(current.blocks, kept), ...(first ? [first] : [])]));
        await onSave(
          { kind: 'patchPaper', id: current.id, fields: { logic: Object.keys(kept).length > 0 ? kept : null, relations: lines.length > 0 ? lines : null } },
          [],
          [],
          resultsCommitMessage('update logic of', current.title),
          `content: update result "${current.title}"`,
        );
        savedDraft(current.id, shot);
        if (draftRef.current === shot) unsaved.current = false;
        setStatus(draftRef.current === shot ? 'saved' : 'changed');
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
  }, [draft, status, flush]);

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
    if (!unsaved.current && !saving.current) setDraft({ logic: paper.logic ?? {}, relations: paper.relations ?? [] });
  }, [paper.logic, paper.relations]);

  const change = (nextLogic: Logic, nextRelations: Relation[] = draftRef.current.relations) => {
    const next: LogicDraft = { logic: nextLogic, relations: nextRelations };
    draftRef.current = next;
    unsaved.current = true;
    changedDraft(paper.id, next);
    setDraft(next);
    setStatus('changed');
    setProblem(null);
  };
  /** Draws a line between two blocks of the graph, or takes one away. */
  const relate = (a: string, b: string, on: boolean) => change(draftRef.current.logic, (on ? withRelation : withoutRelation)(draftRef.current.relations, a, b));

  /** Hangs block `id` under `parent`, or alone (null); the start never moves under another block. */
  const place = (id: string, parent: string | null) => {
    if (id === start && parent !== null) return;
    if (parent !== null && tree.nodes[id] && subtreeOf(tree, id).has(parent)) return;
    if (id === parent || (tree.nodes[id] && tree.nodes[id].parent === parent)) return;
    change(withPlacement(paper.blocks, draftRef.current.logic, id, parent));
  };

  /** Takes block `id` out of the graph; the blocks under it hang where it hung. */
  const remove = (id: string) => {
    if (id === start || !tree.nodes[id]) return;
    // Its lines go with it.
    change(
      withoutBlock(paper.blocks, draftRef.current.logic, id),
      draftRef.current.relations.filter(([a, b]) => a !== id && b !== id),
    );
    delete pins.current[id];
    writePins(paper.id, pins.current);
    if (selected === id) setSelected(null);
  };

  /** Opens the editor for a new block of `kind`; once saved, it hangs under `parent`, or stays alone at `at`. */
  const create = (kind: ResultBlockKind, parent: string | null, at: [number, number] | null) => {
    setAdding(null);
    setPicker(null);
    setQuery('');
    const id = newBlockId();
    asked.current = { id, parent, at };
    // In the paper, a branch's block goes next to the blocks already under its parent (branchEnd); a block alone, at the end.
    open({ kind: 'block', paperId: paper.id, blockKind: kind, afterBlockId: parent ? branchEnd(paper, tree, parent) : undefined, newId: id });
  };

  // The block asked for, once its save lands: into the graph, and chosen.
  useEffect(() => {
    const wish = asked.current;
    if (!wish || !paper.blocks.some((block) => block.id === wish.id)) return;
    asked.current = null;
    if (wish.at) {
      pins.current[wish.id] = wish.at;
      writePins(paper.id, pins.current);
    }
    change(withPlacement(paper.blocks, draftRef.current.logic, wish.id, wish.parent));
    setSelected(wish.id);
  }, [paper.blocks]);

  // The forces, and the nodes they move, kept across renders so every node keeps its place.
  const simulation = useRef<Simulation<GraphNode, GraphEdge> | null>(null);
  const nodes = useRef(new Map<string, GraphNode>());
  const frame = useRef(0);
  const animate = useCallback(() => {
    const forces = simulation.current;
    if (!forces || frame.current) return;
    const step = () => {
      forces.tick();
      setFrame((n) => n + 1);
      frame.current = forces.alpha() > forces.alphaMin() || forces.alphaTarget() > 0 ? requestAnimationFrame(step) : 0;
    };
    frame.current = requestAnimationFrame(step);
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      simulation.current?.stop();
    },
    [],
  );

  // The graph anew: nodes in and out (a new one next to the block it hangs under), the lines, then the forces settle.
  useEffect(() => {
    const forces =
      simulation.current ??
      forceSimulation<GraphNode>()
        .stop()
        .force('charge', forceManyBody<GraphNode>().strength(-520).distanceMax(900))
        .force(
          'collide',
          // Room for the label under each node, too.
          forceCollide<GraphNode>((node) => node.r + 38),
        )
        .force('x', forceX<GraphNode>(0).strength(0.03))
        .force('y', forceY<GraphNode>(0).strength(0.03))
        .force(
          'link',
          forceLink<GraphNode, GraphEdge>([])
            .id((node) => node.id)
            .distance(130)
            .strength(0.5),
        )
        // A drawn line pulls its blocks a little closer, not as hard as a branch.
        .force(
          'relations',
          forceLink<GraphNode, GraphEdge>([])
            .id((node) => node.id)
            .distance(170)
            .strength(0.06),
        );
    simulation.current = forces;
    const before = nodes.current;
    const next = new Map<string, GraphNode>();
    for (const id of graph.ids) {
      const parent = tree.nodes[id]?.parent;
      const anchor = parent ? (next.get(parent) ?? before.get(parent)) : undefined;
      const pin = pins.current[id];
      const node = before.get(id) ?? {
        id,
        r: 0,
        x: pin ? pin[0] : (anchor?.x ?? 0) + (Math.random() - 0.5) * 80,
        y: pin ? pin[1] : (anchor?.y ?? 0) + 50 + Math.random() * 40,
      };
      node.r = radiusOf(tree.nodes[id]?.children.length ?? 0, id === start);
      // The start holds the middle unless put elsewhere; nodes put by hand stay where they were put.
      const fixed = pin ?? (id === start ? [0, 0] : null);
      node.fx = fixed ? fixed[0] : null;
      node.fy = fixed ? fixed[1] : null;
      next.set(id, node);
    }
    nodes.current = next;
    forces.nodes([...next.values()]);
    (forces.force('link') as ForceLink<GraphNode, GraphEdge>).links(graph.links.map((line) => ({ ...line })));
    (forces.force('relations') as ForceLink<GraphNode, GraphEdge>).links(lines.map(([source, target]) => ({ source, target })));
    forces.alpha(before.size === 0 ? 1 : 0.6);
    // Settled at once (a tab in the background never animates), then gliding the rest of the way.
    for (let tick = 0; tick < (before.size === 0 ? 300 : 160); tick += 1) forces.tick();
    setFrame((n) => n + 1);
    animate();
  }, [graph, tree, start, lines, animate]);

  const placed: Placed[] = [...nodes.current.values()].map((node) => ({ id: node.id, x: node.x ?? 0, y: node.y ?? 0, r: node.r }));
  const placedRef = useRef(placed);
  placedRef.current = placed;

  // The start in the middle of the view the first time the canvas has a size (a large graph all in sight).
  const shown = useRef(false);
  useLayoutEffect(() => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!visible || shown.current || !rect || rect.width === 0) return;
    shown.current = true;
    setView(placedRef.current.length > 6 ? fitAll(placedRef.current, rect.width, rect.height) : { x: rect.width / 2, y: rect.height / 2.4, k: 1 });
  });

  const fitView = () => {
    const element = viewport.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setView(fitAll(placed, width, height));
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

  /** A point of the window in the graph's own units. */
  const toGraph = (clientX: number, clientY: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    const current = viewRef.current;
    return { x: (clientX - (rect?.left ?? 0) - current.x) / current.k, y: (clientY - (rect?.top ?? 0) - current.y) / current.k };
  };

  /** A free place in the middle of what is in sight (beside the panel, when one is open), for a block alone. */
  const middle = (): [number, number] => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return [0, 0];
    const room = selected && rect.width >= 640 ? rect.width - 400 : rect.width;
    const centre = toGraph(rect.left + room / 2, rect.top + rect.height / 2);
    // Clear of the nodes there and their labels: the middle, else the nearest such place around it, below first.
    const free = (x: number, y: number) => placed.every((node) => Math.abs(node.x - x) > 80 || Math.abs(node.y - y) > 50);
    for (let ring = 0; ring <= 6; ring += 1) {
      for (let step = 0; step < (ring === 0 ? 1 : 8); step += 1) {
        const angle = Math.PI / 2 + (step * Math.PI) / 4;
        const x = centre.x + Math.cos(angle) * ring * 60;
        const y = centre.y + Math.sin(angle) * ring * 60;
        if (free(x, y)) return [x, y];
      }
    }
    return [centre.x, centre.y];
  };

  /** A double click on an empty place of the canvas offers a new block there. */
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('[data-graph-node], [data-graph-line], button')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = toGraph(event.clientX, event.clientY);
    setSelected(null);
    setAdding({
      menu: { left: clamp(event.clientX - rect.left + 16, 8, rect.width - 152), top: clamp(event.clientY - rect.top - 12, 8, rect.height - 150) },
      at: [point.x, point.y],
    });
  };

  // A node in hand, or the canvas: the middle button drags the canvas anywhere, the left one where there is no node.
  const grab = useRef<
    | { kind: 'node'; id: string; pointer: number; x: number; y: number; moved: boolean; skip: Set<string> }
    | { kind: 'pan'; pointer: number; x: number; y: number; from: View; moved: boolean }
    | { kind: 'line'; from: string; pointer: number; x: number; y: number; moved: boolean }
    | null
  >(null);
  /** The blocks a line from `id` cannot go to: itself, those it already has one to, and those it hangs with. */
  const lineSkip = (id: string): Set<string> => new Set([id, ...relatedTo(lines, id), ...(tree.nodes[id]?.children ?? []), ...(tree.nodes[id]?.parent ? [tree.nodes[id].parent!] : [])]);
  const onHandleDown = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    try {
      viewport.current?.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows it over the canvas.
    }
    const node = nodes.current.get(id);
    grab.current = { kind: 'line', from: id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    setDrawing({ from: id, x: node?.x ?? 0, y: node?.y ?? 0 });
    setPickedLine(null);
  };
  const onNodeDown = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    try {
      viewport.current?.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows it over the canvas.
    }
    // It cannot go under itself or under the blocks under it.
    const skip = tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]);
    grab.current = { kind: 'node', id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, skip };
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1 && event.button !== 0) return;
    // The middle button would otherwise scroll the page (or paste, on Linux).
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // As above.
    }
    grab.current = { kind: 'pan', pointer: event.pointerId, x: event.clientX, y: event.clientY, from: viewRef.current, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const held = grab.current;
    if (!held || held.pointer !== event.pointerId) return;
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (!held.moved && Math.abs(dx) + Math.abs(dy) <= 4) return;
    held.moved = true;
    if (held.kind === 'pan') {
      setView({ ...held.from, x: held.from.x + dx, y: held.from.y + dy });
      return;
    }
    if (held.kind === 'line') {
      const at = toGraph(event.clientX, event.clientY);
      setDrawing({ from: held.from, x: at.x, y: at.y });
      setTarget(nodeAt(placed, at.x, at.y, lineSkip(held.from)));
      return;
    }
    const node = nodes.current.get(held.id);
    if (!node) return;
    const at = toGraph(event.clientX, event.clientY);
    // Held where the pointer is, drawn there at once, whether or not the forces have ticked.
    node.fx = node.x = at.x;
    node.fy = node.y = at.y;
    simulation.current?.alphaTarget(0.25);
    animate();
    setTarget(held.id === start ? null : nodeAt(placed, at.x, at.y, held.skip));
    setFrame((n) => n + 1);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const held = grab.current;
    if (!held || held.pointer !== event.pointerId) return;
    grab.current = null;
    if (held.kind === 'pan') {
      // A click on the canvas, not a drag of it, puts the node (or the line) in hand down.
      if (!held.moved && event.button === 0) {
        setSelected(null);
        setPickedLine(null);
      }
      return;
    }
    if (held.kind === 'line') {
      const at = toGraph(event.clientX, event.clientY);
      const to = held.moved ? nodeAt(placed, at.x, at.y, lineSkip(held.from)) : null;
      setDrawing(null);
      setTarget(null);
      if (to) relate(held.from, to, true);
      return;
    }
    simulation.current?.alphaTarget(0);
    const node = nodes.current.get(held.id);
    setTarget(null);
    if (!held.moved || !node) {
      setSelected(held.id);
      return;
    }
    const listRect = list.current?.getBoundingClientRect();
    const onList = !!listRect && listRect.width > 0 && event.clientX >= listRect.left && event.clientX <= listRect.right && event.clientY >= listRect.top && event.clientY <= listRect.bottom;
    if (onList) {
      remove(held.id);
      return;
    }
    const over = held.id === start ? null : nodeAt(placed, node.fx ?? 0, node.fy ?? 0, held.skip);
    if (over) {
      // Under its new block, where the forces put it.
      delete pins.current[held.id];
      node.fx = null;
      node.fy = null;
      writePins(paper.id, pins.current);
      place(held.id, over);
      return;
    }
    pins.current[held.id] = [node.fx ?? 0, node.fy ?? 0];
    writePins(paper.id, pins.current);
    setFrame((n) => n + 1);
    animate();
  };

  /** Lets every node the author put go, the start back to the middle, and lets the forces lay them out again. */
  const relayout = () => {
    pins.current = {};
    writePins(paper.id, {});
    for (const node of nodes.current.values()) {
      node.fx = node.id === start ? 0 : null;
      node.fy = node.id === start ? 0 : null;
    }
    const forces = simulation.current;
    if (!forces) return;
    forces.alpha(1);
    for (let tick = 0; tick < 200; tick += 1) forces.tick();
    setFrame((n) => n + 1);
    animate();
  };

  // Blocks dragged from the list: onto a node they hang under it; elsewhere on the canvas, alone where dropped.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pointerOf = (activator: Event, delta: { x: number; y: number }) => {
    const pointer = activator as PointerEvent;
    return { x: pointer.clientX + delta.x, y: pointer.clientY + delta.y };
  };
  const overCanvas = (x: number, y: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  /** Picks a block in the list: in the graph, it is chosen and brought into the middle. */
  const pick = (id: string) => {
    const node = nodes.current.get(id);
    const element = viewport.current;
    if (!node || !element) return;
    setSelected(id);
    setListOpen(false);
    const { width, height } = element.getBoundingClientRect();
    const room = width >= 640 ? width - 400 : width;
    setView((current) => ({ ...current, x: room / 2 - (node.x ?? 0) * current.k, y: height / 2 - (node.y ?? 0) * current.k }));
  };

  // The node under the pointer and what it is linked to, by a branch or a drawn line.
  const focus = hovered ?? target;
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const near = new Set([focus, ...(tree.nodes[focus]?.children ?? []), ...relatedTo(lines, focus)]);
    const parent = tree.nodes[focus]?.parent;
    if (parent) near.add(parent);
    return near;
  }, [focus, tree, lines]);
  // What the panel's picker offers: blocks not yet in the graph for a branch, blocks in it for a line.
  const wanted = query.trim().toLowerCase();
  const matches = (id: string) => !wanted || (labels[id]?.title ?? '').toLowerCase().includes(wanted);
  const choices =
    picker === 'line' && selected
      ? graph.ids.filter((id) => !lineSkip(selected).has(id) && matches(id)).flatMap((id) => (blocks[id] ? [blocks[id]] : []))
      : paper.blocks.filter((block) => !inGraph.has(block.id) && matches(block.id));
  const selectedBlock = selected ? blocks[selected] : undefined;
  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  const control = 'flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-gray-600 hover:bg-black/[0.05] hover:text-gray-900';
  const title = (id: string | null | undefined) => (id ? (labels[id]?.title ?? '') : '');
  const nodeCount = graph.ids.length;

  return (
    <div className={`fixed inset-x-0 bottom-0 z-20 flex flex-col bg-white ${visible ? '' : 'hidden'}`} style={{ top }}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.06] px-3">
        <button type="button" onClick={() => setListOpen((open) => !open)} aria-expanded={listOpen} className={`${bar} lg:hidden`}>
          <ListTree size={14} />
          {t('论文的块')}
        </button>
        <span className="hidden shrink-0 items-center gap-1.5 text-sm font-medium text-gray-800 lg:inline-flex">
          <Network size={15} className="text-violet-600" />
          {t('逻辑结构')}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs text-gray-400">
          {{ saved: t('已保存'), changed: t('有未保存的修改'), saving: t('保存中…'), failed: t('没有保存') }[status]}
        </span>
        <span className="hidden min-w-0 truncate text-xs text-gray-400 xl:block">{t('从左边把块拖到节点上，就添加一个分支；拖动节点调整位置，拖到另一个节点上就挂到它下面；从节点右上角的小圆点拖到另一个节点，就连一条关联线。')}</span>
        <span className="ml-auto flex items-center gap-1">
          <span ref={addButton} className="relative">
            <button
              type="button"
              onClick={() => setAdding(adding?.menu === 'bar' ? null : { menu: 'bar', at: middle() })}
              aria-haspopup="menu"
              aria-expanded={adding?.menu === 'bar'}
              title={t('新建一块；双击画布的空白处也可以')}
              className={bar}
            >
              <Plus size={14} />
              <span className="hidden sm:inline">{t('新建块')}</span>
            </button>
            {adding?.menu === 'bar' && (
              <KindMenu within={addButton} onPick={(kind) => create(kind, null, adding.at)} onClose={() => setAdding(null)} className="absolute right-0 top-full mt-1.5" />
            )}
          </span>
          {Object.keys(pins.current).length > 0 && (
            <button type="button" onClick={relayout} className={bar} title={t('重新排布')}>
              <RotateCcw size={14} />
              <span className="hidden sm:inline">{t('重新排布')}</span>
            </button>
          )}
          {tree.order.length > 0 && (
            <button
              type="button"
              className={bar}
              title={t('清空逻辑树')}
              onClick={() => {
                if (window.confirm(t('清空这棵逻辑树？论文本身不受影响。'))) change({}, []);
              }}
            >
              <Trash2 size={14} />
              <span className="hidden sm:inline">{t('清空')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onPresent(selected ?? start)}
            disabled={tree.order.length === 0}
            className="galley-press ml-1 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-violet-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-violet-800 disabled:opacity-40"
          >
            <Play size={14} />
            {t('演示')}
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
        autoScroll={false}
        onDragStart={({ active }) => setListDrag(String(active.id).replace(/^card:/, ''))}
        onDragMove={({ activatorEvent, delta }) => {
          const at = pointerOf(activatorEvent, delta);
          if (!overCanvas(at.x, at.y)) {
            setTarget(null);
            return;
          }
          const point = toGraph(at.x, at.y);
          setTarget(nodeAt(placed, point.x, point.y));
        }}
        onDragEnd={({ active, activatorEvent, delta }) => {
          const id = String(active.id).replace(/^card:/, '');
          const at = pointerOf(activatorEvent, delta);
          setListDrag(null);
          setTarget(null);
          if (!overCanvas(at.x, at.y) || id === start) return;
          const point = toGraph(at.x, at.y);
          const over = nodeAt(placed, point.x, point.y, tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]));
          if (over) {
            place(id, over);
            return;
          }
          // Alone, where it was dropped, until it is dragged onto a node.
          pins.current[id] = [point.x, point.y];
          writePins(paper.id, pins.current);
          const node = nodes.current.get(id);
          if (node) {
            node.fx = point.x;
            node.fy = point.y;
          }
          if (tree.nodes[id]) place(id, null);
          else change(withPlacement(paper.blocks, draftRef.current.logic, id, null));
        }}
        onDragCancel={() => {
          setListDrag(null);
          setTarget(null);
        }}
      >
        <div className="relative flex min-h-0 flex-1">
          {/* The paper's blocks, in its order; a node dropped back here leaves the graph. */}
          <div
            ref={list}
            className={`${listOpen ? 'absolute inset-y-0 left-0 z-30 flex shadow-xl' : 'hidden'} w-64 shrink-0 flex-col border-r border-black/[0.06] bg-[#f5f5f7] lg:static lg:flex lg:shadow-none`}
          >
            <p className="flex shrink-0 items-baseline gap-2 px-3 pb-1.5 pt-3 text-xs font-medium text-gray-500">
              {t('论文的块')}
              <span className="font-normal tabular-nums text-gray-400">{t('{n} / {m} 在图里', { n: nodeCount, m: paper.blocks.length })}</span>
              {listOpen && (
                <button type="button" onClick={() => setListOpen(false)} aria-label={t('关闭')} className="ml-auto rounded p-0.5 text-gray-400 hover:text-gray-700 lg:hidden">
                  <X size={14} />
                </button>
              )}
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {paper.blocks.length === 0 && <p className="py-6 text-center text-xs text-gray-400">{t('这篇论文还没有块：用上面的「新建块」，或者双击画布，添加第一块。')}</p>}
              {paper.blocks.map((block) => (
                <ListItem key={block.id} block={block} label={labels[block.id] ?? { title: block.id }} inGraph={inGraph.has(block.id)} selected={selected === block.id} onPick={pick} />
              ))}
            </div>
          </div>

          <div className="relative min-w-0 flex-1">
            <Canvas
              ref={viewport}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={onDoubleClick}
              onAuxClick={(event) => event.preventDefault()}
              className={`absolute inset-0 touch-none select-none overflow-hidden bg-[#fafafb] ${grab.current?.moved ? 'cursor-grabbing' : 'cursor-grab'}`}
              style={{
                backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.07) 1px, transparent 1.2px)',
                backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              }}
            >
              {nodeCount === 0 ? (
                <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500">{t('这篇论文还没有块：用上面的「新建块」，或者双击画布，添加第一块。')}</p>
              ) : (
                <svg className="absolute inset-0 h-full w-full overflow-visible" aria-label={t('逻辑结构')}>
                  <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                    {/* Lines drawn by hand: dashed, under the branches; a wide clear line takes the click. */}
                    {lines.map(([a, b]) => {
                      const from = nodes.current.get(a);
                      const to = nodes.current.get(b);
                      if (!from || !to) return null;
                      const lit = focus === a || focus === b;
                      const picked = pickedLine?.[0] === a && pickedLine[1] === b;
                      return (
                        <g key={`line-${a}-${b}`}>
                          <line
                            x1={from.x}
                            y1={from.y}
                            x2={to.x}
                            y2={to.y}
                            stroke={picked ? '#2563eb' : '#60a5fa'}
                            strokeWidth={(lit || picked ? 2 : 1.4) / Math.max(0.6, view.k)}
                            strokeDasharray={`${6 / Math.max(0.6, view.k)} ${5 / Math.max(0.6, view.k)}`}
                            opacity={neighbours && !lit ? 0.3 : 1}
                          />
                          <line
                            x1={from.x}
                            y1={from.y}
                            x2={to.x}
                            y2={to.y}
                            stroke="transparent"
                            strokeWidth={14 / view.k}
                            data-graph-line
                            className="cursor-pointer"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => setPickedLine([a, b])}
                          >
                            <title>{t('「{a}」和「{b}」的关联', { a: title(a), b: title(b) })}</title>
                          </line>
                        </g>
                      );
                    })}
                    {drawing && nodes.current.get(drawing.from) && (
                      <line
                        x1={nodes.current.get(drawing.from)?.x}
                        y1={nodes.current.get(drawing.from)?.y}
                        x2={drawing.x}
                        y2={drawing.y}
                        stroke="#2563eb"
                        strokeWidth={1.8 / Math.max(0.6, view.k)}
                        strokeDasharray={`${6 / Math.max(0.6, view.k)} ${5 / Math.max(0.6, view.k)}`}
                        className="pointer-events-none"
                      />
                    )}
                    {graph.links.map((line) => {
                      const from = nodes.current.get(line.source);
                      const to = nodes.current.get(line.target);
                      if (!from || !to) return null;
                      const lit = neighbours ? neighbours.has(line.source) && neighbours.has(line.target) : false;
                      return (
                        <line
                          key={`${line.source}-${line.target}`}
                          x1={from.x}
                          y1={from.y}
                          x2={to.x}
                          y2={to.y}
                          stroke={lit ? '#8b5cf6' : '#cfcfd6'}
                          strokeWidth={(lit ? 1.8 : 1.2) / Math.max(0.6, view.k)}
                          opacity={neighbours && !lit ? 0.35 : 1}
                        />
                      );
                    })}
                    {graph.ids.map((id) => {
                      const node = nodes.current.get(id);
                      if (!node) return null;
                      const block = blocks[id];
                      const isStart = id === start;
                      const float = block?.kind !== 'text';
                      const on = id === selected || id === target || id === hovered;
                      const dim = neighbours && !neighbours.has(id);
                      const alone = !isStart && !tree.nodes[id]?.parent && !(tree.nodes[id]?.children.length ?? 0);
                      const showLabel = view.k >= 0.55 || on || isStart;
                      return (
                        <g
                          key={id}
                          data-graph-node={id}
                          transform={`translate(${node.x ?? 0} ${node.y ?? 0})`}
                          role="button"
                          tabIndex={0}
                          aria-label={title(id)}
                          aria-pressed={id === selected}
                          onPointerDown={(event) => onNodeDown(event, id)}
                          onPointerEnter={() => setHovered(id)}
                          onPointerLeave={() => setHovered((current) => (current === id ? null : current))}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelected(id);
                            }
                          }}
                          className="cursor-pointer outline-none"
                          opacity={dim ? 0.3 : 1}
                        >
                          {id === target && <circle r={node.r + 9} fill="rgba(139,92,246,0.14)" stroke="#8b5cf6" strokeWidth={1.5} />}
                          {id === selected && <circle r={node.r + 5} fill="none" stroke="#7c3aed" strokeWidth={2} />}
                          <circle
                            r={node.r}
                            fill={isStart ? '#6d28d9' : float ? '#ffffff' : on ? '#8b5cf6' : '#9ca3af'}
                            stroke={isStart ? '#4c1d95' : float ? (on ? '#8b5cf6' : '#9ca3af') : 'none'}
                            strokeWidth={float ? 2 : 1.5}
                            strokeDasharray={alone ? '3 2' : undefined}
                          />
                          {showLabel && (
                            <text
                              y={node.r + 14}
                              textAnchor="middle"
                              className="pointer-events-none select-none"
                              fontSize={isStart ? 13 : 12}
                              fontWeight={isStart || on ? 600 : 400}
                              fill={isStart || on ? '#1f2937' : '#4b5563'}
                              stroke="#fafafb"
                              strokeWidth={3}
                              paintOrder="stroke"
                            >
                              {shortTitle(title(id))}
                            </text>
                          )}
                          {id === target && (
                            <text y={-node.r - 12} textAnchor="middle" className="pointer-events-none" fontSize={11} fill={drawing ? '#2563eb' : '#6d28d9'} fontWeight={600} stroke="#fafafb" strokeWidth={3} paintOrder="stroke">
                              {drawing ? t('连到「{name}」', { name: shortTitle(title(id)) }) : t('挂到「{name}」下面', { name: shortTitle(title(id)) })}
                            </text>
                          )}
                          {/* The dot a line is drawn from, on the node under the pointer or the one chosen. */}
                          {(id === hovered || id === selected) && !drawing && !(grab.current?.kind === 'node' && grab.current.moved) && (
                            <g
                              transform={`translate(${node.r * 0.75 + 5} ${-(node.r * 0.75 + 5)})`}
                              onPointerDown={(event) => onHandleDown(event, id)}
                              className="cursor-crosshair"
                            >
                              <title>{t('拖到另一个节点上，连一条关联线')}</title>
                              <circle r={6.5} fill="#ffffff" stroke="#2563eb" strokeWidth={1.5} />
                              <path d="M -3 0 H 3 M 0 -3 V 3" stroke="#2563eb" strokeWidth={1.5} strokeLinecap="round" />
                            </g>
                          )}
                        </g>
                      );
                    })}
                    {adding && (
                      <circle cx={adding.at[0]} cy={adding.at[1]} r={10} fill="rgba(139,92,246,0.12)" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="3 2" className="pointer-events-none" />
                    )}
                  </g>
                </svg>
              )}
              {tree.order.length === 0 && start && (
                <p className="pointer-events-none absolute inset-x-0 bottom-16 text-center text-sm text-gray-500">{t('从左边把块拖到「{name}」上，开始搭逻辑。', { name: title(start) })}</p>
              )}
              {/* A line clicked: what can be done with it, at its middle. */}
              {pickedLine &&
                (() => {
                  const from = nodes.current.get(pickedLine[0]);
                  const to = nodes.current.get(pickedLine[1]);
                  if (!from || !to || !related(lines, pickedLine[0], pickedLine[1])) return null;
                  const x = (((from.x ?? 0) + (to.x ?? 0)) / 2) * view.k + view.x;
                  const y = (((from.y ?? 0) + (to.y ?? 0)) / 2) * view.k + view.y;
                  return (
                    <button
                      type="button"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        relate(pickedLine[0], pickedLine[1], false);
                        setPickedLine(null);
                      }}
                      className="absolute z-10 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-white px-2.5 py-1 text-xs text-red-700 shadow-md ring-1 ring-black/[0.08] hover:bg-red-50"
                      style={{ left: x, top: y }}
                    >
                      <X size={12} />
                      {t('删除这条关联')}
                    </button>
                  );
                })()}
            </Canvas>
            {adding && adding.menu !== 'bar' && (
              <KindMenu onPick={(kind) => create(kind, null, adding.at)} onClose={() => setAdding(null)} className="absolute" style={{ left: adding.menu.left, top: adding.menu.top }} />
            )}

            {/* The zoom and what the lines mean, over the canvas. */}
            <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2">
              <div className="flex items-center rounded-lg bg-white/95 p-0.5 shadow-sm ring-1 ring-black/[0.06]">
                <button type="button" onClick={() => zoom(1 / 1.25)} aria-label={t('缩小')} title={t('缩小')} className={control}>
                  <Minus size={15} />
                </button>
                <span className="w-12 text-center text-xs tabular-nums text-gray-600">{Math.round(view.k * 100)}%</span>
                <button type="button" onClick={() => zoom(1.25)} aria-label={t('放大')} title={t('放大')} className={control}>
                  <Plus size={15} />
                </button>
                <button type="button" onClick={fitView} aria-label={t('显示全部')} title={t('显示全部')} className={control}>
                  <Scan size={15} />
                </button>
              </div>
              <div className="hidden items-center gap-3 rounded-lg bg-white/95 px-3 py-1.5 text-[11.5px] text-gray-500 shadow-sm ring-1 ring-black/[0.06] sm:flex">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-5 rounded bg-[#cfcfd6]" />
                  {t('分支')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-5 border-t-2 border-dashed border-[#60a5fa]" />
                  {t('关联')}
                </span>
              </div>
            </div>

            {/* The chosen node's block, as the block view shows it, and what can be done with it. */}
            {selected && selectedBlock && (
              <aside
                aria-label={title(selected)}
                className="absolute inset-x-3 bottom-3 z-10 flex max-h-[75%] flex-col overflow-hidden rounded-xl bg-white shadow-[0_16px_48px_-16px_rgba(0,0,0,0.35)] ring-1 ring-black/[0.06] sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[380px]"
              >
                <header className="flex items-start gap-2 border-b border-black/[0.06] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">{title(selected)}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {selected === start
                        ? t('逻辑从这里开始')
                        : tree.nodes[selected]?.parent
                          ? t('挂在「{name}」下面', { name: title(tree.nodes[selected].parent) })
                          : t('还没连到别的节点上')}
                    </p>
                  </div>
                  <button type="button" onClick={() => setSelected(null)} aria-label={t('关闭')} className="rounded p-1 text-gray-400 hover:bg-black/[0.05] hover:text-gray-700">
                    <X size={16} />
                  </button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <BlockWithTools paperId={paper.id} block={selectedBlock} />
                </div>
                <div className="space-y-3 border-t border-black/[0.06] px-4 py-3">
                  {picker ? (
                    <div className="space-y-1.5">
                      <label className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2 py-1.5 focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-100">
                        <Search size={13} className="text-gray-400" />
                        <input
                          autoFocus
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder={picker === 'line' ? t('找一块连到这里') : t('找一块挂到这里')}
                          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                        />
                        <button type="button" onClick={() => setPicker(null)} aria-label={t('关闭')} className="text-gray-400 hover:text-gray-700">
                          <X size={13} />
                        </button>
                      </label>
                      <div className="max-h-40 overflow-y-auto">
                        {choices.length === 0 && <p className="py-2 text-center text-xs text-gray-400">{picker === 'line' ? t('图里没有可以连的块了') : t('所有块都已经在图里了')}</p>}
                        {choices.map((block) => {
                          const Icon = KIND_ICON[block.kind];
                          return (
                            <button
                              key={block.id}
                              type="button"
                              onClick={() => {
                                if (picker === 'line') relate(selected, block.id, true);
                                else change(withPlacement(paper.blocks, draftRef.current.logic, block.id, selected));
                                setPicker(null);
                                setQuery('');
                              }}
                              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-gray-700 hover:bg-violet-50 hover:text-violet-800"
                            >
                              <Icon size={13} className="shrink-0 text-gray-400" />
                              <span className="truncate">{title(block.id)}</span>
                            </button>
                          );
                        })}
                      </div>
                      {picker === 'branch' && (
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-black/[0.06] pt-2 text-xs text-gray-500">
                          {t('或者新建一块挂在这里：')}
                          {KINDS.map((kind) => {
                            const Icon = KIND_ICON[kind];
                            return (
                              <button
                                key={kind}
                                type="button"
                                onClick={() => create(kind, selected, null)}
                                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12.5px] text-gray-700 ring-1 ring-black/[0.1] hover:bg-violet-50 hover:text-violet-800"
                              >
                                <Icon size={12} className={kind === 'text' ? 'text-gray-400' : 'text-violet-500'} aria-hidden="true" />
                                {t(KIND_NAME[kind])}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {selected !== start && (
                        <label className="block text-xs text-gray-500">
                          {t('挂在哪个节点下面')}
                          <select
                            value={tree.nodes[selected]?.parent ?? ''}
                            onChange={(event) => place(selected, event.target.value || null)}
                            className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[13px] text-gray-800 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
                          >
                            <option value="">{t('不连接')}</option>
                            {graph.ids
                              .filter((id) => id !== selected && !(tree.nodes[selected] && subtreeOf(tree, selected).has(id)))
                              .map((id) => (
                                <option key={id} value={id}>
                                  {title(id)}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {/* The lines drawn to this block, each one taken away by its ×. */}
                      <div className="text-xs text-gray-500">
                        <p>{t('关联')}</p>
                        {relatedTo(lines, selected).length === 0 ? (
                          <p className="mt-0.5 text-gray-400">{t('还没有关联线：从节点右上角的小圆点拖到另一个节点就能连上。')}</p>
                        ) : (
                          <ul className="mt-1 flex flex-wrap gap-1.5">
                            {relatedTo(lines, selected).map((other) => (
                              <li key={other} className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 py-0.5 pl-2.5 pr-1 text-blue-800">
                                <span className="truncate">{title(other)}</span>
                                <button type="button" onClick={() => relate(selected, other, false)} aria-label={t('删除这条关联')} title={t('删除这条关联')} className="rounded-full p-0.5 hover:bg-blue-100">
                                  <X size={11} />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {!picker && (
                      <button type="button" onClick={() => setPicker('branch')} className={`${bar} ring-1 ring-black/[0.08]`}>
                        <Plus size={14} />
                        {t('添加分支')}
                      </button>
                    )}
                    {!picker && (
                      <button type="button" onClick={() => setPicker('line')} className={`${bar} ring-1 ring-black/[0.08]`}>
                        <Link2 size={14} />
                        {t('添加关联')}
                      </button>
                    )}
                    {selected !== start && tree.nodes[selected] && (
                      <button type="button" onClick={() => remove(selected)} className={`${bar} ring-1 ring-black/[0.08]`}>
                        <Undo2 size={14} />
                        {t('从图里拿掉')}
                      </button>
                    )}
                    <button type="button" onClick={() => onPresent(selected)} className={`${bar} ring-1 ring-black/[0.08]`}>
                      <Play size={14} />
                      {t('从这里演示')}
                    </button>
                  </div>
                </div>
              </aside>
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {listDrag && labels[listDrag] ? (
            <div className="pointer-events-none flex max-w-[260px] items-center gap-1.5 rounded-xl border border-violet-400 bg-white px-3 py-2 text-[13px] font-medium text-gray-900 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35)]">
              <GripVertical size={13} className="shrink-0 text-violet-500" />
              <span className="truncate">{labels[listDrag].title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
};

export default LogicMode;
