import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AlignLeft, ChevronLeft, ChevronRight, CornerDownRight, GripVertical, Image, ListTree, Map as MapIcon, Network, Play, Plus, Table2, Trash2, Undo2, X } from 'lucide-react';
import { BlockWithTools } from '../../components/results/ResultPage';
import { describeSaveError } from '../../editor/backend';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import { resultsCommitMessage } from '../../editor/results/ops';
import { useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultBlock, ResultBlockKind, ResultPaper } from '../../types';
import { MiniMap } from '../Presentation';
import { LabelWords, NodeLabel, nodeLabels } from './labels';
import { changedLogic, logicOf, savedLogic, unsavedLogic } from './latest';
import { Logic, LogicTree, ancestorsOf, canMove, cleanLogic, logicTree, movesFrom, subtreeOf, withPlacement, withoutBlock } from './tree';

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

const KIND_ICON: Record<ResultBlockKind, typeof AlignLeft> = { text: AlignLeft, figure: Image, table: Table2 };

/**
 * What is dragged: a block of the list (`card:`) or of the page (`node:`). Where it lands: on a block (under it),
 * in the room after a block (`gap:`, beside it), below the branch (into it), on the box for a new branch beside
 * this one, or back on the list (out of the tree).
 */
const LIST = 'list';
const BRANCH = 'branch';
const INTO = 'into';
const cardId = (id: string) => `card:${id}`;
const nodeId = (id: string) => `node:${id}`;
const gapId = (id: string) => `gap:${id}`;
const blockOf = (dragged: string) => dragged.replace(/^(card|node|gap):/, '');

/** A block under the pointer first, then the room after one, then the larger places around them. */
const landing: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  for (const wanted of [(id: string) => id.startsWith('node:'), (id: string) => id.startsWith('gap:'), (id: string) => id === INTO || id === BRANCH, (id: string) => id === LIST]) {
    const hit = hits.find((candidate) => wanted(String(candidate.id)));
    if (hit) return [hit];
  }
  return [];
};

/**
 * The branch to show first: the first block of the first level with more than one (methods under one
 * Methodology, say), or the only block at the top.
 */
function firstBranch(tree: LogicTree): string | null {
  let level = tree.roots;
  while (level.length === 1 && tree.nodes[level[0]].children.length > 1) level = tree.nodes[level[0]].children;
  return level[0] ?? null;
}

/** The blocks on a level of the tree, across branches, as the tree is drawn. */
const levelOf = (tree: LogicTree, id: string): string[] => tree.order.filter((other) => tree.nodes[other].depth === tree.nodes[id].depth);

/** An area blocks are dropped on: the branch on screen, a new branch, or the list (out of the tree). */
const DropArea: React.FC<{ id: string; className: string; disabled?: boolean; children: (over: boolean) => React.ReactNode }> = ({ id, className, disabled = false, children }) => {
  const { setNodeRef, isOver } = useDroppable({ id, disabled });
  return (
    <div ref={setNodeRef} className={className}>
      {children(isOver)}
    </div>
  );
};

/** A block of the paper in the list, dragged from here into the logic. */
const ListItem: React.FC<{ block: ResultBlock; label: NodeLabel; inTree: boolean; current: boolean; onPick: (id: string) => void }> = ({ block, label, inTree, current, onPick }) => {
  const t = useT();
  const drag = useDraggable({ id: cardId(block.id) });
  const Icon = KIND_ICON[block.kind];
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      onClick={() => onPick(block.id)}
      title={inTree ? label.title : t('拖到中间的块上就挂到它下面，拖到页面底部就放进这一支')}
      className={`flex cursor-grab touch-pan-y select-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors duration-150 active:cursor-grabbing ${
        current ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-gray-700 hover:bg-black/[0.04]'
      } ${drag.isDragging ? 'opacity-40' : ''}`}
    >
      <GripVertical size={13} className="shrink-0 text-gray-300" aria-hidden="true" />
      <Icon size={13} className={`shrink-0 ${block.kind === 'text' ? 'text-gray-400' : 'text-violet-500'}`} aria-hidden="true" />
      <span className="min-w-0 truncate">{label.title}</span>
      {inTree && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" title={t('在树里')} />}
    </div>
  );
};

