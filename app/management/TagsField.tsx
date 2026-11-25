import React, { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { tagsOfMark } from '../../editor/results/ops';
import { useT } from '../../lib/phrases/app';
import { ResultMark } from '../../types';
import { MARK_COLORS } from '../space/MarkEditor';

/** A figure or table's colour and tags on its card: a dot, then each tag. */
export const MarkChips: React.FC<{ mark?: ResultMark }> = ({ mark }) => {
  const tags = tagsOfMark(mark);
  if (tags.length === 0 && !mark?.color) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {mark?.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: mark.color }} />}
      {tags.map((tag) => (
        <span key={tag} className="max-w-[9rem] truncate rounded-full bg-white px-1.5 text-xs text-gray-700 ring-1 ring-black/[0.06]">
          {tag}
        </span>
      ))}
    </span>
  );
};

interface Props {
  mark: ResultMark | undefined;
  onChange: (mark: ResultMark) => void;
  /** Tags given elsewhere in the library, offered to add with a click. */
  known: string[];
}

/**
 * A colour (as in the research space: a few, any other, none) and any number of tags: typed and added with Enter
 * or a comma, taken away with their cross or Backspace in the empty box, or added from those used elsewhere.
 */
const TagsField: React.FC<Props> = ({ mark, onChange, known }) => {
  const t = useT();
  const [typed, setTyped] = useState('');
  const tags = tagsOfMark(mark);
  const color = mark?.color;
  const custom = color && !MARK_COLORS.includes(color);
  const set = (next: string[]) => onChange({ ...(color ? { color } : {}), tags: [...new Set(next.map((tag) => tag.trim()).filter(Boolean))] });
  const add = (text: string) => {
    const words = text.split(/[,\uff0c]/).map((word) => word.trim()).filter(Boolean);
    if (words.length > 0) set([...tags, ...words]);
    setTyped('');
  };
  const offered = known.filter((tag) => !tags.includes(tag) && tag.toLowerCase().includes(typed.trim().toLowerCase())).slice(0, 12);
  const swatch = 'relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-offset-1 transition-transform duration-100 hover:scale-110';
  const paint = (value: string | undefined) => onChange({ ...(value ? { color: value } : {}), tags });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('颜色')}>
        <button
          type="button"
          role="radio"
          aria-checked={!color}
          onClick={() => paint(undefined)}
          title={t('默认颜色')}
          aria-label={t('默认颜色')}
          className={`${swatch} bg-white ring-1 ring-gray-300 ${!color ? '!ring-2 !ring-gray-500' : ''}`}
        >
          <span className="h-px w-3.5 rotate-45 bg-gray-400" />
        </button>
        {MARK_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={color === value}
            onClick={() => paint(value)}
            aria-label={value}
            title={value}
            className={`${swatch} ${color === value ? 'ring-2' : ''}`}
            style={{ backgroundColor: value, ['--tw-ring-color' as string]: value }}
          >
            {color === value && <Check size={12} className="text-white" strokeWidth={3} />}
          </button>
        ))}
        <label
          title={t('自定义颜色')}
          className={`${swatch} cursor-pointer overflow-hidden ${custom ? 'ring-2' : 'ring-1 ring-gray-300'}`}
          style={{
            background: custom ? color : 'conic-gradient(#ef4444, #eab308, #22c55e, #3b82f6, #8b5cf6, #ec4899, #ef4444)',
            ['--tw-ring-color' as string]: custom ? color : undefined,
          }}
        >
          <input
            type="color"
            value={color ?? '#8b5cf6'}
            onChange={(event) => paint(event.target.value.toLowerCase())}
            aria-label={t('自定义颜色')}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
          {custom && <Check size={12} className="pointer-events-none text-white" strokeWidth={3} />}
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-300 px-2 py-1.5 focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-100">
        {tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-0.5 rounded-full bg-violet-50 py-0.5 pl-2 pr-1 text-[13px] text-violet-900">
            {tag}
            <button type="button" onClick={() => set(tags.filter((item) => item !== tag))} aria-label={t('去掉标签 {tag}', { tag })} className="rounded-full p-0.5 text-violet-400 hover:bg-violet-100 hover:text-violet-800">
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          value={typed}
          onChange={(event) => {
            const value = event.target.value;
            if (/[,\uff0c]/.test(value)) add(value);
            else setTyped(value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add(typed);
            } else if (event.key === 'Backspace' && typed === '' && tags.length > 0) set(tags.slice(0, -1));
          }}
          onBlur={() => add(typed)}
          maxLength={24}
          placeholder={tags.length === 0 ? t('输入标签，回车添加，如：主实验、消融、附录') : t('再加一个…')}
          aria-label={t('添加标签')}
          className="min-w-[8rem] flex-1 border-0 p-0 text-[13px] text-gray-800 outline-none focus:ring-0"
        />
      </div>

      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-400">{t('已用过的：')}</span>
          {offered.map((tag) => (
            // Keeping the box focused, so half-typed words are not added as a tag of their own on the way.
            <button key={tag} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { set([...tags, tag]); setTyped(''); }} className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50">
              <Plus size={10} />
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default TagsField;
