import React from 'react';
import { Check } from 'lucide-react';
import { useT } from '../../lib/phrases/app';
import { SpaceMark } from '../../types';

/** The colours offered first; any other comes from the colour picker. */
export const MARK_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280'];

interface Props {
  mark: SpaceMark | undefined;
  onChange: (mark: SpaceMark) => void;
  /** What the tag box suggests writing. */
  placeholder: string;
}

/** A colour and a tag for a node or a line of the research space: a few colours, any other, no colour; a short tag. */
const MarkEditor: React.FC<Props> = ({ mark, onChange, placeholder }) => {
  const t = useT();
  const color = mark?.color;
  const custom = color && !MARK_COLORS.includes(color);
  const swatch = 'relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-offset-1 transition-transform duration-100 hover:scale-110';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('颜色')}>
        <button
          type="button"
          role="radio"
          aria-checked={!color}
          onClick={() => onChange({ ...mark, color: undefined })}
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
            onClick={() => onChange({ ...mark, color: value })}
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
            onChange={(event) => onChange({ ...mark, color: event.target.value.toLowerCase() })}
            aria-label={t('自定义颜色')}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
          {custom && <Check size={12} className="pointer-events-none text-white" strokeWidth={3} />}
        </label>
      </div>
      <input
        value={mark?.tag ?? ''}
        onChange={(event) => onChange({ ...mark, tag: event.target.value })}
        maxLength={24}
        placeholder={placeholder}
        aria-label={t('节点标签')}
        className="block w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-800 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
      />
    </div>
  );
};

export default MarkEditor;
