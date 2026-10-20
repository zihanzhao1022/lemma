import React, { useMemo, useRef, useState } from 'react';
import { AlignLeft, ChevronDown, ChevronRight, FileText, Image, Lightbulb, Search, Table2 } from 'lucide-react';
import { useT } from '../../lib/phrases/app';
import { ResultBlockKind, ResultPaper } from '../../types';
import { useDismiss } from '../logic/FloatingMenu';
import { NodeLabel } from '../logic/labels';
import { blockNode } from './space';

export const KIND_ICON: Record<ResultBlockKind, typeof AlignLeft> = { text: AlignLeft, figure: Image, table: Table2 };
/** The most a search lists at once. */
const MOST = 60;

interface Props {
  papers: ResultPaper[];
  /** Nodes already in the space: their papers stay to open, and nothing is offered twice. */
  taken: ReadonlySet<string>;
  /** The names of a paper's blocks. */
  labelsOf: (paper: ResultPaper) => Record<string, NodeLabel>;
  /** A paper whose blocks show first, opened: the paper chosen in the graph. */
  first?: string;
  onIdea: () => void;
  /** A paper's or a block's node. */
  onPick: (id: string) => void;
  /** Floating over the graph: a press elsewhere or Escape closes it. */
  onClose?: () => void;
  within?: React.RefObject<HTMLElement>;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * What can go into the research space: a new idea, a paper, or a block of a paper (text, a figure, a table). Each
 * paper opens to list its blocks; a search finds papers by title and blocks by heading or caption.
 */
const NodePicker: React.FC<Props> = ({ papers, taken, labelsOf, first, onIdea, onPick, onClose, within, className = '', style }) => {
  const t = useT();
  const own = useRef<HTMLDivElement>(null);
  useDismiss(own, within, onClose);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set(first ? [first] : []));
  const ordered = useMemo(() => (first ? [...papers.filter((paper) => paper.id === first), ...papers.filter((paper) => paper.id !== first)] : papers), [papers, first]);
  const wanted = query.trim().toLowerCase();

  const row = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none';
  const offered = 'text-gray-700 hover:bg-violet-50 hover:text-violet-800 focus-visible:bg-violet-50 focus-visible:text-violet-800';
  const blockRow = (paper: ResultPaper, blockId: string, kind: ResultBlockKind, label: NodeLabel | undefined, withPaper: boolean, indent: boolean) => {
    const Icon = KIND_ICON[kind];
    return (
      <button key={blockNode(paper.id, blockId)} type="button" onClick={() => onPick(blockNode(paper.id, blockId))} className={`${row} ${offered} ${indent ? 'pl-8' : ''}`}>
        <Icon size={13} className={`shrink-0 ${kind === 'text' ? 'text-gray-400' : 'text-violet-500'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {label?.title ?? blockId}
          {kind !== 'text' && label?.detail && <span className="text-gray-400"> {label.detail}</span>}
          {withPaper && <span className="block truncate text-[11.5px] text-gray-400">{paper.title}</span>}
        </span>
      </button>
    );
  };

  const results = (): React.ReactNode[] => {
    const found: React.ReactNode[] = [];
    for (const paper of ordered) {
      if (found.length >= MOST) break;
      if (!taken.has(paper.id) && paper.title.toLowerCase().includes(wanted)) {
        found.push(
          <button key={paper.id} type="button" onClick={() => onPick(paper.id)} className={`${row} ${offered}`}>
            <FileText size={14} className="shrink-0 text-violet-500" aria-hidden="true" />
            <span className="min-w-0 truncate">{paper.title}</span>
          </button>,
        );
      }
      const labels = labelsOf(paper);
      for (const block of paper.blocks) {
        if (found.length >= MOST) break;
        if (taken.has(blockNode(paper.id, block.id))) continue;
        const label = labels[block.id];
        if (`${label?.title ?? ''} ${label?.detail ?? ''}`.toLowerCase().includes(wanted)) found.push(blockRow(paper, block.id, block.kind, label, true, false));
      }
    }
    return found;
  };

  const tree = (): React.ReactNode[] =>
    ordered.map((paper) => {
      const opened = open.has(paper.id);
      const inSpace = taken.has(paper.id);
      const labels = opened ? labelsOf(paper) : {};
      const blocks = opened ? paper.blocks.filter((block) => !taken.has(blockNode(paper.id, block.id))) : [];
      return (
        <div key={paper.id}>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(paper.id)) next.delete(paper.id);
                  else next.add(paper.id);
                  return next;
                })
              }
              aria-expanded={opened}
              aria-label={opened ? t('收起') : t('展开')}
              title={t('这篇论文里的块')}
              className="shrink-0 rounded p-1 text-gray-400 hover:bg-black/[0.05] hover:text-gray-700"
            >
              {opened ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <button
              type="button"
              disabled={inSpace}
              onClick={() => onPick(paper.id)}
              title={inSpace ? t('已经在空间里') : undefined}
              className={`${row} min-w-0 flex-1 pl-1 ${inSpace ? 'cursor-default text-gray-400' : offered}`}
            >
              <FileText size={14} className={`shrink-0 ${inSpace ? 'text-gray-300' : 'text-violet-500'}`} aria-hidden="true" />
              <span className="min-w-0 truncate">{paper.title}</span>
              {inSpace && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />}
            </button>
          </div>
          {opened && blocks.length === 0 && <p className="py-1 pl-8 text-xs text-gray-400">{t('这篇论文的块都已经在空间里了')}</p>}
          {blocks.map((block) => blockRow(paper, block.id, block.kind, labels[block.id], false, true))}
        </div>
      );
    });

  const listed = wanted ? results() : tree();
  return (
    <div ref={own} className={`z-40 w-72 rounded-xl bg-white p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.08] ${className}`} style={style}>
      <label className="m-1 flex items-center gap-1.5 rounded-lg border border-gray-300 px-2 py-1.5 focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-100">
        <Search size={13} className="shrink-0 text-gray-400" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('找论文，或其中的文字、图、表')}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </label>
      <div className="max-h-72 overflow-y-auto">
        {!wanted && (
          <button type="button" onClick={onIdea} className={`${row} ${offered}`}>
            <Lightbulb size={14} className="shrink-0 text-gray-400" aria-hidden="true" />
            {t('新想法')}
          </button>
        )}
        {listed}
        {wanted && listed.length === 0 && <p className="px-2 py-3 text-center text-xs text-gray-400">{t('没有找到')}</p>}
      </div>
    </div>
  );
};

export default NodePicker;
