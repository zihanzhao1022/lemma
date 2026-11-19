import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/** Where the deck in the frame is: its slide and step, and how many of each there are. */
export interface FrameState {
  slide: number;
  step: number;
  slides: number;
  /** The steps the shown slide has. */
  steps: number;
  /** The text of the shown slide's <aside class="notes">, for the speaker. */
  notes: string;
  /** Every slide is shown at once. */
  overview: boolean;
}

/** A slide whose layout is wrong: something spills over it or its content area, or runs into its title or foot. */
export interface SlideProblem {
  slide: number;
  kinds: ('overflow' | 'overlap')[];
}

export interface HtmlFrameHandle {
  /** Shows a slide at a step (both 0-based). */
  go: (slide: number, step: number) => void;
  /** Opens the print dialog for the whole deck (the frame must allow it). */
  print: () => void;
  /** Gives the keyboard to the frame. */
  focus: () => void;
  /** Shows every slide at once, or the one slide again. */
  overview: (on: boolean) => void;
}

interface Props {
  /** The whole page (see deckDocument.ts). A new page loads again from its start. */
  html: string;
  title: string;
  onState?: (state: FrameState) => void;
  /** The page loaded and its runtime is listening. */
  onReady?: () => void;
  /** Escape was pressed inside the page. */
  onClose?: () => void;
  /** What the page found wrong with its slides' layout, when it loaded. */
  onProblems?: (problems: SlideProblem[]) => void;
  /** A slide was clicked in the overview of the editor's preview. */
  onPick?: (slide: number) => void;
  /** P was pressed inside the page (the speaker's view). */
  onPresenterKey?: () => void;
  /** Takes the keyboard when the page loads, so the arrow keys turn the slides at once. */
  autoFocus?: boolean;
  /** The page may open the print dialog. */
  allowPrint?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * A deck's page in a frame that cannot reach anything of this app: scripts may run in it (the runtime's, which is all
 * the page's content security policy lets run) but it has no origin of its own to speak of, so no storage, no
 * cookies, no way to the parent but messages. Its markup can come from anywhere.
 */
const HtmlFrame = forwardRef<HtmlFrameHandle, Props>(function HtmlFrame({ html, title, onState, onReady, onClose, onProblems, onPick, onPresenterKey, autoFocus, allowPrint, className, style }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ onState, onReady, onClose, onProblems, onPick, onPresenterKey, autoFocus });
  latest.current = { onState, onReady, onClose, onProblems, onPick, onPresenterKey, autoFocus };

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      // What the page says is data: numbers and text are read as such, nothing else.
      const message = event.data as { type?: string; key?: unknown; slides?: unknown } & Partial<Omit<FrameState, 'slides'>>;
      const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      if (message?.type === 'state') {
        latest.current.onState?.({
          slide: number(message.slide),
          step: number(message.step),
          slides: number(message.slides),
          steps: number(message.steps),
          notes: typeof message.notes === 'string' ? message.notes : '',
          overview: message.overview === true,
        });
      } else if (message?.type === 'problems' && Array.isArray(message.slides)) {
        const kinds = ['overflow', 'overlap'] as const;
        latest.current.onProblems?.(
          (message.slides as { slide?: unknown; kinds?: unknown }[]).map((item) => ({
            slide: number(item?.slide),
            kinds: kinds.filter((kind) => Array.isArray(item?.kinds) && item.kinds.includes(kind)),
          })),
        );
      } else if (message?.type === 'pick') {
        latest.current.onPick?.(number(message.slide));
      } else if (message?.type === 'key' && message.key === 'p') {
        latest.current.onPresenterKey?.();
      } else if (message?.type === 'ready') {
        if (latest.current.autoFocus) frame.current.contentWindow?.focus();
        latest.current.onReady?.();
      } else if (message?.type === 'close') {
        latest.current.onClose?.();
      }
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      go: (slide, step) => frame.current?.contentWindow?.postMessage({ type: 'goto', slide, step }, '*'),
      print: () => frame.current?.contentWindow?.postMessage({ type: 'print' }, '*'),
      focus: () => frame.current?.contentWindow?.focus(),
      overview: (on) => frame.current?.contentWindow?.postMessage({ type: 'overview', on }, '*'),
    }),
    [],
  );

  return <iframe ref={frame} title={title} srcDoc={html} sandbox={allowPrint ? 'allow-scripts allow-modals' : 'allow-scripts'} className={className} style={style} />;
});

export default HtmlFrame;