/** The room after a block and what is under it: a block dropped here goes beside it, under the same block. */
const Gap: React.FC<{ after: string; parentLabel: string; disabled: boolean }> = ({ after, parentLabel, disabled }) => {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: gapId(after), disabled });
  return (
    <div ref={setNodeRef} className="relative h-7">
      {isOver && !disabled && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 -translate-y-1/2">
          <div className="h-0.5 rounded bg-violet-500" />
          <span className="absolute left-0 top-1.5 whitespace-nowrap rounded-md bg-violet-700 px-2 py-0.5 text-[11px] text-white">{t('放到「{name}」下面', { name: parentLabel })}</span>
        </div>
      )}
    </div>
  );
};

interface NodeProps {
  paperId: string;
  id: string;
  tree: LogicTree;
  blocks: Record<string, ResultBlock>;
  labels: Record<string, NodeLabel>;
  /** While a block is dragged: it and the blocks under it, which it cannot go under. */
  blocked: Set<string> | null;
  dragging: string | null;
  depth: number;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
}

/** A block of the branch, as the block view shows it, with the blocks under it indented below it. */
const Node: React.FC<NodeProps> = (props) => {
  const { paperId, id, tree, blocks, labels, blocked, dragging, depth, onFocus, onRemove } = props;
  const t = useT();
  const drag = useDraggable({ id: nodeId(id) });
  const drop = useDroppable({ id: nodeId(id), disabled: !!blocked?.has(id) });
  const block = blocks[id];
  const children = tree.nodes[id]?.children ?? [];
  const target = drop.isOver && !blocked?.has(id);
  if (!block) return null;
  return (
    <div className={depth > 0 ? 'ml-2 border-l-2 border-violet-100 pl-5 sm:ml-3 sm:pl-7' : ''}>
      <div
        ref={drop.setNodeRef}
        data-logic-block-id={id}
        className={`relative scroll-mt-24 rounded-xl transition-[background-color,box-shadow,opacity] duration-150 ${
          target ? 'bg-violet-50 shadow-[0_0_0_2px_rgba(124,58,237,0.6)]' : ''
        } ${dragging === id ? 'opacity-30' : blocked?.has(id) ? 'opacity-50' : ''}`}
      >
        <div ref={drag.setNodeRef}>
          <button
            ref={drag.setActivatorNodeRef}
            type="button"
            {...drag.attributes}
            {...drag.listeners}
            title={t('拖到另一块上，挂到它下面；拖回左边，从树里拿掉')}
            aria-label={t('拖动这一块')}
            className="absolute -left-7 top-6 z-20 cursor-grab touch-none rounded-md p-0.5 text-gray-400 hover:bg-violet-50 hover:text-violet-600 active:cursor-grabbing"
          >
            <GripVertical size={18} />
          </button>
          <BlockWithTools
            paperId={paperId}
            block={block}
            tools={
              <>
                {depth > 0 && children.length > 0 && (
                  <button type="button" onClick={() => onFocus(id)} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-violet-700 hover:bg-violet-50">
                    <CornerDownRight size={12} />
                    {t('只看这一支')}
                  </button>
                )}
                <button type="button" onClick={() => onRemove(id)} title={t('从树里拿掉，下面的块上移一层')} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-black/[0.04] hover:text-gray-600">
                  <Undo2 size={12} />
                  {t('拿出树')}
                </button>
              </>
            }
          />
        </div>
        {target && <span className="pointer-events-none absolute -top-3 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md bg-violet-700 px-2 py-0.5 text-[11px] text-white">{t('放到「{name}」下面', { name: labels[id]?.title ?? '' })}</span>}
      </div>
      {children.length > 0 && (
        <div className="mt-7">
          {children.map((child) => (
            <React.Fragment key={child}>
              <Node {...props} id={child} depth={depth + 1} />
              {/* Dropped after this block and what is under it, a block goes beside it. */}
              <div className="ml-2 border-l-2 border-violet-100 pl-5 sm:ml-3 sm:pl-7">
                <Gap after={child} parentLabel={labels[id]?.title ?? ''} disabled={!!blocked?.has(id)} />
              </div>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The paper's logic, read and built like the block view: one branch at a time (a block and every block under it,
 * indented below it), with buttons at the sides of the screen for the branches beside it, a block like a method
 * with its experiments. A block dragged onto another goes under it; onto the dashed box, it starts a branch;
 * back onto the list, it leaves the tree. Only the logic changes, never the paper's order. Saved a moment after
 * each change.
 */
const LogicMode: React.FC<Props> = ({ paper, onSave, top, visible, onPresent }) => {
  const t = useT();
  const [logic, setLogic] = useState<Logic>(() => logicOf(paper));
  // Logic changed here whose save had not landed when the view opened (or failed) is saved again.
  const [status, setStatus] = useState<Status>(() => (unsavedLogic(paper.id) ? 'changed' : 'saved'));
  const [problem, setProblem] = useMessage();
  const [focus, setFocus] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [map, setMap] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
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
  const blocks = useMemo(() => Object.fromEntries(paper.blocks.map((block) => [block.id, block])), [paper.blocks]);
  const blocked = useMemo(() => {
    if (!dragging) return null;
    return tree.nodes[dragging] ? subtreeOf(tree, dragging) : new Set([dragging]);
  }, [dragging, tree]);
  // The branch on screen: the one chosen, while it is in the tree, else the first.
  const shown = focus && tree.nodes[focus] ? focus : firstBranch(tree);
  const inShown = useMemo(() => (shown ? subtreeOf(tree, shown) : new Set<string>()), [tree, shown]);
  const level = shown ? levelOf(tree, shown) : [];
  const moves = shown ? movesFrom(tree, shown) : null;

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
    // The branch on screen stays on screen, whatever the change does to which branch would come first.
    if (!focus && shown) setFocus(shown);
    logicRef.current = next;
    unsaved.current = true;
    changedLogic(paper.id, next);
    setLogic(next);
    setStatus('changed');
    setProblem(null);
  };

  /** Shows a branch, from its top. */
  const goTo = useCallback((id: string | null) => {
    if (!id) return;
    setFocus(id);
    scroller.current?.scrollTo({ top: 0 });
  }, []);

  /** Puts block `id` (from the list or the page) under `target`, or at the top (null). */
  const place = (id: string, target: string | null) => {
    if (target !== null && !canMove(tree, id, target)) return;
    if (tree.nodes[id] && tree.nodes[id].parent === target) return;
    change(withPlacement(paper.blocks, logicRef.current, id, target));
  };

  /** Makes block `id` a branch beside the one on screen (at the top when there is none yet), and shows it. */
  const startBranch = (id: string) => {
    const parent = shown ? tree.nodes[shown].parent : null;
    if (parent !== null && !canMove(tree, id, parent)) return;
    place(id, parent);
    goTo(id);
  };

  /** Takes block `id` out of the tree; the blocks under it go up to where it was. */
  const remove = (id: string) => {
    if (!tree.nodes[id]) return;
    change(withoutBlock(paper.blocks, logicRef.current, id));
  };

  // ← and → go to the branches beside this one, as the buttons at the sides do, when no field has the keys.
  const keys = useRef({ moves, goTo });
  keys.current = { moves, goTo };
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (typing || event.altKey || event.metaKey || event.ctrlKey || document.querySelector('[aria-modal="true"]')) return;
      const to = event.key === 'ArrowLeft' ? keys.current.moves?.left : event.key === 'ArrowRight' ? keys.current.moves?.right : undefined;
      if (to === undefined) return;
      event.preventDefault();
      keys.current.goTo(to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  /** A block chosen in the list: the branch it is in on this level, scrolled to it. */
  const pick = (id: string) => {
    if (!tree.nodes[id]) return;
    const depth = shown ? tree.nodes[shown].depth : 0;
    const path = [...ancestorsOf(tree, id), id];
    goTo(path[Math.min(depth, path.length - 1)]);
    setListOpen(false);
    window.setTimeout(() => document.querySelector(`[data-logic-block-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  // At the sides, halfway down; on a phone, in the lower corners, out of the text's way.
  const side =
    'absolute bottom-4 z-20 rounded-full bg-white p-2.5 text-gray-700 shadow-[0_6px_20px_-8px_rgba(0,0,0,0.35)] ring-1 ring-black/[0.06] transition-colors duration-150 hover:text-violet-700 disabled:pointer-events-none disabled:opacity-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:p-3';
  const title = (id: string | null | undefined) => (id ? (labels[id]?.title ?? '') : '');
  const inTreeCount = tree.order.length;

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
        <span className="hidden min-w-0 truncate text-xs text-gray-400 xl:block">{t('拖动块左边的把手：拖到一块上就挂到它下面，拖到块与块之间就和它们同一层，拖回左边就从树里拿掉。')}</span>
        <span className="ml-auto flex items-center gap-1">
          {inTreeCount > 0 && (
            <button type="button" onClick={() => setMap((on) => !on)} aria-pressed={map} title={t('地图')} className={`${bar} ${map ? 'text-violet-700' : ''}`}>
              <MapIcon size={14} />
              <span className="hidden sm:inline">{t('地图')}</span>
            </button>
          )}
          {inTreeCount > 0 && (
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
            onClick={() => onPresent(shown)}
            disabled={inTreeCount === 0}
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
        collisionDetection={landing}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={({ active }) => setDragging(blockOf(String(active.id)))}
        onDragEnd={({ active, over }) => {
          setDragging(null);
          const id = blockOf(String(active.id));
          const where = over ? String(over.id) : null;
          if (where === LIST) remove(id);
          else if (where === BRANCH) startBranch(id);
          else if (where === INTO && shown) place(id, shown);
          else if (where?.startsWith('gap:')) place(id, tree.nodes[blockOf(where)]?.parent ?? null);
          else if (where?.startsWith('node:')) place(id, blockOf(where));
        }}
        onDragCancel={() => setDragging(null)}
      >
        <div className="relative flex min-h-0 flex-1">
          {/* The paper's blocks, in its order; a block taken out of the tree comes back here. */}
          <DropArea
            id={LIST}
            className={`${listOpen ? 'absolute inset-y-0 left-0 z-30 flex shadow-xl' : 'hidden'} w-64 shrink-0 flex-col border-r border-black/[0.06] bg-[#f5f5f7] lg:static lg:flex lg:shadow-none`}
          >
            {(over) => (
              <>
                <p className="flex shrink-0 items-baseline gap-2 px-3 pb-1.5 pt-3 text-xs font-medium text-gray-500">
                  {t('论文的块')}
                  <span className="font-normal tabular-nums text-gray-400">{t('{n} / {m} 在树里', { n: inTreeCount, m: paper.blocks.length })}</span>
                  {listOpen && (
                    <button type="button" onClick={() => setListOpen(false)} aria-label={t('关闭')} className="ml-auto rounded p-0.5 text-gray-400 hover:text-gray-700 lg:hidden">
                      <X size={14} />
                    </button>
                  )}
                </p>
                <div className={`min-h-0 flex-1 overflow-y-auto px-2 pb-3 transition-colors duration-150 ${over && dragging && tree.nodes[dragging] ? 'bg-violet-50/70' : ''}`}>
                  {over && dragging && tree.nodes[dragging] && (
                    <p className="sticky top-0 z-10 mb-1 rounded-lg border border-dashed border-violet-300 bg-violet-50 py-3 text-center text-xs text-violet-700">{t('放开，从树里拿掉')}</p>
                  )}
                  {paper.blocks.length === 0 && <p className="py-6 text-center text-xs text-gray-400">{t('这篇论文还没有块。先在「分块」里添加文字、图或表格。')}</p>}
                  {paper.blocks.map((block) => (
                    <ListItem
                      key={block.id}
                      block={block}
                      label={labels[block.id] ?? { title: block.id }}
                      inTree={!!tree.nodes[block.id]}
                      current={inShown.has(block.id)}
                      onPick={pick}
                    />
                  ))}
                </div>
              </>
            )}
          </DropArea>

          <div className="relative min-w-0 flex-1">
            <div ref={scroller} className="absolute inset-0 overflow-y-auto">
              <div className="mx-auto max-w-[58rem] px-10 pb-24 pt-6 sm:px-16">
                {shown ? (
                  <>
                    {/* Where this branch is: the blocks above it, and which of the branches beside it. */}
                    <nav aria-label={t('位置')} className="mb-6 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-gray-500">
                      {ancestorsOf(tree, shown).map((id) => (
                        <React.Fragment key={id}>
                          <button type="button" onClick={() => goTo(id)} className="max-w-[16rem] truncate rounded px-1 hover:bg-black/[0.04] hover:text-gray-900">
                            {title(id)}
                          </button>
                          <ChevronRight size={14} className="shrink-0 text-gray-400" aria-hidden="true" />
                        </React.Fragment>
                      ))}
                      <span className="truncate px-1 font-medium text-gray-900">{title(shown)}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-xs text-gray-400">{t('分支 {i} / {n}', { i: level.indexOf(shown) + 1, n: level.length })}</span>
                    </nav>
                    <div className="space-y-8">
                      <Node paperId={paper.id} id={shown} tree={tree} blocks={blocks} labels={labels} blocked={blocked} dragging={dragging} depth={0} onFocus={goTo} onRemove={remove} />
                    </div>
                    {/* Below the branch, a block goes into it: under its first block, beside the others. */}
                    <DropArea id={INTO} className="mt-6" disabled={!!blocked?.has(shown)}>
                      {(over) => (
                        <div
                          className={`flex items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-sm transition-colors duration-150 ${
                            over ? 'border-violet-400 bg-violet-50 text-violet-700' : 'border-black/[0.08] text-gray-400'
                          }`}
                        >
                          <CornerDownRight size={16} />
                          {t('拖到这里，放进「{name}」这一支', { name: title(shown) })}
                        </div>
                      )}
                    </DropArea>
                  </>
                ) : (
                  // With no tree yet, the first block dropped starts it.
                  <DropArea id={BRANCH} className="pt-6">
                    {(over) => (
                      <div className={`rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors duration-150 ${over ? 'border-violet-400 bg-violet-50' : 'border-black/[0.08]'}`}>
                        <Network size={28} className="mx-auto text-violet-400" />
                        <p className="mt-3 text-[15px] font-medium text-gray-800">{t('把左边的块拖到这里，开始第一个分支')}</p>
                        <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">{t('先放一个方法，再把实验拖到这个方法上，就挂在它下面。')}</p>
                      </div>
                    )}
                  </DropArea>
                )}
              </div>
            </div>

            {/* While a block is dragged, a box for a branch of its own beside this one, over the top of the page. */}
            {dragging && shown && (
              <DropArea id={BRANCH} className="absolute inset-x-0 top-3 z-30 mx-auto w-fit max-w-[90%]">
                {(over) => (
                  <div
                    className={`flex items-center gap-2 rounded-xl border-2 border-dashed px-4 py-2.5 text-sm shadow-sm transition-colors duration-150 ${
                      over ? 'border-violet-400 bg-violet-50 text-violet-700' : 'border-violet-200 bg-white/95 text-gray-500'
                    }`}
                  >
                    <Plus size={15} className="shrink-0" />
                    {t('拖到这里，新建一个分支')}
                    <span className="truncate text-xs text-gray-400">{t('和「{name}」同一层', { name: title(shown) })}</span>
                  </div>
                )}
              </DropArea>
            )}

            {/* The branches beside this one. */}
            <button type="button" onClick={() => goTo(moves?.left ?? null)} disabled={!moves?.left} aria-label={t('左边：{name}', { name: title(moves?.left) })} title={t('左边：{name}', { name: title(moves?.left) })} className={`${side} left-3`}>
              <ChevronLeft size={22} />
            </button>
            <button type="button" onClick={() => goTo(moves?.right ?? null)} disabled={!moves?.right} aria-label={t('右边：{name}', { name: title(moves?.right) })} title={t('右边：{name}', { name: title(moves?.right) })} className={`${side} right-3`}>
              <ChevronRight size={22} />
            </button>

            {map && shown && inTreeCount > 1 && (
              <div className="pointer-events-none absolute bottom-3 right-3 z-20 hidden md:block">
                <MiniMap tree={tree} current={shown} labels={labels} onGo={(id) => pick(id)} />
              </div>
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && labels[dragging] ? (
            <div className="pointer-events-none flex max-w-[260px] items-center gap-1.5 rounded-xl border border-violet-400 bg-white px-3 py-2 text-[13px] font-medium text-gray-900 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35)]">
              <GripVertical size={13} className="shrink-0 text-violet-500" />
              <span className="truncate">{labels[dragging].title}</span>
              {tree.nodes[dragging] && subtreeOf(tree, dragging).size > 1 && (
                <span className="shrink-0 text-xs font-normal text-gray-500">{t('连同下面 {n} 块', { n: subtreeOf(tree, dragging).size - 1 })}</span>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
};

export default LogicMode;
