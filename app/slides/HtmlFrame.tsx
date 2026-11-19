import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/** Where the deck in the frame is: its slide and step, and how many of each there are. */
export interface FrameState {
  slide: number;
  step: number;
  slides: number;
  /** The steps the shown slide has. */
  steps: number;
}

export interface HtmlFrameHandle {
  /** Shows a slide at a step (both 0-based). */
  go: (slide: number, step: number) => void;
  /** Opens the print dialog for the whole deck (the frame must allow it). */
  print: () => void;
  /** Gives the keyboard to the frame. */
  focus: () => void;
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
const HtmlFrame = forwardRef<HtmlFrameHandle, Props>(function HtmlFrame({ html, title, onState, onReady, onClose, autoFocus, allowPrint, className, style }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ onState, onReady, onClose, autoFocus });
  latest.current = { onState, onReady, onClose, autoFocus };

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = event.data as { type?: string } & Partial<FrameState>;
      if (message?.type === 'state') {
        latest.current.onState?.({ slide: message.slide ?? 0, step: message.step ?? 0, slides: message.slides ?? 0, steps: message.steps ?? 0 });
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
    }),
    [],
  );

  return <iframe ref={frame} title={title} srcDoc={html} sandbox={allowPrint ? 'allow-scripts allow-modals' : 'allow-scripts'} className={className} style={style} />;
});

export default HtmlFrame;
