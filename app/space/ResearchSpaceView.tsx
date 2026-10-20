import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, FileText, Lightbulb, Link2, Maximize2, Minimize2, Plus, RotateCcw, Search, Trash2, Undo2, X } from 'lucide-react';
import { describeSaveError } from '../../editor/backend';
import { useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResearchSpace, ResultPaper } from '../../types';
import { PAPERS_TYPE } from '../dragging';
import FloatingMenu, { MenuChoice } from '../logic/FloatingMenu';
import ForceGraph, { ForceGraphHandle, NodeLook } from '../logic/ForceGraph';
import { graphOf, relatedTo } from '../logic/graph';
import { subtreeOf } from '../logic/tree';
import { cleanSpace, isIdea, linesOf, spaceTree, withIdea, withIdeaText, withLine, withNode, withoutNode } from './space';

interface Props {
  login: string;
  /** The account's own papers, in their order. */
  papers: ResultPaper[];
  /** The space as stored; null while it is read. */
  space: ResearchSpace | null;
  onSave: (space: ResearchSpace, message: string) => Promise<void>;
}

type Status = 'saved' | 'changed' | 'saving' | 'failed';

/** Room the panel of the chosen node takes on the right of a wide canvas. */
const PANEL = 320;
const MENU_SIZE = { width: 264, height: 330 };

const foldKey = (login: string) => `lemma-space-folded:${login.toLowerCase()}`;
function readFolded(login: string): boolean {
  try {
    return localStorage.getItem(foldKey(login)) === '1';
  } catch {
    return false;
  }
}

/**
 * The person's research space, over their list of papers: their papers and ideas (questions, directions, notes)
 * as a graph like a paper's logic (ForceGraph), to think a subject through across papers. Papers come from the
 * list below by dragging, or from the Add menu; ideas are written here. The space is kept in their repository
 * (research-space.json); where nodes were put stays in this browser.
 */
