import React, { useEffect, useState } from 'react';
import { Maximize, Minimize, X } from 'lucide-react';
import { useT } from '../../lib/phrases/app';
import HtmlFrame from './HtmlFrame';

interface Props {
  /** The deck's page (see deckDocument.ts), once it is made. */
  page?: string;
  onClose: () => void;
}

/**
 * An HTML deck full screen. The page does the turning (arrow keys, space, a click or a tap move on, Esc ends: it
 * tells this shell) in a frame that cannot reach anything of this app; the shell only holds the controls.
 */
const HtmlPresent: React.FC<Props> = ({ page, onClose }) => {
  const t = useT();
  const [full, setFull] = useState(Boolean(document.fullscreenElement));

  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Escape while the shell itself has the keyboard (before the page does).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) onClose();
    };
    const onFull = () => setFull(Boolean(document.fullscreenElement));
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFull);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);

  const tool = 'rounded-lg p-2 text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white';
  return (
    <div role="dialog" aria-modal="true" aria-label={t('演示')} className="group fixed inset-0 z-[120] flex select-none flex-col bg-black">
      {page ? (
        <HtmlFrame html={page} title={t('演示')} autoFocus onClose={onClose} className="h-full w-full border-0 bg-white" />
      ) : (
        <p className="m-auto text-sm text-white/60">{t('正在准备幻灯片…')}</p>
      )}
      {/* The controls show when the pointer moves over them. */}
      <div className="absolute right-4 top-4 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
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
