/** The writing view's columns: how wide the file list is (or whether it is folded away) and how the code and the PDF share the rest. */
import React, { RefObject, useCallback, useEffect, useState } from 'react';

export interface Panes {
  /** The file list's width in pixels. */
  side: number;
  /** Whether the file list is shown. */
  sideOpen: boolean;
  /** The code's share of the width the code and the PDF have together. */
  split: number;
}

const KEY = 'onizukatex-writing-panes';
export const DEFAULT_PANES: Panes = { side: 224, sideOpen: true, split: 0.5 };
export const SIDE_MIN = 160;
export const SIDE_MAX = 480;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Panes read back as stored, with anything missing or out of range put right. */
export function readPanes(text: string | null): Panes {
  try {
    const stored = JSON.parse(text ?? '{}') as Partial<Panes>;
    return {
      side: typeof stored.side === 'number' ? clamp(stored.side, SIDE_MIN, SIDE_MAX) : DEFAULT_PANES.side,
      sideOpen: typeof stored.sideOpen === 'boolean' ? stored.sideOpen : DEFAULT_PANES.sideOpen,
      split: typeof stored.split === 'number' ? clamp(stored.split, SPLIT_MIN, SPLIT_MAX) : DEFAULT_PANES.split,
    };
  } catch {
    return DEFAULT_PANES;
  }
}

/** The columns as last left in this browser, kept for next time. */
export function usePanes(): [Panes, (change: Partial<Panes>) => void] {
  const [panes, setPanes] = useState<Panes>(() => {
    try {
      return readPanes(localStorage.getItem(KEY));
    } catch {
      return DEFAULT_PANES;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(panes));
    } catch {
      // Without storage the columns are simply as they start next time.
    }
  }, [panes]);
  const change = useCallback(
    (next: Partial<Panes>) =>
      setPanes((current) => ({
        side: clamp(next.side ?? current.side, SIDE_MIN, SIDE_MAX),
        sideOpen: next.sideOpen ?? current.sideOpen,
        split: clamp(next.split ?? current.split, SPLIT_MIN, SPLIT_MAX),
      })),
    [],
  );
  return [panes, change];
}

/** An element's width in pixels, as it changes. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * A line between two columns that is dragged to move it: `onMove` gets the pointer's x in the window each time it
 * moves. A double click puts it back.
 */
export const Divider: React.FC<{ onMove: (clientX: number) => void; onReset: () => void; label: string; className?: string }> = ({ onMove, onReset, label, className = '' }) => {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return undefined;
    // Text is not selected and the cursor stays the same while the pointer crosses the code and the pages.
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => dragging && onMove(event.clientX)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={onReset}
      className={`group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize touch-none ${className}`}
    >
      <div className={`mx-auto h-full w-px transition-colors ${dragging ? 'bg-violet-500' : 'bg-black/[0.06] group-hover:bg-violet-400'}`} />
    </div>
  );
};
