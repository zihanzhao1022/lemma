import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, StickyNote, X } from 'lucide-react';
import type { ReadFile } from '../../editor/results/actions';
import { useT } from '../../lib/phrases/app';
import { ResultPaper, SlideDeck } from '../../types';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './deck';
import SlideView, { drawPdf } from './SlideView';

interface Props {
  paper: ResultPaper;
  deck: SlideDeck;
  readFile: ReadFile;
  /** The slide to start from (0-based). */
  start: number;
  /** A Beamer deck's compiled PDF: each page is a slide. */
  beamerPdf?: Uint8Array;
  onClose: () => void;
}

/** One page of a Beamer deck's PDF, drawn for the screen's density, in its own shape. */
const PdfSlide: React.FC<{ data: Uint8Array; page: number; width: number }> = ({ data, page, width }) => {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    drawPdf(data, Math.round(width * (window.devicePixelRatio || 1)), page)
      .then((canvas) => {
        if (cancelled || !host.current) return;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        canvas.style.display = 'block';
        host.current.replaceChildren(canvas);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [data, page, width]);
  return <div ref={host} style={{ width, height: (width * SLIDE_HEIGHT) / SLIDE_WIDTH }} />;
};

/**
 * The deck full screen, one slide at a time, as large as the screen allows: arrow keys, space, a click or a tap
 * move on; Esc ends. The slide number shows in a corner, the speaker's notes under the slide when asked for.
 */
const Present: React.FC<Props> = ({ paper, deck, readFile, start, beamerPdf, onClose }) => {
  const t = useT();
  const [pages, setPages] = useState(deck.kind === 'visual' ? deck.slides.length : 0);
  const [at, setAt] = useState(start);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [full, setFull] = useState(Boolean(document.fullscreenElement));
  const [notes, setNotes] = useState(false);

  // A Beamer deck has as many slides as its PDF has pages.
  useEffect(() => {
    if (deck.kind !== 'beamer' || !beamerPdf) return undefined;
    let cancelled = false;
    import('../../components/results/pdfjs')
      .then(({ openPdf }) => openPdf({ data: beamerPdf.slice() }))
      .then(async (task) => {
        try {
          const doc = await task.promise;
          if (!cancelled) setPages(doc.numPages);
        } finally {
          void task.destroy();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deck.kind, beamerPdf]);

  const go = useCallback((step: number) => setAt((current) => Math.max(0, Math.min(pages - 1, current + step))), [pages]);
  // The listeners stay for the whole presentation (setting them up again would leave full screen); they read
  // what changes from here.
  const latest = useRef({ go, onClose, pages });
  latest.current = { go, onClose, pages };

  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      const now = latest.current;
      if (event.key === 'Escape' && !document.fullscreenElement) now.onClose();
      else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) now.go(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(event.key)) now.go(-1);
      else if (event.key === 'Home') setAt(0);
      else if (event.key === 'End') setAt(Math.max(0, now.pages - 1));
      else return;
      event.preventDefault();
    };
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    const onFull = () => setFull(Boolean(document.fullscreenElement));
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFull);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const slide = deck.kind === 'visual' ? deck.slides[Math.min(at, deck.slides.length - 1)] : undefined;
  const shownNotes = notes && slide?.notes ? slide.notes : '';
  const room = { width: size.width, height: size.height - (shownNotes ? 120 : 0) };
  const width = Math.min(room.width, (room.height * SLIDE_WIDTH) / SLIDE_HEIGHT);
  const tool = 'rounded-lg p-2 text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white';

  return (
    <div role="dialog" aria-modal="true" aria-label={t('演示')} className="group fixed inset-0 z-[120] flex select-none flex-col bg-black">
      <div className="flex min-h-0 flex-1 cursor-pointer items-center justify-center" onClick={() => go(1)}>
        {slide && <SlideView slide={slide} paper={paper} readFile={readFile} width={width} />}
        {deck.kind === 'beamer' && beamerPdf && <PdfSlide data={beamerPdf} page={at + 1} width={width} />}
        {deck.kind === 'beamer' && !beamerPdf && <p className="text-sm text-white/60">{t('正在编译幻灯片…')}</p>}
      </div>
      {shownNotes && <p className="h-[120px] shrink-0 overflow-y-auto whitespace-pre-wrap border-t border-white/10 px-8 py-4 text-[15px] leading-relaxed text-white/80">{shownNotes}</p>}
      {/* The controls show when the pointer moves over them. */}
      <div className="absolute right-4 top-4 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        {deck.kind === 'visual' && (
          <button type="button" onClick={() => setNotes((on) => !on)} aria-pressed={notes} aria-label={t('演讲备注')} title={t('演讲备注')} className={tool}>
            <StickyNote size={18} />
          </button>
        )}
        <button
          type="button"
          onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen().catch(() => undefined))}
          aria-label={full ? t('退出全屏') : t('全屏')}
          title={full ? t('退出全屏') : t('全屏')}
          className={tool}
        >
          {full ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
        <button type="button" onClick={onClose} aria-label={t('结束演示')} title={t('结束演示（Esc）')} className={tool}>
          <X size={18} />
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-3 right-5 text-xs tabular-nums text-white/40">{pages > 0 ? `${at + 1} / ${pages}` : ''}</p>
    </div>
  );
};

export default Present;
