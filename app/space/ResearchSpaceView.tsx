import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, FileText, GripVertical, Lightbulb, Link2, ListTree, Maximize2, Minimize2, Plus, RotateCcw, Search, Trash2, Undo2, X } from 'lucide-react';
import BlockView from '../../components/results/BlockView';
import { ResultsAccess, ResultsAccessContext } from '../../components/results/access';
import { describeSaveError } from '../../editor/backend';
import { useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResearchSpace, ResultPaper } from '../../types';
import { PAPERS_TYPE } from '../dragging';
import ForceGraph, { ForceGraphHandle, NodeLook } from '../logic/ForceGraph';
import { graphOf, relatedTo } from '../logic/graph';
import { LabelWords, NodeLabel, nodeLabels } from '../logic/labels';
import { subtreeOf } from '../logic/tree';
import { Organizer } from '../organizer';
import NodePicker, { KIND_ICON } from './NodePicker';
import SpaceLibrary from './SpaceLibrary';
import { blockOfNode, cleanSpace, isIdea, linesOf, spaceNodes, spaceTree, withIdea, withIdeaText, withLine, withNode, withoutNode } from './space';

interface Props {
  login: string;
  /** The account's own papers, in their order. */
  papers: ResultPaper[];
  /** How their files are read, for the blocks shown in the panel. */
  access: ResultsAccess;
  /** Their folders, for the list beside the full-screen space. */
  organizer: Organizer;
  /** The space as stored; null while it is read. */
  space: ResearchSpace | null;
  onSave: (space: ResearchSpace, message: string) => Promise<void>;
}

type Status = 'saved' | 'changed' | 'saving' | 'failed';

/** Room the panel of the chosen node takes on the right of a wide canvas. */
const PANEL = 340;
const MENU_SIZE = { width: 296, height: 370 };

/** How each kind of node looks, `on` when chosen or under the pointer. */
const LOOK = {
  paper: (on: boolean): NodeLook => ({ fill: on ? '#6d28d9' : '#8b5cf6', stroke: 'none', strokeWidth: 1.5 }),
  text: (on: boolean): NodeLook => ({ fill: on ? '#8b5cf6' : '#9ca3af', stroke: 'none', strokeWidth: 1.5 }),
  float: (on: boolean): NodeLook => ({ fill: '#ffffff', stroke: on ? '#8b5cf6' : '#9ca3af', strokeWidth: 2 }),
  idea: (on: boolean): NodeLook => ({ fill: '#ffffff', stroke: on ? '#7c3aed' : '#a1a1aa', strokeWidth: 2, square: true }),
};

const foldKey = (login: string) => `lemma-space-folded:${login.toLowerCase()}`;
function readFolded(login: string): boolean {
  try {
    return localStorage.getItem(foldKey(login)) === '1';
  } catch {
    return false;
  }
}

/**
 * The person's research space, over their list of papers: their papers, blocks of them (text, figures, tables) and
 * ideas (questions, directions, notes) as a graph like a paper's logic (ForceGraph), to think a subject through
 * across papers. Papers come from the list below by dragging; papers and blocks from the Add picker; ideas are
 * written here. The space is kept in their repository (research-space.json); where nodes were put stays in this
 * browser.
 */
