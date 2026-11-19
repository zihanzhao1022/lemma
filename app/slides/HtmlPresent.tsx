import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, MonitorUp, Presentation, RotateCcw, X } from 'lucide-react';
import { useT } from '../../lib/phrases/app';
import HtmlFrame, { FrameState, HtmlFrameHandle } from './HtmlFrame';

interface Props {
  /** The deck's page (see deckDocument.ts), once it is made. */
  page?: string;
  onClose: () => void;
}

const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * The audience's window: a shell of this app's own with the deck's page in a sandboxed frame, driven from the
 * speaker's view. Written into a window opened blank, which shares this app's origin: so the deck never runs in it
 * but inside the frame, as everywhere else.
 */
function openAudience(page: string, title: string): { go: (slide: number, step: number) => void; closed: () => boolean; close: () => void } | null {
  const opened = window.open('', 'onizukatex-audience', 'popup,width=1280,height=720');
  if (!opened) return null;
  const doc = opened.document;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><title></title><style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block;background:#fff}</style></head><body></body></html>');
  doc.close();
  doc.title = title;
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', title);
  // The speaker turns the slides: a click here does nothing.
  frame.style.pointerEvents = 'none';
  frame.srcdoc = page;
  doc.body.appendChild(frame);
  let ready = false;
  let wanted: { slide: number; step: number } | null = null;
  const send = () => wanted && frame.contentWindow?.postMessage({ type: 'goto', ...wanted }, '*');
  opened.addEventListener('message', (event) => {
    if (event.source === frame.contentWindow && (event.data as { type?: string })?.type === 'ready') {
      ready = true;
      send();
    }
  });
  return {
    go: (slide, step) => {
      wanted = { slide, step };
      if (ready) send();
    },
    closed: () => opened.closed,
    close: () => opened.close(),
  };
}

/**
 * An HTML deck full screen. The page does the turning (arrow keys, space, a click or a tap move on, Esc ends: it
 * tells this shell) in a frame that cannot reach anything of this app; the shell holds the controls. P switches to
 * the speaker's view: the slide, what the next click shows, the slide's notes and a clock; from there the slides
 * can go to a window of their own for the audience (a projector), which follows the speaker.
 */
