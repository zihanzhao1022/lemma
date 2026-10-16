import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Map as MapIcon, Maximize, Minimize, X } from 'lucide-react';
import PdfView from '../components/results/PdfView';
import { useT } from '../lib/phrases/app';
import { ResultBlockOutput, ResultPaper } from '../types';
import { LabelWords, NodeLabel, nodeLabels } from './logic/labels';
import { Spacing, layoutTree, link } from './logic/layout';
import { LogicTree, ancestorsOf, logicTree, movesFrom, paperTree, pruned } from './logic/tree';

interface Props {
  /** The paper with the logic to follow (as last changed, saved or not). */
  paper: ResultPaper;
  readFile: (path: string, version?: string) => Promise<Uint8Array>;
  /** The block to start from; the first one when absent, or the next one shown when it is not. */
  start?: string | null;
  /** The tree to go along: the paper's own (its sections), or the logic its author built. */
  along: 'paper' | 'logic';
  onClose: () => void;
}

const REFERENCES = 'references';

/** The map's boxes: small enough for a corner, the levels still apart. */
const MAP: Spacing = { w: 16, h: 9, across: 4, down: 13, between: 10 };
const MAP_WIDTH = 340;

/** The whole tree in a corner, the block on screen and the way down to it marked; a box goes to its block. */
export const MiniMap: React.FC<{ tree: LogicTree; current: string; labels: Record<string, NodeLabel>; onGo: (id: string) => void }> = ({ tree, current, labels, onGo }) => {
  const t = useT();
  const drawn = useMemo(() => layoutTree(tree, new Set(), MAP), [tree]);
  const path = useMemo(() => new Set(ancestorsOf(tree, current)), [tree, current]);
  const width = Math.min(drawn.width, MAP_WIDTH);
  const here = drawn.at[current];
  // A tree wider than the map slides along under it, keeping the block on screen in the middle.
  const offset = here && drawn.width > width ? Math.min(drawn.width - width, Math.max(0, here.x + MAP.w / 2 - width / 2)) : 0;
  return (
    <nav aria-label={t('地图')} className="pointer-events-auto rounded-xl bg-white/95 p-3 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.06]">
      <div className="overflow-hidden" style={{ width, height: drawn.height }}>
        <svg width={drawn.width} height={drawn.height} className="block transition-transform duration-200" style={{ transform: `translateX(${-offset}px)` }}>
          {Object.keys(drawn.at).map((id) => {
            const parent = tree.nodes[id].parent;
            if (!parent) return null;
            const lit = (path.has(id) || id === current) && path.has(parent);
            return (
              <path
                key={id}
                d={link(drawn.at[parent], drawn.at[id], MAP)}
                fill="none"
                stroke={lit ? '#7c3aed' : '#d4d4d8'}
                strokeWidth={lit ? 1.6 : 1}
              />
            );
          })}
          {Object.entries(drawn.at).map(([id, at]) => (
            <rect
              key={id}
              x={at.x}
              y={at.y}
              width={MAP.w}
              height={MAP.h}
              rx={2}
              onClick={() => onGo(id)}
              className="cursor-pointer"
              fill={id === current ? '#6d28d9' : path.has(id) ? '#ddd6fe' : '#e4e4e7'}
              stroke={id === current ? '#4c1d95' : path.has(id) ? '#8b5cf6' : '#a1a1aa'}
              strokeWidth={0.8}
            >
              <title>{labels[id]?.title ?? id}</title>
            </rect>
          ))}
        </svg>
      </div>
    </nav>
  );
};

/**
 * The paper one block at a time, as large as the screen allows, for a group meeting, along a tree of its blocks
 * (its sections, or the logic its author built): left and right go to the blocks beside it on its level (another
 * branch), down to the blocks under it, up to the block it belongs to; the space bar goes through all of them in
 * order. A map in the corner shows where one is.
 */
