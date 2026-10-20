import React, { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, GripVertical, Plus, Search, X } from 'lucide-react';
import { useT } from '../../lib/phrases/app';
import { ResultPaper } from '../../types';
import { NodeLabel } from '../logic/labels';
import { Organizer, inView, paperKey, tree } from '../organizer';
import { KIND_ICON } from './NodePicker';
import { blockNode } from './space';

interface Props {
  login: string;
  papers: ResultPaper[];
  organizer: Organizer;
  /** Nodes already in the space, marked. */
  inSpace: ReadonlySet<string>;
  selected: string | null;
  labelsOf: (paper: ResultPaper) => Record<string, NodeLabel>;
  /** A node in the space chosen here: chosen in the graph too, and brought into view. */
  onPick: (id: string) => void;
  /** A paper or a block put into the space from here, without dragging. */
  onAdd: (id: string) => void;
  onClose?: () => void;
  className?: string;
}

/** A row that drags its node into the graph (dnd-kit: the research space's DndContext takes it). */
const Draggable: React.FC<{ id: string; title: string; className: string; children: React.ReactNode }> = ({ id, title, className, children }) => {
  const drag = useDraggable({ id: `node:${id}` });
  return (
    <div ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners} title={title} className={`${className} ${drag.isDragging ? 'opacity-40' : ''}`}>
      {children}
    </div>
  );
};

/**
 * The account's folders and papers beside the full-screen research space, each paper opening to its blocks (text,
 * figures, tables): any of them dragged onto the graph goes into the space, under the node it is dropped on.
 */
