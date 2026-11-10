import React, { useEffect, useRef, useState } from 'react';
import { Check, Upload } from 'lucide-react';
import { openPdf } from '../../components/results/pdfjs';
import { useT } from '../../lib/phrases/app';

/** The pictures a figure can show. */
export const IMAGE_TYPES = ['.pdf', '.png', '.jpg', '.jpeg'];

/** ".png" for "a/b.PNG"; "" for no extension. */
export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
};

/** Whether an attachment is the file a graphic names: the same name with or without its extension, or found by \graphicspath. */
export const samePicture = (name: string, path: string): boolean => {
  const bare = (value: string) => value.trim().replace(/^\.\//, '').replace(/\.[A-Za-z0-9]+$/, '');
  return bare(name) === bare(path) || bare(name).endsWith(`/${bare(path)}`);
};

/** A small picture of an image attachment: the image itself, or a PDF's first page. */
export const PictureThumb: React.FC<{ name: string; data: Uint8Array }> = ({ name, data }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const pdf = extensionOf(name) === '.pdf';
  useEffect(() => {
    if (pdf) return undefined;
    const made = URL.createObjectURL(new Blob([data.slice()], { type: extensionOf(name) === '.png' ? 'image/png' : 'image/jpeg' }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [name, data, pdf]);
  useEffect(() => {
    const target = canvas.current;
    if (!pdf || !target) return undefined;
    let cancelled = false;
    let task: Awaited<ReturnType<typeof openPdf>> | null = null;
    void (async () => {
      task = await openPdf({ data: data.slice() });
      const page = await (await task.promise).getPage(1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      const view = page.getViewport({ scale: Math.min(40 / base.width, 30 / base.height) * ratio });
      target.width = Math.floor(view.width);
      target.height = Math.floor(view.height);
      await page.render({ canvas: target, viewport: view }).promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data, pdf]);
  return (
    <span className="flex h-[30px] w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-black/[0.08] bg-white">
      {pdf ? <canvas ref={canvas} className="max-h-full max-w-full" /> : url && <img src={url} alt="" className="max-h-full max-w-full object-contain" />}
    </span>
  );
};

interface Props {
  /** The file name the figure's graphic gives now. */
  path: string;
  /** Where the list opens, in the window. */
  left: number;
  top: number;
  /** The paper's pictures, and the attachments' bytes for their thumbnails. */
  names: string[];
  attachments: Record<string, Uint8Array>;
  onChoose: (name: string) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
}

/** The paper's pictures, beside the figure clicked; choosing one puts it in the figure at the same width. */
const PicturePicker: React.FC<Props> = ({ path, left, top, names, attachments, onChoose, onUpload, onClose }) => {
  const t = useT();
  const upload = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The wheel over the box scrolls its list only, never the page behind once the list ends; off the box (on the
  // layer that closes it) it scrolls the page.
  useEffect(() => {
    const box = dialog.current;
    if (!box) return undefined;
    const wheel = (event: WheelEvent) => {
      const scroller = list.current;
      event.preventDefault();
      if (scroller && scroller.contains(event.target as Node)) scroller.scrollTop += event.deltaY;
    };
    box.addEventListener('wheel', wheel, { passive: false });
    return () => box.removeEventListener('wheel', wheel);
  }, []);
  return (
    <div className="fixed inset-0 z-[95]" onMouseDown={onClose} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div
        ref={dialog}
        role="dialog"
        aria-label={t('换图片')}
        className="absolute w-[17rem] rounded-xl border border-black/[0.08] bg-white p-1.5 text-[13px] text-gray-800 shadow-[0_10px_28px_rgba(0,0,0,0.18)]"
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="px-2 pb-1.5 pt-1 text-xs text-gray-500">{t('图片文件')}</p>
        <div ref={list} className="max-h-72 overflow-y-auto overscroll-contain">
          {names.map((name) => {
            const current = samePicture(name, path);
            return (
              <button
                key={name}
                type="button"
                autoFocus={current}
                onClick={() => (current ? onClose() : onChoose(name))}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors duration-150 ${current ? 'bg-violet-50' : 'hover:bg-black/[0.04]'}`}
              >
                {attachments[name] && <PictureThumb name={name} data={attachments[name]} />}
                <span className="min-w-0 flex-1 truncate" title={name}>
                  {name}
                </span>
                {current && <Check size={14} className="shrink-0 text-violet-700" />}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => upload.current?.click()}
          className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-black/[0.05] px-2 pb-1 pt-2 text-left text-violet-700 hover:bg-violet-50"
        >
          <Upload size={14} />
          {t('上传新图片…')}
        </button>
        <input
          ref={upload}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          className="hidden"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = '';
            if (chosen) onUpload(chosen);
          }}
        />
      </div>
    </div>
  );
};

export default PicturePicker;