const Presentation: React.FC<Props> = ({ paper, readFile, start, along, onClose }) => {
  const t = useT();
  const outputs = useMemo(() => {
    const found: Record<string, ResultBlockOutput> = {};
    for (const block of paper.blocks) if (!block.hidden && block.output) found[block.id] = block.output;
    if (paper.references) found[REFERENCES] = paper.references;
    return found;
  }, [paper]);
  const whole = useMemo(() => (along === 'logic' ? logicTree(paper) : paperTree(paper)), [paper, along]);
  // The bibliography closes the paper; the logic holds only the blocks put in it.
  const tree = useMemo(() => pruned(whole, (id) => id in outputs, paper.references && along === 'paper' ? [REFERENCES] : []), [whole, outputs, paper.references, along]);
  const words = useMemo<LabelWords>(
    () => ({ figure: (n) => (n ? t('图 {n}', { n }) : t('图')), table: (n) => (n ? t('表 {n}', { n }) : t('表格')), abstract: t('摘要'), empty: t('（空白）') }),
    [t],
  );
  const labels = useMemo<Record<string, NodeLabel>>(() => ({ ...nodeLabels(paper, words), [REFERENCES]: { title: t('参考文献') } }), [paper, words, t]);
  const [at, setAt] = useState<string | null>(() => {
    if (start && tree.nodes[start]) return start;
    const from = start ? whole.order.indexOf(start) : -1;
    return (from >= 0 ? whole.order.slice(from).find((id) => tree.nodes[id]) : undefined) ?? tree.order[0] ?? null;
  });
  const current = at && tree.nodes[at] ? at : (tree.order[0] ?? null);
  const moves = current ? movesFrom(tree, current) : null;
  const [pdfs, setPdfs] = useState<Record<string, Uint8Array>>({});
  const [full, setFull] = useState(false);
  const [map, setMap] = useState(true);

  // Going down goes back to the block one came up from, else to the first one.
  const lastUnder = useRef<Record<string, string>>({});
  useEffect(() => {
    const parent = current ? tree.nodes[current].parent : null;
    if (current && parent) lastUnder.current[parent] = current;
  }, [current, tree]);
  const downFrom = (id: string): string | null => {
    const remembered = lastUnder.current[id];
    return remembered && tree.nodes[remembered]?.parent === id ? remembered : (tree.nodes[id]?.children[0] ?? null);
  };

  // The keys follow what is on screen without listening anew each time (which would also leave full screen).
  const keys = useRef({ moves, current, downFrom, tree, onClose });
  keys.current = { moves, current, downFrom, tree, onClose };
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      const { moves: from, current: here, downFrom: down, tree: shown } = keys.current;
      let to: string | null | undefined;
      if (event.key === 'Escape') {
        keys.current.onClose();
        return;
      }
      if (event.key === 'ArrowRight') to = from?.right;
      else if (event.key === 'ArrowLeft') to = from?.left;
      else if (event.key === 'ArrowDown') to = here ? down(here) : null;
      else if (event.key === 'ArrowUp') to = from?.up;
      else if (event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) to = from?.next;
      else if (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) to = from?.previous;
      else if (event.key === 'Home') to = shown.order[0];
      else if (event.key === 'End') to = shown.order[shown.order.length - 1];
      else if (event.key === 'm' || event.key === 'M') setMap((on) => !on);
      else return;
      event.preventDefault();
      if (to) setAt(to);
    };
    window.addEventListener('keydown', onKey);
    const onFull = () => setFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFull);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const below = current ? downFrom(current) : null;

  // This block's PDF and those of the blocks one can go to from it, so moving on does not wait.
  useEffect(() => {
    if (!current || !moves) return;
    for (const id of [current, moves.next, moves.right, below, moves.left, moves.up]) {
      const output = id ? outputs[id] : undefined;
      if (!output || pdfs[output.pdf]) continue;
      readFile(output.pdf).then(
        (bytes) => setPdfs((loaded) => ({ ...loaded, [output.pdf]: bytes })),
        () => undefined,
      );
    }
  }, [current, below, moves?.next, moves?.right, moves?.left, moves?.up, outputs, pdfs, readFile]);

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };

  const output = current ? outputs[current] : undefined;
  const index = current ? tree.order.indexOf(current) : -1;
  const title = (id: string | null | undefined) => (id ? (labels[id]?.title ?? '') : '');
  const side = 'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/90 p-2.5 text-gray-700 shadow-[0_4px_16px_-6px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.06] hover:bg-white hover:text-violet-700';
  const pill = 'absolute left-1/2 z-10 inline-flex max-w-[60%] -translate-x-1/2 items-center gap-1.5 rounded-full bg-white/90 px-3.5 py-1.5 text-[13px] text-gray-700 shadow-[0_4px_16px_-6px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.06] hover:bg-white hover:text-violet-700';

  return (
    <div role="dialog" aria-modal="true" aria-label={t('演示')} className="fixed inset-0 z-[110] flex flex-col bg-neutral-100">
      <header className="flex items-center gap-3 px-5 py-3 text-sm text-gray-600">
        <span className="font-serif-display shrink-0 truncate text-base text-gray-900 sm:max-w-[30%]">{paper.title}</span>
        {current && (
          <nav aria-label={t('位置')} className="flex min-w-0 items-center gap-1 text-gray-500">
            {ancestorsOf(tree, current).map((id) => (
              <React.Fragment key={id}>
                <button type="button" onClick={() => setAt(id)} className="max-w-[12rem] truncate rounded px-1 hover:bg-white hover:text-gray-900">
                  {title(id)}
                </button>
                <ChevronRight size={14} className="shrink-0 text-gray-400" aria-hidden="true" />
              </React.Fragment>
            ))}
            <span className="truncate px-1 font-medium text-gray-800">{title(current)}</span>
          </nav>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-gray-500">{tree.order.length > 0 ? `${index + 1} / ${tree.order.length}` : ''}</span>
        <button type="button" onClick={() => setMap((on) => !on)} aria-pressed={map} aria-label={t('地图')} title={t('地图（M）')} className={`rounded p-1.5 hover:bg-white ${map ? 'text-violet-700' : ''}`}>
          <MapIcon size={18} />
        </button>
        <button type="button" onClick={toggleFull} aria-label={full ? t('退出全屏') : t('全屏')} title={full ? t('退出全屏') : t('全屏')} className="rounded p-1.5 hover:bg-white">
          {full ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
        <button type="button" onClick={onClose} aria-label={t('结束演示')} title={t('结束演示（Esc）')} className="rounded p-1.5 hover:bg-white">
          <X size={18} />
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* A short block sits in the middle of the screen; a long one scrolls. */}
        <div className="flex h-full flex-col overflow-y-auto px-16 pb-14 pt-12">
          {output ? (
            <div className="mx-auto my-auto w-full max-w-[1100px] bg-white shadow-sm">
              <PdfView key={output.pdf} data={pdfs[output.pdf]} width={output.width} height={output.height} maxScale={3} />
            </div>
          ) : (
            <p className="py-24 text-center text-gray-500">{t('这篇论文还没有能演示的块。')}</p>
          )}
        </div>
        {moves?.up && (
          <button type="button" onClick={() => setAt(moves.up)} title={t('上一层（↑）')} className={`${pill} top-2`}>
            <ArrowUp size={14} className="shrink-0" />
            <span className="truncate">{title(moves.up)}</span>
          </button>
        )}
        {moves?.left && (
          <button type="button" onClick={() => setAt(moves.left)} aria-label={t('左边：{name}', { name: title(moves.left) })} title={t('左边：{name}', { name: title(moves.left) })} className={`${side} left-3`}>
            <ChevronLeft size={20} />
          </button>
        )}
        {moves?.right && (
          <button type="button" onClick={() => setAt(moves.right)} aria-label={t('右边：{name}', { name: title(moves.right) })} title={t('右边：{name}', { name: title(moves.right) })} className={`${side} right-3`}>
            <ChevronRight size={20} />
          </button>
        )}
        {current && below && (
          <button type="button" onClick={() => setAt(below)} title={t('下一层（↓）')} className={`${pill} bottom-3`}>
            <ArrowDown size={14} className="shrink-0" />
            <span className="truncate">{title(below)}</span>
            {tree.nodes[current].children.length > 1 && <span className="shrink-0 text-gray-400">{t('还有 {n} 块', { n: tree.nodes[current].children.length - 1 })}</span>}
          </button>
        )}
        {map && current && tree.order.length > 1 && (
          <div className="pointer-events-none absolute bottom-3 right-3 z-20 hidden sm:block">
            <MiniMap tree={tree} current={current} labels={labels} onGo={setAt} />
          </div>
        )}
      </div>
      <footer className="flex items-center justify-center gap-4 px-4 pb-4 pt-1">
        <button type="button" disabled={!moves?.previous} onClick={() => setAt(moves?.previous ?? null)} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-[13px] text-gray-700 shadow-sm disabled:opacity-30">
          <ChevronLeft size={16} />
          {t('上一块')}
        </button>
        <div className="flex flex-col items-center gap-1.5">
          <div className="h-1 w-48 overflow-hidden rounded-full bg-gray-300" aria-hidden="true">
            <div className="h-full bg-violet-600 transition-[width]" style={{ width: `${tree.order.length ? ((index + 1) / tree.order.length) * 100 : 0}%` }} />
          </div>
          <span className="hidden text-[11.5px] text-gray-400 sm:block">{t('← → 换分支　↑ ↓ 上下层　空格 下一块　M 地图')}</span>
        </div>
        <button type="button" disabled={!moves?.next} onClick={() => setAt(moves?.next ?? null)} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-[13px] text-gray-700 shadow-sm disabled:opacity-30">
          {t('下一块')}
          <ChevronRight size={16} />
        </button>
      </footer>
    </div>
  );
};

export default Presentation;