const SpaceLibrary: React.FC<Props> = ({ login, papers, organizer, inSpace, selected, labelsOf, onPick, onAdd, onClose, className = '' }) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const wanted = query.trim().toLowerCase();
  // The papers as the list of papers has them: in their folders, archived ones left out.
  const rows = useMemo(() => papers.map((paper) => ({ key: paperKey(login, paper.id), mine: true, title: paper.title, venue: paper.venue, paper })), [papers, login]);
  const lines = useMemo(() => tree(organizer, inView(organizer, rows, { kind: 'mine' }), { base: null, closed, empty: false, order: { by: 'title', up: true } }), [organizer, rows, closed]);

  const flip = (set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    set((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const row = 'group flex min-w-0 cursor-grab touch-pan-y select-none items-center gap-1.5 rounded-lg py-1 pr-1 text-[13px] transition-colors duration-150 active:cursor-grabbing';
  const look = (id: string) => (selected === id ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-gray-700 hover:bg-black/[0.04]');
  /** The end of a row: a mark when the node is in the space, else a button that puts it in. */
  const end = (id: string) =>
    inSpace.has(id) ? (
      <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" title={t('已经在空间里')} />
    ) : (
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onAdd(id);
        }}
        aria-label={t('放进空间')}
        title={t('放进空间')}
        className="ml-auto shrink-0 rounded p-0.5 text-gray-400 opacity-0 hover:bg-black/[0.06] hover:text-violet-700 focus:opacity-100 group-hover:opacity-100"
      >
        <Plus size={13} />
      </button>
    );

  const blockRows = (paper: ResultPaper, indent: number, only?: (label: NodeLabel | undefined) => boolean) => {
    const labels = labelsOf(paper);
    return paper.blocks.flatMap((block) => {
      const label = labels[block.id];
      if (only && !only(label)) return [];
      const id = blockNode(paper.id, block.id);
      const Icon = KIND_ICON[block.kind];
      return [
        <Draggable key={id} id={id} title={inSpace.has(id) ? (label?.title ?? '') : t('拖到图里的一个节点上，就挂到它下面')} className={`${row} ${look(id)}`}>
          <span style={{ width: indent }} className="shrink-0" />
          <Icon size={13} className={`shrink-0 ${block.kind === 'text' ? 'text-gray-400' : 'text-violet-500'}`} aria-hidden="true" />
          <span onClick={() => inSpace.has(id) && onPick(id)} className="min-w-0 truncate">
            {label?.title ?? block.id}
            {block.kind !== 'text' && label?.detail && <span className="text-gray-400"> {label.detail}</span>}
            {only && <span className="block truncate text-[11.5px] text-gray-400">{paper.title}</span>}
          </span>
          {end(id)}
        </Draggable>,
      ];
    });
  };

  const paperRow = (paper: ResultPaper, depth: number) => {
    const opened = open.has(paper.id);
    return (
      <div key={paper.id}>
        <Draggable id={paper.id} title={inSpace.has(paper.id) ? paper.title : t('拖到图里的一个节点上，就挂到它下面')} className={`${row} ${look(paper.id)}`}>
          <span style={{ width: depth * 14 }} className="shrink-0" />
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => flip(setOpen, paper.id)}
            aria-expanded={opened}
            aria-label={opened ? t('收起') : t('展开')}
            className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-black/[0.06] hover:text-gray-700"
          >
            {opened ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <FileText size={14} className="shrink-0 text-violet-500" aria-hidden="true" />
          <span onClick={() => (inSpace.has(paper.id) ? onPick(paper.id) : flip(setOpen, paper.id))} className="min-w-0 truncate">
            {paper.title}
          </span>
          {end(paper.id)}
        </Draggable>
        {opened && (paper.blocks.length === 0 ? <p className="py-1 text-xs text-gray-400" style={{ paddingLeft: depth * 14 + 44 }}>{t('这篇论文还没有块')}</p> : blockRows(paper, depth * 14 + 30))}
      </div>
    );
  };

  const found = wanted
    ? [
        ...rows.filter((item) => item.title.toLowerCase().includes(wanted)).map((item) => paperRow(item.paper, 0)),
        ...papers.flatMap((paper) => blockRows(paper, 4, (label) => `${label?.title ?? ''} ${label?.detail ?? ''}`.toLowerCase().includes(wanted))),
      ]
    : null;

  return (
    <div className={`flex min-h-0 flex-col rounded-2xl bg-[#f5f5f7] ${className}`}>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
        <p className="text-xs font-medium text-gray-500">{t('论文和其中的块')}</p>
        {onClose && (
          <button type="button" onClick={onClose} aria-label={t('关闭')} className="ml-auto rounded p-0.5 text-gray-400 hover:text-gray-700 lg:hidden">
            <X size={14} />
          </button>
        )}
      </div>
      <label className="mx-2 mb-1.5 flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-2 py-1.5 ring-1 ring-black/[0.06] focus-within:ring-2 focus-within:ring-violet-200">
        <Search size={13} className="shrink-0 text-gray-400" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('找论文，或其中的文字、图、表')} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
      </label>
      <p className="mx-3 mb-1 flex shrink-0 items-center gap-1 text-[11.5px] text-gray-400">
        <GripVertical size={12} aria-hidden="true" />
        {t('拖到右边的图里')}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {found
          ? found.length > 0
            ? found
            : <p className="py-6 text-center text-xs text-gray-400">{t('没有找到')}</p>
          : lines.map((line) =>
              line.kind === 'folder' ? (
                <button
                  key={`folder:${line.folder.id}`}
                  type="button"
                  onClick={() => flip(setClosed, line.folder.id)}
                  aria-expanded={line.open}
                  className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-1 text-left text-[13px] font-medium text-gray-700 hover:bg-black/[0.04]"
                >
                  <span style={{ width: line.depth * 14 }} className="shrink-0" />
                  {line.open ? <ChevronDown size={13} className="shrink-0 text-gray-400" /> : <ChevronRight size={13} className="shrink-0 text-gray-400" />}
                  {line.open ? <FolderOpen size={14} className="shrink-0 text-violet-500" /> : <Folder size={14} className="shrink-0 text-violet-500" />}
                  <span className="min-w-0 truncate">{line.folder.name}</span>
                  <span className="ml-auto shrink-0 text-[11.5px] font-normal tabular-nums text-gray-400">{line.count}</span>
                </button>
              ) : (
                paperRow(line.paper.paper, line.depth)
              ),
            )}
        {!found && lines.length === 0 && <p className="py-6 text-center text-xs text-gray-400">{t('这里还没有论文')}</p>}
      </div>
    </div>
  );
};

export default SpaceLibrary;
