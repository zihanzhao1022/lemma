import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core';
import { AlignLeft, GripVertical, Image, Link2, ListTree, Network, Play, Plus, RotateCcw, Search, Table2, Trash2, Undo2, X } from 'lucide-react';
import { useEditMode } from '../../components/EditMode';
import { BlockWithTools } from '../../components/results/ResultPage';
import { describeSaveError } from '../../editor/backend';
import { newBlockId } from '../../editor/results/actions';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import { resultsCommitMessage } from '../../editor/results/ops';
import { N_, useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultBlock, ResultBlockKind, ResultPaper } from '../../types';
import FloatingMenu, { MenuChoice } from './FloatingMenu';
import ForceGraph, { ForceGraphHandle, NodeLook } from './ForceGraph';
import { Relation, cleanRelations, graphOf, relatedTo, startOf, withRelation, withoutRelation } from './graph';
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

const KIND_ICON: Record<ResultBlockKind, typeof AlignLeft> = { text: AlignLeft, figure: Image, table: Table2 };
const KINDS: ResultBlockKind[] = ['text', 'figure', 'table'];
const KIND_NAME: Record<ResultBlockKind, string> = { text: N_('文字'), figure: N_('图'), table: N_('表格') };
/** Room the panel of the chosen block takes on the right of a wide canvas. */
const PANEL = 400;

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

