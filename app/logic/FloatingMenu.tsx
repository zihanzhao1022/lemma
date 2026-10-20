import React, { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface MenuChoice {
  key: string;
  icon: LucideIcon;
  /** The icon's colour, as a Tailwind class. */
  tone?: string;
  text: string;
  onPick: () => void;
}

/** Closes a floating menu or picker on a press outside `within` (or `own`) or on Escape. */
export function useDismiss(own: React.RefObject<HTMLElement>, within: React.RefObject<HTMLElement> | undefined, onClose: (() => void) | undefined): void {
  const close = useRef(onClose);
  close.current = onClose;
  const active = onClose !== undefined;
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (event: PointerEvent) => {
      if (!(within ?? own).current?.contains(event.target as Node)) close.current?.();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current?.();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [own, within, active]);
}

/**
 * A small menu over a graph: under a button of its bar, or where the canvas was double-clicked. A press elsewhere
 * or Escape closes it; the first choice has the focus.
 */
const FloatingMenu: React.FC<{
  title: string;
  choices: MenuChoice[];
  onClose: () => void;
  /** Presses in here (the menu and the button that opened it) leave it open; the menu itself when omitted. */
  within?: React.RefObject<HTMLElement>;
  /** Room for long choices (paper titles), cut to one line each. */
  wide?: boolean;
  className?: string;
  style?: React.CSSProperties;
}> = ({ title, choices, onClose, within, wide = false, className = '', style }) => {
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(menu, within, onClose);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label={title}
      className={`z-40 ${wide ? 'w-64' : 'w-36'} max-h-80 overflow-y-auto rounded-xl bg-white p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.08] ${className}`}
      style={style}
    >
      <p className="px-2 pb-0.5 pt-1 text-[11px] text-gray-400">{title}</p>
      {choices.map((choice, index) => {
        const Icon = choice.icon;
        return (
          <button
            key={choice.key}
            type="button"
            role="menuitem"
            autoFocus={index === 0}
            onClick={choice.onPick}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-gray-700 outline-none hover:bg-violet-50 hover:text-violet-800 focus-visible:bg-violet-50 focus-visible:text-violet-800"
          >
            <Icon size={14} className={`shrink-0 ${choice.tone ?? 'text-gray-400'}`} aria-hidden="true" />
            <span className="min-w-0 truncate">{choice.text}</span>
          </button>
        );
      })}
    </div>
  );
};

export default FloatingMenu;