const HtmlPresent: React.FC<Props> = ({ page, onClose }) => {
  const t = useT();
  const [full, setFull] = useState(Boolean(document.fullscreenElement));
  const [speaker, setSpeaker] = useState(false);
  const [state, setState] = useState<FrameState | null>(null);
  const [started, setStarted] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [audienceOpen, setAudienceOpen] = useState(false);
  const main = useRef<HtmlFrameHandle>(null);
  const coming = useRef<HtmlFrameHandle>(null);
  const audience = useRef<ReturnType<typeof openAudience>>(null);

  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Keys while the shell itself has the keyboard (before the page does, or after a button was clicked).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) onClose();
      else if (event.key === 'p' || event.key === 'P') setSpeaker((on) => !on);
    };
    const onFull = () => setFull(Boolean(document.fullscreenElement));
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFull);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      audience.current?.close();
    };
  }, [onClose]);

  // The clock of the speaker's view.
  useEffect(() => {
    if (!speaker) return undefined;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (audience.current?.closed()) {
        audience.current = null;
        setAudienceOpen(false);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [speaker]);

  /** What the next click shows: the next step of this slide, or the next slide. */
  const after = (current: FrameState): { slide: number; step: number } | null =>
    current.step < current.steps ? { slide: current.slide, step: current.step + 1 } : current.slide + 1 < current.slides ? { slide: current.slide + 1, step: 0 } : null;

  const follow = useCallback((current: FrameState) => {
    setState(current);
    const next = after(current);
    if (next) coming.current?.go(next.slide, next.step);
    audience.current?.go(current.slide, current.step);
  }, []);

  // The keyboard goes back to the slide after the view changes.
  useEffect(() => {
    main.current?.focus();
  }, [speaker]);

  const tool = 'rounded-lg p-2 text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white';
  const next = state ? after(state) : null;
  return (
    <div role="dialog" aria-modal="true" aria-label={t('演示')} className="group fixed inset-0 z-[120] flex select-none flex-col bg-black">
      {page ? (
        <div className={speaker ? 'grid h-full grid-cols-[minmax(0,3fr)_minmax(0,2fr)] grid-rows-[minmax(0,1fr)_auto] gap-4 p-5 text-white' : 'h-full w-full'}>
          <div className={speaker ? 'flex min-h-0 items-center justify-center' : 'h-full w-full'}>
            <div className={speaker ? 'relative w-full' : 'h-full w-full'} style={speaker ? { aspectRatio: '16 / 9', maxHeight: '100%' } : undefined}>
              <HtmlFrame
                ref={main}
                html={page}
                title={t('演示')}
                autoFocus
                onState={follow}
                onClose={onClose}
                onPresenterKey={() => setSpeaker((on) => !on)}
                className={speaker ? 'absolute inset-0 h-full w-full rounded border-0 bg-white' : 'h-full w-full border-0 bg-white'}
              />
            </div>
          </div>
          {speaker && (
            <div className="row-span-2 flex min-h-0 flex-col gap-4">
              <p className="text-xs uppercase tracking-[0.12em] text-white/50">{t('接下来')}</p>
              <div className="relative w-full shrink-0 overflow-hidden rounded bg-white" style={{ aspectRatio: '16 / 9' }}>
                <HtmlFrame ref={coming} html={page} title={t('接下来')} onReady={() => next && coming.current?.go(next.slide, next.step)} className="pointer-events-none absolute inset-0 h-full w-full border-0" />
                {!next && <p className="absolute inset-0 flex items-center justify-center bg-black text-sm text-white/60">{t('这是最后一页')}</p>}
              </div>
              <p className="text-xs uppercase tracking-[0.12em] text-white/50">{t('备注')}</p>
              <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[17px] leading-relaxed text-white/90">
                {state?.notes || <span className="text-white/40">{t('这一页没有备注：写在幻灯片的 <aside class="notes"> 里。')}</span>}
              </div>
            </div>
          )}
          {speaker && (
            <div className="flex items-center gap-4 text-sm tabular-nums text-white/80">
              <span className="text-2xl font-medium text-white">{clock(now - started)}</span>
              <button type="button" onClick={() => { setStarted(Date.now()); setNow(Date.now()); }} title={t('计时从头开始')} aria-label={t('计时从头开始')} className={tool}>
                <RotateCcw size={16} />
              </button>
              <span>{state ? t('第 {n} / {m} 页', { n: state.slide + 1, m: state.slides }) : ''}</span>
              {state && state.steps > 0 && <span className="text-white/50">{t('步骤 {n} / {m}', { n: state.step, m: state.steps })}</span>}
              <span className="text-white/50">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <button
                type="button"
                onClick={() => {
                  if (audience.current && !audience.current.closed()) {
                    audience.current.close();
                    audience.current = null;
                    setAudienceOpen(false);
                  } else if (page) {
                    audience.current = openAudience(page, t('演示'));
                    setAudienceOpen(Boolean(audience.current));
                    if (state) audience.current?.go(state.slide, state.step);
                  }
                  main.current?.focus();
                }}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-[13px] text-white/90 transition-colors duration-150 hover:bg-white/10"
              >
                <MonitorUp size={15} />
                {audienceOpen ? t('关掉听众的窗口') : t('在另一个窗口放给听众')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="m-auto text-sm text-white/60">{t('正在准备幻灯片…')}</p>
      )}
      {/* The controls show when the pointer moves over them. */}
      <div className="absolute right-4 top-4 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <button type="button" onClick={() => setSpeaker((on) => !on)} aria-pressed={speaker} aria-label={t('演讲者视图（P）')} title={t('演讲者视图（P）')} className={tool}>
          <Presentation size={18} />
        </button>
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
    </div>
  );
};

export default HtmlPresent;