/**
 * The paper's logic as a graph, like Obsidian's (ForceGraph): blocks as nodes, a line from each block to the blocks
 * that hang under it, starting from the introduction. Blocks dragged from the list onto a node become branches of
 * it; a node dragged onto another goes under it, anywhere else it stays where it is put. Only the logic changes,
 * never the paper's order; where nodes were put stays in this browser.
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
  const [listDrag, setListDrag] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  // Whether any node is put by hand, for the button that lets them go.
  const [pinned, setPinned] = useState(false);
  // What the panel's picker adds to the chosen block: a branch under it, or a line to it.
  const [picker, setPicker] = useState<'branch' | 'line' | null>(null);
  const [query, setQuery] = useState('');
  // The kinds a new block can be, offered under the bar's button or where the canvas was double-clicked; the
  // block shows at `at` once saved.
  const [adding, setAdding] = useState<{ menu: 'bar' | { left: number; top: number }; at: [number, number] } | null>(null);
  const addButton = useRef<HTMLSpanElement>(null);
  // A block asked for here: once its save lands it goes into the graph, under `parent` or alone at `at`.
  const asked = useRef<{ id: string; parent: string | null; at: [number, number] | null } | null>(null);
  const { open } = useEditMode();
  const graphView = useRef<ForceGraphHandle>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
    // A line drawn between the two goes: a branch joins them now.
    const relations = parent ? withoutRelation(draftRef.current.relations, id, parent) : draftRef.current.relations;
    change(withPlacement(paper.blocks, draftRef.current.logic, id, parent), relations);
  };

  /** Takes block `id` out of the graph; the blocks under it hang where it hung. */
  const remove = (id: string) => {
    if (id === start || !tree.nodes[id]) return;
    // Its lines go with it.
    change(
      withoutBlock(paper.blocks, draftRef.current.logic, id),
      draftRef.current.relations.filter(([a, b]) => a !== id && b !== id),
    );
    graphView.current?.unpin(id);
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
    if (wish.at) graphView.current?.pin(wish.id, wish.at);
    change(withPlacement(paper.blocks, draftRef.current.logic, wish.id, wish.parent));
    setSelected(wish.id);
  }, [paper.blocks]);

  /** The blocks a line from `id` cannot go to: itself, those it already has one to, and those it hangs with. */
  const lineSkip = (id: string): Set<string> => new Set([id, ...relatedTo(lines, id), ...(tree.nodes[id]?.children ?? []), ...(tree.nodes[id]?.parent ? [tree.nodes[id].parent!] : [])]);
  /** What a block cannot go under: itself and the blocks under it; the start goes under nothing. */
  const branchOf = (id: string): ReadonlySet<string> | null => (id === start ? null : tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]));
  const look = (id: string, on: boolean): NodeLook => {
    if (id === start) return { fill: '#6d28d9', stroke: '#4c1d95', strokeWidth: 1.5, strong: true };
    if (blocks[id]?.kind !== 'text') return { fill: '#ffffff', stroke: on ? '#8b5cf6' : '#9ca3af', strokeWidth: 2 };
    return { fill: on ? '#8b5cf6' : '#9ca3af', stroke: 'none', strokeWidth: 1.5 };
  };

  // Blocks dragged from the list: onto a node they hang under it; elsewhere on the canvas, alone where dropped.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pointerOf = (activator: Event, delta: { x: number; y: number }) => {
    const pointer = activator as PointerEvent;
    return { x: pointer.clientX + delta.x, y: pointer.clientY + delta.y };
  };

  /** Picks a block in the list: in the graph, it is chosen and brought into the middle. */
  const pick = (id: string) => {
    if (!inGraph.has(id)) return;
    setSelected(id);
    setListOpen(false);
    graphView.current?.focus(id);
  };

  // What the panel's picker offers: blocks not yet in the graph for a branch, blocks in it for a line.
  const wanted = query.trim().toLowerCase();
  const matches = (id: string) => !wanted || (labels[id]?.title ?? '').toLowerCase().includes(wanted);
  const choices =
    picker === 'line' && selected
      ? graph.ids.filter((id) => !lineSkip(selected).has(id) && matches(id)).flatMap((id) => (blocks[id] ? [blocks[id]] : []))
      : paper.blocks.filter((block) => !inGraph.has(block.id) && matches(block.id));
  const selectedBlock = selected ? blocks[selected] : undefined;
  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  const title = (id: string | null | undefined) => (id ? (labels[id]?.title ?? '') : '');
  const nodeCount = graph.ids.length;
  const kindChoices = (at: [number, number] | null, parent: string | null): MenuChoice[] =>
    KINDS.map((kind) => ({ key: kind, icon: KIND_ICON[kind], tone: kind === 'text' ? 'text-gray-400' : 'text-violet-500', text: t(KIND_NAME[kind]), onPick: () => create(kind, parent, at) }));

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
              onClick={() => setAdding(adding?.menu === 'bar' ? null : { menu: 'bar', at: graphView.current?.freeSpot() ?? [0, 0] })}
              aria-haspopup="menu"
              aria-expanded={adding?.menu === 'bar'}
              title={t('新建一块；双击画布的空白处也可以')}
              className={bar}
            >
              <Plus size={14} />
              <span className="hidden sm:inline">{t('新建块')}</span>
            </button>
            {adding?.menu === 'bar' && (
              <FloatingMenu title={t('新建一块')} choices={kindChoices(adding.at, null)} within={addButton} onClose={() => setAdding(null)} className="absolute right-0 top-full mt-1.5" />
            )}
          </span>
          {pinned && (
            <button type="button" onClick={() => graphView.current?.relayout()} className={bar} title={t('重新排布')}>
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
          graphView.current?.aim(graphView.current.nodeAt(at.x, at.y));
        }}
        onDragEnd={({ active, activatorEvent, delta }) => {
          const id = String(active.id).replace(/^card:/, '');
          const at = pointerOf(activatorEvent, delta);
          const view = graphView.current;
          setListDrag(null);
          view?.aim(null);
          const point = view?.pointAt(at.x, at.y);
          if (!view || !point || id === start) return;
          const over = view.nodeAt(at.x, at.y, tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]));
          if (over) {
            place(id, over);
            return;
          }
          // Alone, where it was dropped, until it is dragged onto a node.
          view.pin(id, point);
          if (tree.nodes[id]) place(id, null);
          else change(withPlacement(paper.blocks, draftRef.current.logic, id, null));
        }}
        onDragCancel={() => {
          setListDrag(null);
          graphView.current?.aim(null);
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

          <ForceGraph
            ref={graphView}
            className="min-w-0 flex-1"
            ids={graph.ids}
            links={graph.links}
            lines={lines}
            center={start}
            pinKey={`lemma-graph:${paper.id}`}
            label={title}
            look={look}
            selected={selected}
            onSelect={setSelected}
            branchOf={branchOf}
            onPlace={place}
            lineSkip={lineSkip}
            onRelate={relate}
            onDropOutside={(id, x, y) => {
              const rect = list.current?.getBoundingClientRect();
              if (!rect || rect.width === 0 || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
              remove(id);
              return true;
            }}
            onEmptyDoubleClick={(at, menu) => {
              setSelected(null);
              setAdding({ menu, at });
            }}
            ghost={adding?.at ?? null}
            visible={visible}
            aside={PANEL}
            title={t('逻辑结构')}
            onPinned={setPinned}
            empty={<p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500">{t('这篇论文还没有块：用上面的「新建块」，或者双击画布，添加第一块。')}</p>}
            hint={
              tree.order.length === 0 && start ? (
                <p className="pointer-events-none absolute inset-x-0 bottom-16 text-center text-sm text-gray-500">{t('从左边把块拖到「{name}」上，开始搭逻辑。', { name: title(start) })}</p>
              ) : null
            }
          >
            {adding && adding.menu !== 'bar' && (
              <FloatingMenu title={t('新建一块')} choices={kindChoices(adding.at, null)} onClose={() => setAdding(null)} className="absolute" style={{ left: adding.menu.left, top: adding.menu.top }} />
            )}

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
                  <BlockWithTools paperId={paper.id} block={selectedBlock} published={!paper.hidden} />
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
          </ForceGraph>
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
