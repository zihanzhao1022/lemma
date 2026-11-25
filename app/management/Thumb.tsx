import React, { useEffect, useRef, useState } from 'react';
import type { ReadFile } from '../../editor/results/actions';
import { useT } from '../../lib/phrases/app';
import { ResultBlock } from '../../types';
import { blockBytes, drawPdf } from '../slides/SlideView';

/** Thumbnails by PDF path; a recompiled block gets a new path. */
const thumbs = new Map<string, Promise<string>>();
const THUMB_WIDTH = 640;

/** A block's compiled PDF as a small picture, drawn once it scrolls near the screen. */
const Thumb: React.FC<{ block: ResultBlock; alt: string; readFile: ReadFile; className?: string }> = ({ block, alt, readFile, className = 'h-44' }) => {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const output = block.output;

  useEffect(() => {
    const element = box.current;
    if (!element || near) return undefined;
    const watch = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setNear(true), { rootMargin: '400px' });
    watch.observe(element);
    return () => watch.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || !output) return undefined;
    let cancelled = false;
    let found = thumbs.get(output.pdf);
    if (!found) {
      found = blockBytes(output.pdf, readFile)
        .then((data) => drawPdf(data, THUMB_WIDTH))
        .then((canvas) => canvas.toDataURL('image/png'));
      thumbs.set(output.pdf, found);
      found.catch(() => thumbs.delete(output.pdf));
    }
    found.then(
      (made) => !cancelled && setUrl(made),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [near, output, readFile]);

  return (
    <div ref={box} className={`flex ${className} items-center justify-center overflow-hidden rounded-lg bg-white p-3 ring-1 ring-black/[0.06]`}>
      {!output ? (
        <span className="text-xs text-gray-400">{t('还没有编译')}</span>
      ) : failed ? (
        <span className="text-xs text-red-500">{t('读取 PDF 失败，请刷新页面重试')}</span>
      ) : url ? (
        <img src={url} alt={alt} className="max-h-full max-w-full object-contain" />
      ) : null}
    </div>
  );
};

export default Thumb;
