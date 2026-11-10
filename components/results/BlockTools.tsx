import React, { useEffect, useState } from 'react';
import { ArrowLeftRight, Check, Copy, Eye, EyeOff, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { exportTex } from '../../editor/results/texNames';
import { N_ } from '../../lib/i18n';
import { useT } from '../../lib/phrases/site';
import { ResultBlock } from '../../types';
import { AddButton, PILL, useEditMode } from '../EditMode';
import { avatarUrl, usePresence } from '../presence';

// Translated where shown.
export const KIND_LABEL = { text: N_('文字'), figure: N_('图'), table: N_('表格') } as const;
export const EDIT_LABEL = { text: N_('编辑文字'), figure: N_('编辑图'), table: N_('编辑表格') } as const;

export const InsertButtons: React.FC<{ paperId: string; afterBlockId?: string }> = ({ paperId, afterBlockId }) => {
  const t = useT();
  return (
    <>
      <AddButton request={{ kind: 'block', paperId, blockKind: 'text', afterBlockId }} text={t('文字')} />
      <AddButton request={{ kind: 'block', paperId, blockKind: 'figure', afterBlockId }} text={t('图')} />
      <AddButton request={{ kind: 'block', paperId, blockKind: 'table', afterBlockId }} text={t('表格')} />
    </>
  );
};

/**
 * A block's tool: its icon, and its words beside it while the pointer is on it or it has the keyboard's focus
 * (or `open`, to show a result such as "Copied"). Where nothing can hover, the icon stays alone with its title.
 */
export const ToolButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
  onBlur?: () => void;
  open?: boolean;
  danger?: boolean;
  /** Red all over: the next click does what cannot be undone here. */
  alarm?: boolean;
}> = ({ icon, label, title, onClick, onBlur, open = false, danger = false, alarm = false }) =>
  React.useContext(InMenu) ? (
    // A row of a block's menu: its icon and its words, always.
    <button
      type="button"
      onClick={onClick}
      onBlur={onBlur}
      title={title ?? label}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-150 ${
        alarm ? 'bg-red-50 text-red-700' : danger ? 'text-gray-700 hover:bg-red-50 hover:text-red-700' : 'text-gray-700 hover:bg-black/[0.05]'
      }`}
    >
      <span className="shrink-0 text-gray-500">{icon}</span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  ) : (
  <button
    type="button"
    onClick={onClick}
    onBlur={onBlur}
    title={title ?? label}
    aria-label={label}
    className={`group/tool inline-flex h-8 items-center rounded-full border px-2 text-xs shadow-sm transition-colors duration-150 ${
      alarm
        ? 'border-red-300 bg-red-50 text-red-700'
        : `border-gray-300 bg-white text-gray-600 ${danger ? 'hover:border-red-300 hover:text-red-700' : 'hover:border-purple-300 hover:text-purple-700'}`
    }`}
  >
    {icon}
    <span
      className={`overflow-hidden whitespace-nowrap transition-all duration-150 motion-reduce:transition-none ${
        open ? 'ml-1 max-w-[10rem] opacity-100' : 'max-w-0 opacity-0 group-hover/tool:ml-1 group-hover/tool:max-w-[10rem] group-hover/tool:opacity-100 group-focus-visible/tool:ml-1 group-focus-visible/tool:max-w-[10rem] group-focus-visible/tool:opacity-100'
      }`}
    >
      {label}
    </span>
  </button>
  );

/** Closes a block's menu on a click outside it and its handle, or on Escape. */
export function useBlockMenuClose(menu: string | null, setMenu: (value: string | null) => void): void {
  useEffect(() => {
    if (!menu) return undefined;
    const down = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest?.('[data-block-menu], [data-block-grip]')) setMenu(null);
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(null);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [menu, setMenu]);
}

/** Tools drawn inside a block's menu take the shape of its rows. */
const InMenu = React.createContext(false);

/**
 * A block's menu, opened from its handle beside the article: what can be done with it, and blocks to insert after
 * it. Placed by the caller (`style`), over the page.
 */
export const BlockMenu: React.FC<{ paperId: string; block: ResultBlock; published: boolean; onComment?: () => void; style: React.CSSProperties }> = ({
  paperId,
  block,
  published,
  onComment,
  style,
}) => {
  const t = useT();
  return (
    <div
      data-page-control
      data-block-menu
      role="menu"
      aria-label={t('这一块的操作')}
      className="absolute z-[30] w-max min-w-[11rem] rounded-xl border border-black/[0.08] bg-white p-1 shadow-[0_10px_28px_rgba(0,0,0,0.16)]"
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <InMenu.Provider value>
        <BlockTools paperId={paperId} block={block} published={published} onComment={onComment} />
      </InMenu.Provider>
      <div className="mt-1 border-t border-black/[0.06] px-2.5 pb-1 pt-2 text-[11px] text-gray-400">{t('在当前块下方插入内容')}</div>
      <div className="flex flex-wrap gap-1.5 px-1.5 pb-1.5">
        <InsertButtons paperId={paperId} afterBlockId={block.id} />
      </div>
    </div>
  );
};

/** Copies LaTeX to the clipboard without opening an editor; `pill` matches the labelled edit buttons beside it. */
export const CopyButton: React.FC<{ text: () => string; label: string; title: string; pill?: boolean; className?: string }> = ({
  text,
  label,
  title,
  pill = false,
  className = '',
}) => {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = () => {
    navigator.clipboard.writeText(text()).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  const icon = state === 'copied' ? <Check size={14} /> : <Copy size={14} />;
  const words = { idle: label, copied: t('已复制'), failed: t('复制失败') }[state];
  if (!pill) return <ToolButton icon={icon} label={words} title={title} onClick={copy} open={state !== 'idle'} />;
  return (
    <button type="button" onClick={copy} title={title} className={`${PILL} ${className}`}>
      {icon}
      {words}
    </button>
  );
};

/**
 * Turns a figure into a table, or a table into a figure: straight to the version kept from an earlier turn,
 * or through the editor, starting the other kind with the caption and label kept. The version shown now is kept.
 */
export const ConvertButton: React.FC<{ paperId: string; block: ResultBlock }> = ({ paperId, block }) => {
  const { open, switchBlock } = useEditMode();
  const t = useT();
  if (block.kind !== 'figure' && block.kind !== 'table') return null;
  const to = block.kind === 'figure' ? 'table' : 'figure';
  const kept = block.alternate?.kind === to;
  let title: string;
  if (to === 'table') title = kept ? t('换回之前存下的表格；这张图也会存下，随时可以换回来') : t('把这张图换成表格，保留图题和引用名；这张图会存下，随时可以换回来');
  else title = kept ? t('换回之前存下的图；这张表格也会存下，随时可以换回来') : t('把这张表格换成图，保留图题和引用名；这张表格会存下，随时可以换回来');
  return (
    <ToolButton
      icon={<ArrowLeftRight size={14} />}
      label={to === 'table' ? t('转为表格') : t('转为图')}
      title={title}
      onClick={() => (kept && switchBlock ? switchBlock(paperId, block.id) : open({ kind: 'block', paperId, blockId: block.id, convertTo: to }))}
    />
  );
};

/** Deletes on a second click: the first turns the button red and says so, for a few seconds. */
export const DeleteTool: React.FC<{ onDelete: () => void }> = ({ onDelete }) => {
  const t = useT();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <ToolButton
      icon={<Trash2 size={14} />}
      label={armed ? t('再点一次删除') : t('删除')}
      danger
      alarm={armed}
      open={armed}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onDelete();
      }}
    />
  );
};

/**
 * What can be done with a block while editing, each tool an icon until pointed at: comment, copy its LaTeX,
 * switch a figure and a table, hide or show it, delete it, edit it. `published`: the paper is public, so showing a
 * hidden block publishes it.
 */
export const BlockTools: React.FC<{ paperId: string; block: ResultBlock; published: boolean; onComment?: () => void }> = ({ paperId, block, published, onComment }) => {
  const { open, hideBlock, deleteBlock } = useEditMode();
  const t = useT();
  return (
    <>
      {onComment && <ToolButton icon={<MessageSquarePlus size={14} />} label={t('批注')} title={t('批注这一块')} onClick={onComment} />}
      {block.source && <CopyButton text={() => exportTex(block.source ?? '')} label={t('复制 LaTeX')} title={t('复制 LaTeX 代码（开头注明需要的宏包）')} />}
      <ConvertButton paperId={paperId} block={block} />
      {hideBlock && (
        <ToolButton
          icon={block.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          label={block.hidden ? t('取消隐藏') : t('隐藏')}
          onClick={() => {
            if (block.hidden && published && !window.confirm(t('这篇论文已公开，取消隐藏后这个块会发布到网站。确定吗？'))) return;
            hideBlock(paperId, block.id, !block.hidden);
          }}
        />
      )}
      {deleteBlock && <DeleteTool onDelete={() => deleteBlock(paperId, block.id)} />}
      <ToolButton icon={<Pencil size={14} />} label={t(EDIT_LABEL[block.kind])} onClick={() => open({ kind: 'block', paperId, blockId: block.id })} />
    </>
  );
};

/** The others looking at a block, beside it like collaborators' cursors in Overleaf. */
export const BlockReaders: React.FC<{ blockId: string }> = ({ blockId }) => {
  const presence = usePresence();
  const t = useT();
  const here = presence?.viewers.filter((viewer) => viewer.block === blockId && viewer.login !== presence.me?.login) ?? [];
  if (here.length === 0) return null;
  return (
    // In the right margin: the left one holds the drag handles while editing.
    <div className="absolute z-10 -top-8 right-0 flex gap-1 md:top-0 md:-right-10 md:flex-col" aria-label={t('正在看这一块的人')}>
      {here.map((viewer) => (
        <img
          key={viewer.login}
          src={avatarUrl(viewer.id, 48)}
          alt={viewer.login}
          title={t('@{login} 正在看这里', { login: viewer.login })}
          className="w-6 h-6 rounded-full ring-2 ring-white bg-gray-200 shadow-sm"
        />
      ))}
    </div>
  );
};