const ResearchSpaceView: React.FC<Props> = ({ login, papers, access, organizer, space, onSave }) => {
  const t = useT();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ResearchSpace | null>(space);
  const [status, setStatus] = useState<Status>('saved');
  const [problem, setProblem] = useMessage();
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  // What the panel's picker adds to the chosen node: a branch under it, or a line to it.
  const [picker, setPicker] = useState<'branch' | 'line' | null>(null);
  const [query, setQuery] = useState('');
  // The picker of what to add, under the bar's button or where the canvas was double-clicked; it shows at `at`.
  const [adding, setAdding] = useState<{ menu: 'bar' | { left: number; top: number }; at: [number, number] } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [folded, setFolded] = useState(() => readFolded(login));
  // Papers dragged from the list are over the space.
  const [dropping, setDropping] = useState(false);
  // An idea just made, whose words are written next.
  const [fresh, setFresh] = useState<string | null>(null);
  // The list of papers beside the full-screen space, over it on narrow screens; and a node dragged from it.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [listDrag, setListDrag] = useState<string | null>(null);
  const graphView = useRef<ForceGraphHandle>(null);
  const addButton = useRef<HTMLSpanElement>(null);
  const ideaInput = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const unsaved = useRef(false);
  const saving = useRef<Promise<void> | null>(null);

  const known = useMemo(() => spaceNodes(papers), [papers]);
  const knownRef = useRef(known);
  knownRef.current = known;
  const byId = useMemo(() => Object.fromEntries(papers.map((paper) => [paper.id, paper])), [papers]);
  const current = useMemo<ResearchSpace>(() => draft ?? { parents: {}, relations: [], ideas: {} }, [draft]);
  const tree = useMemo(() => spaceTree(current, known), [current, known]);
  const graph = useMemo(() => graphOf(tree, null), [tree]);
  const nodes = useMemo(() => new Set(graph.ids), [graph.ids]);
  const lines = useMemo(() => linesOf(current, nodes), [current, nodes]);
  const loaded = draft !== null;

  // Each paper's names of its blocks, worked out when first asked for.
  const words = useMemo<LabelWords>(
    () => ({
      figure: (n) => (n ? t('图 {n}', { n }) : t('图')),
      table: (n) => (n ? t('表 {n}', { n }) : t('表格')),
      abstract: t('摘要'),
      empty: t('（空白）'),
    }),
    [t],
  );
  const labelCache = useMemo(() => new Map<string, Record<string, NodeLabel>>(), [papers, words]);
  const labelsOf = useCallback(
    (paper: ResultPaper) => {
      let found = labelCache.get(paper.id);
      if (!found) {
        found = nodeLabels(paper, words);
        labelCache.set(paper.id, found);
      }
      return found;
    },
    [labelCache, words],
  );

  /** What a node is: a paper, one of its blocks, or an idea. */
  const what = (id: string) => {
    const part = blockOfNode(id);
    if (part) {
      const paper = byId[part.paperId];
      const block = paper?.blocks.find((item) => item.id === part.blockId);
      return paper && block ? { kind: 'block' as const, paper, block } : null;
    }
    if (isIdea(id)) return { kind: 'idea' as const };
    return byId[id] ? { kind: 'paper' as const, paper: byId[id] } : null;
  };
  /** A node's name: a paper's title, a block's heading or number, an idea's first line. */
  const label = (id: string | null | undefined): string => {
    if (!id) return '';
    const node = what(id);
    if (node?.kind === 'block') return labelsOf(node.paper)[node.block.id]?.title ?? node.block.id;
    if (node?.kind === 'paper') return node.paper.title;
    return current.ideas[id]?.trim().split('\n')[0] || t('（空白想法）');
  };
  /** Where a block is from, as the pointer rests on it. */
  const detail = (id: string): string | undefined => {
    const node = what(id);
    if (node?.kind !== 'block') return undefined;
    const caption = node.block.kind === 'text' ? undefined : labelsOf(node.paper)[node.block.id]?.detail;
    return [`${label(id)}${caption ? ` ${caption}` : ''}`, node.paper.title].join('\n');
  };
  const look = (id: string, on: boolean): NodeLook => {
    const node = what(id);
    if (node?.kind === 'block') return node.block.kind === 'text' ? LOOK.text(on) : LOOK.float(on);
    return node?.kind === 'paper' ? LOOK.paper(on) : LOOK.idea(on);
  };

  // The space as stored, read or saved elsewhere (another tab, another computer), when nothing changed here meanwhile.
  useEffect(() => {
    if (space && !unsaved.current && !saving.current) setDraft(space);
  }, [space]);

  /** Saves the space as it is now; changes made while saving are saved after. */
  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    const run = (async () => {
      const shot = draftRef.current;
      if (!shot) return;
      setStatus('saving');
      try {
        await onSave(cleanSpace(shot, knownRef.current), 'results: update research space');
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

  // Leaving the list saves what is not saved yet; closing the tab cannot wait for a save, so the browser asks first.
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

  useEffect(() => {
    try {
      if (folded) localStorage.setItem(foldKey(login), '1');
      else localStorage.removeItem(foldKey(login));
    } catch {
      // Folding is a convenience; it simply resets.
    }
  }, [folded, login]);

  // Escape leaves the full screen, unless a picker is open (it closes first).
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !adding) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, adding]);

  // The whole graph in sight when the full screen opens or closes.
  const sized = useRef(expanded);
  useEffect(() => {
    if (sized.current === expanded) return;
    sized.current = expanded;
    graphView.current?.fit();
  }, [expanded]);

  // A new idea's words are written at once.
  useEffect(() => {
    if (fresh && selected === fresh && ideaInput.current) {
      ideaInput.current.focus();
      setFresh(null);
    }
  }, [fresh, selected]);

  const change = (next: ResearchSpace) => {
    draftRef.current = next;
    unsaved.current = true;
    setDraft(next);
    setStatus('changed');
    setProblem(null);
  };
  const done = () => {
    setAdding(null);
    setPicker(null);
    setQuery('');
  };

  /** Hangs node `id` under `under`, or on its own (null); never under itself or a node under it. */
  const place = (id: string, under: string | null) => {
    const base = draftRef.current;
    if (!base || id === under) return;
    if (under !== null && tree.nodes[id] && subtreeOf(tree, id).has(under)) return;
    if (tree.nodes[id] && tree.nodes[id].parent === under) return;
    // A line drawn between the two goes: a branch joins them now.
    const placed = withNode(base, known, id, under);
    change(under ? withLine(placed, id, under, false) : placed);
  };
  /** Takes node `id` out of the space: the nodes under it hang where it hung; an idea is gone. */
  const remove = (id: string) => {
    const base = draftRef.current;
    if (!base || !tree.nodes[id]) return;
    change(withoutNode(base, known, id));
    graphView.current?.unpin(id);
    if (selected === id) setSelected(null);
  };
  const relate = (a: string, b: string, on: boolean) => {
    const base = draftRef.current;
    if (base) change(withLine(base, a, b, on));
  };
  /** A new idea under `under`, or on its own at `at`; chosen, with its words to write. */
  const addIdea = (under: string | null, at: [number, number] | null) => {
    const base = draftRef.current;
    if (!base) return;
    const made = withIdea(base, known, '', under);
    if (at) graphView.current?.pin(made.id, at);
    change(made.space);
    setSelected(made.id);
    setFresh(made.id);
    done();
  };
  /** A paper or a block into the space, under `under` or on its own at `at`; chosen. */
  const addNode = (id: string, under: string | null, at: [number, number] | null) => {
    const base = draftRef.current;
    if (!base) return;
    if (at) graphView.current?.pin(id, at);
    change(withNode(base, known, id, under));
    setSelected(id);
    done();
  };

  /** Papers dragged from the list: onto a node they hang under it; elsewhere, on their own where dropped. */
  const onDrop = (event: React.DragEvent) => {
    setDropping(false);
    const view = graphView.current;
    view?.aim(null);
    const data = event.dataTransfer.getData(PAPERS_TYPE);
    const base = draftRef.current;
    if (!data || !base || !view) return;
    event.preventDefault();
    let keys: string[] = [];
    try {
      keys = JSON.parse(data) as string[];
    } catch {
      return;
    }
    // Only the person's own papers: papers shared with them are others' to organize.
    const own = `${login.toLowerCase()}/`;
    const ids = keys.filter((key) => key.startsWith(own)).map((key) => key.slice(own.length)).filter((id) => byId[id]);
    const point = view.pointAt(event.clientX, event.clientY);
    let next = base;
    ids.forEach((id, index) => {
      const over = view.nodeAt(event.clientX, event.clientY, tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]));
      if (over) {
        view.unpin(id);
        next = withLine(withNode(next, known, id, over), id, over, false);
        return;
      }
      if (point) view.pin(id, [point[0] + index * 24, point[1] + index * 56]);
      // A paper already in the space only moves.
      if (!tree.nodes[id]) next = withNode(next, known, id, null);
    });
    if (next !== base) change(next);
    if (ids.length === 1) setSelected(ids[0]);
  };

  // Papers and blocks dragged from the list beside the full screen: onto a node they hang under it; elsewhere on
  // the canvas, on their own where dropped.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pointerOf = (activator: Event, delta: { x: number; y: number }) => {
    const pointer = activator as PointerEvent;
    return { x: pointer.clientX + delta.x, y: pointer.clientY + delta.y };
  };
  const dropFromList = (id: string, clientX: number, clientY: number) => {
    const view = graphView.current;
    const point = view?.pointAt(clientX, clientY);
    if (!view || !point || !draftRef.current) return;
    const over = view.nodeAt(clientX, clientY, tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]));
    if (over) {
      view.unpin(id);
      place(id, over);
    } else {
      view.pin(id, point);
      if (!tree.nodes[id]) change(withNode(draftRef.current, known, id, null));
    }
    setSelected(id);
  };

  /** The nodes a line from `id` cannot go to: itself, those it already has one to, and those it hangs with. */
  const lineSkip = (id: string): Set<string> => new Set([id, ...relatedTo(lines, id), ...(tree.nodes[id]?.children ?? []), ...(tree.nodes[id]?.parent ? [tree.nodes[id].parent!] : [])]);
  const branchOf = (id: string): ReadonlySet<string> => (tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]));
  /** A paper's page, at one of its blocks when given. */
  const goTo = (paper: ResultPaper, blockId?: string) => navigate(`/p/${login}/${paper.slug}${blockId ? `?block=${encodeURIComponent(blockId)}` : ''}`);
  const open = (id: string) => {
    const node = what(id);
    if (node?.kind === 'paper') goTo(node.paper);
    else if (node?.kind === 'block') goTo(node.paper, node.block.id);
    else setSelected(id);
  };

  const chosen = selected && nodes.has(selected) ? what(selected) : null;
  // The paper whose blocks the picker opens first: the chosen paper, or the paper of the chosen block.
  const firstPaper = chosen?.kind === 'paper' || chosen?.kind === 'block' ? chosen.paper.id : undefined;
  const wanted = query.trim().toLowerCase();
  const lineChoices = selected ? graph.ids.filter((id) => !lineSkip(selected).has(id) && (!wanted || label(id).toLowerCase().includes(wanted))) : [];
  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900';
  const statusText = { saved: t('已保存'), changed: t('有未保存的修改'), saving: t('保存中…'), failed: t('没有保存') }[status];
  const iconOf = (id: string) => {
    const node = what(id);
    if (node?.kind === 'block') return KIND_ICON[node.block.kind];
    return node?.kind === 'paper' ? FileText : Lightbulb;
  };
  const keys = [
    { label: t('论文'), look: LOOK.paper(false) },
    { label: t('文字'), look: LOOK.text(false) },
    { label: t('图表'), look: LOOK.float(false) },
    { label: t('想法'), look: LOOK.idea(false) },
  ];

  return (
    <section aria-labelledby="research-space" className={expanded ? 'fixed inset-0 z-40 flex flex-col bg-white px-4 pb-4 pt-3 sm:px-6' : 'mb-10'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => {
            setFolded((value) => !value);
            setExpanded(false);
          }}
          aria-expanded={!folded}
          className="-ml-1 inline-flex items-center gap-1 rounded-lg px-1 text-gray-900 hover:bg-black/[0.04]"
        >
          {folded ? <ChevronRight size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
          <h2 id="research-space" className="galley-display text-[1.6rem]">
            {t('我的研究空间')}
          </h2>
        </button>
        {!folded && loaded && <span className="text-xs text-gray-400">{statusText}</span>}
        {!folded && (
          <span className="ml-auto flex items-center gap-1">
            {expanded && (
              <button type="button" onClick={() => setLibraryOpen((value) => !value)} aria-expanded={libraryOpen} className={`${bar} lg:hidden`}>
                <ListTree size={14} />
                {t('论文')}
              </button>
            )}
            <span ref={addButton} className="relative">
              <button
                type="button"
                disabled={!loaded}
                onClick={() => setAdding(adding?.menu === 'bar' ? null : { menu: 'bar', at: graphView.current?.freeSpot() ?? [0, 0] })}
                aria-haspopup="dialog"
                aria-expanded={adding?.menu === 'bar'}
                title={t('放进论文、论文里的块，或写一个想法；双击画布的空白处也可以')}
                className={`${bar} disabled:opacity-40`}
              >
                <Plus size={14} />
                {t('添加')}
              </button>
              {adding?.menu === 'bar' && (
                <NodePicker
                  papers={papers}
                  taken={nodes}
                  labelsOf={labelsOf}
                  onIdea={() => addIdea(null, adding.at)}
                  onPick={(id) => addNode(id, null, adding.at)}
                  within={addButton}
                  onClose={() => setAdding(null)}
                  className="absolute right-0 top-full mt-1.5"
                />
              )}
            </span>
            {pinned && (
              <button type="button" onClick={() => graphView.current?.relayout()} className={bar} title={t('重新排布')}>
                <RotateCcw size={14} />
                <span className="hidden sm:inline">{t('重新排布')}</span>
              </button>
            )}
            <button type="button" onClick={() => setExpanded((value) => !value)} className={bar} title={expanded ? t('退出全屏') : t('全屏')} aria-label={expanded ? t('退出全屏') : t('全屏')}>
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </span>
        )}
      </div>
      {problem && !folded && (
        <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">
          {problem}
        </p>
      )}
      {!folded && (
        <DndContext
          sensors={sensors}
          autoScroll={false}
          onDragStart={({ active }) => setListDrag(String(active.id).replace(/^node:/, ''))}
          onDragMove={({ activatorEvent, delta }) => {
            const at = pointerOf(activatorEvent, delta);
            graphView.current?.aim(graphView.current.nodeAt(at.x, at.y));
          }}
          onDragEnd={({ active, activatorEvent, delta }) => {
            const at = pointerOf(activatorEvent, delta);
            setListDrag(null);
            graphView.current?.aim(null);
            dropFromList(String(active.id).replace(/^node:/, ''), at.x, at.y);
          }}
          onDragCancel={() => {
            setListDrag(null);
            graphView.current?.aim(null);
          }}
        >
          <div className={expanded ? 'relative mt-3 flex min-h-0 flex-1 gap-3' : 'mt-3'}>
            {expanded && loaded && (
              <SpaceLibrary
                login={login}
                papers={papers}
                organizer={organizer}
                inSpace={nodes}
                selected={selected}
                labelsOf={labelsOf}
                onPick={(id) => {
                  setSelected(id);
                  setLibraryOpen(false);
                  graphView.current?.focus(id);
                }}
                onAdd={(id) => addNode(id, null, graphView.current?.freeSpot() ?? null)}
                onClose={() => setLibraryOpen(false)}
                className={`${libraryOpen ? 'absolute inset-y-0 left-0 z-30 flex w-72 shadow-xl' : 'hidden'} lg:static lg:flex lg:w-72 lg:shrink-0 lg:shadow-none`}
              />
            )}
            <div
              onDragOver={(event) => {
                if (!loaded || !event.dataTransfer.types.includes(PAPERS_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropping(true);
                graphView.current?.aim(graphView.current.nodeAt(event.clientX, event.clientY));
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setDropping(false);
                graphView.current?.aim(null);
              }}
              onDrop={onDrop}
              className={`relative overflow-hidden rounded-2xl ring-1 transition-shadow duration-150 ${expanded ? 'min-h-0 min-w-0 flex-1' : 'h-[460px]'} ${
                dropping ? 'ring-2 ring-violet-400' : 'ring-black/[0.07]'
              }`}
            >
              {loaded ? (
                <ForceGraph
                  ref={graphView}
                  className="h-full w-full"
                  ids={graph.ids}
                  links={graph.links}
                  lines={lines}
                  pinKey={`lemma-space:${login.toLowerCase()}`}
                  label={label}
                  detail={detail}
                  look={look}
                  keys={keys}
                  selected={selected}
                  onSelect={(id) => {
                    setSelected(id);
                    setPicker(null);
                  }}
                  branchOf={branchOf}
                  onPlace={place}
                  lineSkip={lineSkip}
                  onRelate={relate}
                  onEmptyDoubleClick={(at, menu) => {
                    setSelected(null);
                    setAdding({ menu, at });
                  }}
                  menuSize={MENU_SIZE}
                  onOpen={open}
                  ghost={adding?.at ?? null}
                  wheelZooms={expanded}
                  aside={PANEL}
                  title={t('我的研究空间')}
                  onPinned={setPinned}
                  empty={
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
                      <Lightbulb size={22} className="text-violet-400" aria-hidden="true" />
                      <p className="max-w-md text-sm text-gray-500">{t('把下面的论文拖到这里，或者用「添加」放进论文里的图、表、文字和你的想法，搭出你的研究思路。')}</p>
                    </div>
                  }
                  hint={
                    graph.ids.length > 1 && graph.links.length === 0 && lines.length === 0 ? (
                      <p className="pointer-events-none absolute inset-x-0 bottom-14 px-6 text-center text-xs text-gray-500">{t('把一个节点拖到另一个上，就挂到它下面；从节点右上角的小圆点拖到另一个节点，就连一条关联线。')}</p>
                    ) : null
                  }
                >
                  {adding && adding.menu !== 'bar' && (
                    <NodePicker
                      papers={papers}
                      taken={nodes}
                      labelsOf={labelsOf}
                      onIdea={() => addIdea(null, adding.at)}
                      onPick={(id) => addNode(id, null, adding.at)}
                      onClose={() => setAdding(null)}
                      className="absolute"
                      style={{ left: adding.menu.left, top: adding.menu.top }}
                    />
                  )}

                  {/* The chosen node: a paper with the way to it, a block as the paper shows it, an idea with its words. */}
                  {selected && chosen && (
                    <aside
                      aria-label={label(selected)}
                      className="absolute inset-x-3 bottom-3 z-10 flex max-h-[85%] flex-col overflow-hidden rounded-xl bg-white shadow-[0_16px_48px_-16px_rgba(0,0,0,0.35)] ring-1 ring-black/[0.06] sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[320px]"
                    >
                      <header className="flex items-start gap-2 border-b border-black/[0.06] px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-gray-900">{chosen.kind === 'idea' ? t('想法') : label(selected)}</p>
                          {chosen.kind === 'block' && <p className="mt-0.5 truncate text-xs text-gray-500">{chosen.paper.title}</p>}
                          <p className="mt-0.5 text-xs text-gray-500">
                            {tree.nodes[selected]?.parent ? t('挂在「{name}」下面', { name: label(tree.nodes[selected].parent) }) : t('还没连到别的节点上')}
                          </p>
                        </div>
                        <button type="button" onClick={() => setSelected(null)} aria-label={t('关闭')} className="rounded p-1 text-gray-400 hover:bg-black/[0.05] hover:text-gray-700">
                          <X size={16} />
                        </button>
                      </header>
                      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                        {!picker && chosen.kind === 'paper' && (
                          <div className="space-y-2">
                            {(chosen.paper.venue || chosen.paper.year) && <p className="text-xs text-gray-500">{[chosen.paper.venue, chosen.paper.year].filter(Boolean).join(' ')}</p>}
                            <button type="button" onClick={() => goTo(chosen.paper)} className="galley-press inline-flex items-center gap-1.5 rounded-lg bg-violet-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-violet-800">
                              <FileText size={14} />
                              {t('打开论文')}
                            </button>
                          </div>
                        )}
                        {!picker && chosen.kind === 'block' && (
                          <div className="space-y-2">
                            <ResultsAccessContext.Provider value={access}>
                              <BlockView paperId={chosen.paper.id} block={chosen.block} />
                            </ResultsAccessContext.Provider>
                            <button type="button" onClick={() => goTo(chosen.paper, chosen.block.id)} className={`${bar} ring-1 ring-black/[0.08]`}>
                              <FileText size={14} />
                              {t('在论文里打开')}
                            </button>
                          </div>
                        )}
                        {!picker && chosen.kind === 'idea' && (
                          <textarea
                            ref={ideaInput}
                            value={current.ideas[selected] ?? ''}
                            onChange={(event) => {
                              const base = draftRef.current;
                              if (base) change(withIdeaText(base, selected, event.target.value));
                            }}
                            rows={4}
                            placeholder={t('写下这个想法：一个问题、一个方向、一句笔记…')}
                            className="block w-full resize-y rounded-lg border border-gray-300 px-2.5 py-2 text-[13px] leading-relaxed text-gray-800 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
                          />
                        )}
                        {picker === 'branch' ? (
                          <div className="space-y-1.5">
                            <p className="flex items-center justify-between text-xs text-gray-500">
                              {t('挂到这里')}
                              <button type="button" onClick={() => setPicker(null)} aria-label={t('关闭')} className="text-gray-400 hover:text-gray-700">
                                <X size={13} />
                              </button>
                            </p>
                            <NodePicker
                              papers={papers}
                              taken={nodes}
                              labelsOf={labelsOf}
                              first={firstPaper}
                              onIdea={() => addIdea(selected, null)}
                              onPick={(id) => addNode(id, selected, null)}
                              className="!w-full !shadow-none"
                            />
                          </div>
                        ) : picker === 'line' ? (
                          <div className="space-y-1.5">
                            <label className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2 py-1.5 focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-100">
                              <Search size={13} className="text-gray-400" />
                              <input
                                autoFocus
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t('找一个节点连到这里')}
                                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                              />
                              <button type="button" onClick={() => setPicker(null)} aria-label={t('关闭')} className="text-gray-400 hover:text-gray-700">
                                <X size={13} />
                              </button>
                            </label>
                            <div className="max-h-40 overflow-y-auto">
                              {lineChoices.length === 0 && <p className="py-2 text-center text-xs text-gray-400">{t('空间里没有可以连的节点了')}</p>}
                              {lineChoices.map((id) => {
                                const Icon = iconOf(id);
                                return (
                                  <button
                                    key={id}
                                    type="button"
                                    onClick={() => {
                                      relate(selected, id, true);
                                      setPicker(null);
                                      setQuery('');
                                    }}
                                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-gray-700 hover:bg-violet-50 hover:text-violet-800"
                                  >
                                    <Icon size={13} className="shrink-0 text-gray-400" />
                                    <span className="truncate">{label(id)}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <>
                            <label className="block text-xs text-gray-500">
                              {t('挂在哪个节点下面')}
                              <select
                                value={tree.nodes[selected]?.parent ?? ''}
                                onChange={(event) => place(selected, event.target.value || null)}
                                className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[13px] text-gray-800 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
                              >
                                <option value="">{t('不连接')}</option>
                                {graph.ids
                                  .filter((id) => !branchOf(selected).has(id))
                                  .map((id) => (
                                    <option key={id} value={id}>
                                      {label(id)}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            {/* The lines drawn to this node, each one taken away by its ×. */}
                            <div className="text-xs text-gray-500">
                              <p>{t('关联')}</p>
                              {relatedTo(lines, selected).length === 0 ? (
                                <p className="mt-0.5 text-gray-400">{t('还没有关联线：从节点右上角的小圆点拖到另一个节点就能连上。')}</p>
                              ) : (
                                <ul className="mt-1 flex flex-wrap gap-1.5">
                                  {relatedTo(lines, selected).map((other) => (
                                    <li key={other} className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 py-0.5 pl-2.5 pr-1 text-blue-800">
                                      <span className="truncate">{label(other)}</span>
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
                      </div>
                      <div className="flex flex-wrap gap-1.5 border-t border-black/[0.06] px-4 py-3">
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
                        <button type="button" onClick={() => remove(selected)} className={`${bar} ring-1 ring-black/[0.08]`}>
                          {chosen.kind === 'idea' ? <Trash2 size={14} /> : <Undo2 size={14} />}
                          {chosen.kind === 'idea' ? t('删除这个想法') : t('从空间里拿掉')}
                        </button>
                      </div>
                    </aside>
                  )}
                </ForceGraph>
              ) : (
                <p className="flex h-full items-center justify-center bg-[#fafafb] text-sm text-gray-400">{t('正在读取研究空间…')}</p>
              )}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {listDrag
              ? (() => {
                  const Icon = iconOf(listDrag);
                  return (
                    <div className="pointer-events-none flex max-w-[280px] items-center gap-1.5 rounded-xl border border-violet-400 bg-white px-3 py-2 text-[13px] font-medium text-gray-900 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35)]">
                      <GripVertical size={13} className="shrink-0 text-violet-500" />
                      <Icon size={13} className="shrink-0 text-gray-400" />
                      <span className="truncate">{label(listDrag)}</span>
                    </div>
                  );
                })()
              : null}
          </DragOverlay>
        </DndContext>
      )}
    </section>
  );
};

export default ResearchSpaceView;