const ResearchSpaceView: React.FC<Props> = ({ login, papers, space, onSave }) => {
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
  // What can be added, offered under the bar's button or where the canvas was double-clicked; it shows at `at`.
  const [adding, setAdding] = useState<{ menu: 'bar' | { left: number; top: number }; at: [number, number] } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [folded, setFolded] = useState(() => readFolded(login));
  // Papers dragged from the list are over the space.
  const [dropping, setDropping] = useState(false);
  // An idea just made, whose words are written next.
  const [fresh, setFresh] = useState<string | null>(null);
  const graphView = useRef<ForceGraphHandle>(null);
  const addButton = useRef<HTMLSpanElement>(null);
  const ideaInput = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const unsaved = useRef(false);
  const saving = useRef<Promise<void> | null>(null);

  const paperIds = useMemo(() => papers.map((paper) => paper.id), [papers]);
  const paperIdsRef = useRef(paperIds);
  paperIdsRef.current = paperIds;
  const byId = useMemo(() => Object.fromEntries(papers.map((paper) => [paper.id, paper])), [papers]);
  const current = useMemo<ResearchSpace>(() => draft ?? { parents: {}, relations: [], ideas: {} }, [draft]);
  const tree = useMemo(() => spaceTree(current, paperIds), [current, paperIds]);
  const graph = useMemo(() => graphOf(tree, null), [tree]);
  const nodes = useMemo(() => new Set(graph.ids), [graph.ids]);
  const lines = useMemo(() => linesOf(current, nodes), [current, nodes]);
  const loaded = draft !== null;

  /** A node's name: a paper's title, an idea's first line. */
  const label = (id: string | null | undefined): string => {
    if (!id) return '';
    if (isIdea(id)) return current.ideas[id]?.trim().split('\n')[0] || t('（空白想法）');
    return byId[id]?.title ?? id;
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
        await onSave(cleanSpace(shot, paperIdsRef.current), 'results: update research space');
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

  // Escape leaves the full screen, unless a menu is open (it closes first).
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
    const placed = withNode(base, paperIds, id, under);
    change(under ? withLine(placed, id, under, false) : placed);
  };
  /** Takes node `id` out of the space: the nodes under it hang where it hung; an idea is gone. */
  const remove = (id: string) => {
    const base = draftRef.current;
    if (!base || !tree.nodes[id]) return;
    change(withoutNode(base, paperIds, id));
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
    const made = withIdea(base, paperIds, '', under);
    if (at) graphView.current?.pin(made.id, at);
    change(made.space);
    setSelected(made.id);
    setFresh(made.id);
    done();
  };
  /** Paper `id` into the space, under `under` or on its own at `at`. */
  const addPaper = (id: string, under: string | null, at: [number, number] | null) => {
    const base = draftRef.current;
    if (!base) return;
    if (at) graphView.current?.pin(id, at);
    change(withNode(base, paperIds, id, under));
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
        next = withLine(withNode(next, paperIds, id, over), id, over, false);
        return;
      }
      if (point) view.pin(id, [point[0] + index * 24, point[1] + index * 56]);
      // A paper already in the space only moves.
      if (!tree.nodes[id]) next = withNode(next, paperIds, id, null);
    });
    if (next !== base) change(next);
    if (ids.length === 1) setSelected(ids[0]);
  };

  /** The nodes a line from `id` cannot go to: itself, those it already has one to, and those it hangs with. */
  const lineSkip = (id: string): Set<string> => new Set([id, ...relatedTo(lines, id), ...(tree.nodes[id]?.children ?? []), ...(tree.nodes[id]?.parent ? [tree.nodes[id].parent!] : [])]);
  const branchOf = (id: string): ReadonlySet<string> => (tree.nodes[id] ? subtreeOf(tree, id) : new Set([id]));
  const look = (id: string, on: boolean): NodeLook =>
    isIdea(id) ? { fill: '#ffffff', stroke: on ? '#7c3aed' : '#a1a1aa', strokeWidth: 2, square: true } : { fill: on ? '#6d28d9' : '#8b5cf6', stroke: 'none', strokeWidth: 1.5 };
  const open = (id: string) => {
    const paper = byId[id];
    if (paper) navigate(`/p/${login}/${paper.slug}`);
    else setSelected(id);
  };

  const outside = papers.filter((paper) => !nodes.has(paper.id));
  const addChoices = (at: [number, number] | null, under: string | null): MenuChoice[] => [
    { key: 'idea', icon: Lightbulb, text: t('新想法'), onPick: () => addIdea(under, at) },
    ...outside.map((paper): MenuChoice => ({ key: paper.id, icon: FileText, tone: 'text-violet-500', text: paper.title, onPick: () => addPaper(paper.id, under, at) })),
  ];
  // What the panel's picker offers: papers not in the space for a branch, nodes in it for a line.
  const wanted = query.trim().toLowerCase();
  const matches = (id: string) => !wanted || label(id).toLowerCase().includes(wanted);
  const choices = picker === 'line' && selected ? graph.ids.filter((id) => !lineSkip(selected).has(id) && matches(id)) : outside.map((paper) => paper.id).filter(matches);
  const selectedPaper = selected ? byId[selected] : undefined;
  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900';
  const statusText = { saved: t('已保存'), changed: t('有未保存的修改'), saving: t('保存中…'), failed: t('没有保存') }[status];

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
            <span ref={addButton} className="relative">
              <button
                type="button"
                disabled={!loaded}
                onClick={() => setAdding(adding?.menu === 'bar' ? null : { menu: 'bar', at: graphView.current?.freeSpot() ?? [0, 0] })}
                aria-haspopup="menu"
                aria-expanded={adding?.menu === 'bar'}
                title={t('放进一篇论文或写一个想法；双击画布的空白处也可以')}
                className={`${bar} disabled:opacity-40`}
              >
                <Plus size={14} />
                {t('添加')}
              </button>
              {adding?.menu === 'bar' && (
                <FloatingMenu wide title={t('添加到空间')} choices={addChoices(adding.at, null)} within={addButton} onClose={() => setAdding(null)} className="absolute right-0 top-full mt-1.5" />
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
          className={`relative mt-3 overflow-hidden rounded-2xl ring-1 transition-shadow duration-150 ${expanded ? 'min-h-0 flex-1' : 'h-[380px]'} ${
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
              look={look}
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
                  <p className="max-w-md text-sm text-gray-500">{t('把下面的论文拖到这里，或者双击画布写下一个想法，搭出你的研究思路。')}</p>
                </div>
              }
              hint={
                graph.ids.length > 1 && graph.links.length === 0 && lines.length === 0 ? (
                  <p className="pointer-events-none absolute inset-x-0 bottom-14 px-6 text-center text-xs text-gray-500">{t('把一个节点拖到另一个上，就挂到它下面；从节点右上角的小圆点拖到另一个节点，就连一条关联线。')}</p>
                ) : null
              }
            >
              {adding && adding.menu !== 'bar' && (
                <FloatingMenu wide title={t('添加到空间')} choices={addChoices(adding.at, null)} onClose={() => setAdding(null)} className="absolute" style={{ left: adding.menu.left, top: adding.menu.top }} />
              )}

              {/* The chosen node: a paper with the way to it, an idea with its words; and where it belongs. */}
              {selected && nodes.has(selected) && (
                <aside
                  aria-label={label(selected)}
                  className="absolute inset-x-3 bottom-3 z-10 flex max-h-[85%] flex-col overflow-hidden rounded-xl bg-white shadow-[0_16px_48px_-16px_rgba(0,0,0,0.35)] ring-1 ring-black/[0.06] sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[300px]"
                >
                  <header className="flex items-start gap-2 border-b border-black/[0.06] px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">{selectedPaper ? selectedPaper.title : t('想法')}</p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {tree.nodes[selected]?.parent ? t('挂在「{name}」下面', { name: label(tree.nodes[selected].parent) }) : t('还没连到别的节点上')}
                      </p>
                    </div>
                    <button type="button" onClick={() => setSelected(null)} aria-label={t('关闭')} className="rounded p-1 text-gray-400 hover:bg-black/[0.05] hover:text-gray-700">
                      <X size={16} />
                    </button>
                  </header>
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                    {selectedPaper ? (
                      <div className="space-y-2">
                        {(selectedPaper.venue || selectedPaper.year) && <p className="text-xs text-gray-500">{[selectedPaper.venue, selectedPaper.year].filter(Boolean).join(' ')}</p>}
                        <button
                          type="button"
                          onClick={() => navigate(`/p/${login}/${selectedPaper.slug}`)}
                          className="galley-press inline-flex items-center gap-1.5 rounded-lg bg-violet-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-violet-800"
                        >
                          <FileText size={14} />
                          {t('打开论文')}
                        </button>
                      </div>
                    ) : (
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
                    {picker ? (
                      <div className="space-y-1.5">
                        <label className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2 py-1.5 focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-100">
                          <Search size={13} className="text-gray-400" />
                          <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={picker === 'line' ? t('找一个节点连到这里') : t('找一篇论文挂到这里')}
                            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                          />
                          <button type="button" onClick={() => setPicker(null)} aria-label={t('关闭')} className="text-gray-400 hover:text-gray-700">
                            <X size={13} />
                          </button>
                        </label>
                        <div className="max-h-40 overflow-y-auto">
                          {choices.length === 0 && <p className="py-2 text-center text-xs text-gray-400">{picker === 'line' ? t('空间里没有可以连的节点了') : t('所有论文都已经在空间里了')}</p>}
                          {choices.map((id) => {
                            const Icon = isIdea(id) ? Lightbulb : FileText;
                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => {
                                  if (picker === 'line') relate(selected, id, true);
                                  else addPaper(id, selected, null);
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
                        {picker === 'branch' && (
                          <button
                            type="button"
                            onClick={() => addIdea(selected, null)}
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12.5px] text-gray-700 ring-1 ring-black/[0.1] hover:bg-violet-50 hover:text-violet-800"
                          >
                            <Lightbulb size={12} className="text-gray-400" aria-hidden="true" />
                            {t('或者挂一个新想法')}
                          </button>
                        )}
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
                      {selectedPaper ? <Undo2 size={14} /> : <Trash2 size={14} />}
                      {selectedPaper ? t('从空间里拿掉') : t('删除这个想法')}
                    </button>
                  </div>
                </aside>
              )}
            </ForceGraph>
          ) : (
            <p className="flex h-full items-center justify-center bg-[#fafafb] text-sm text-gray-400">{t('正在读取研究空间…')}</p>
          )}
        </div>
      )}
    </section>
  );
};

export default ResearchSpaceView;
