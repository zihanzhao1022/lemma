import React, { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadFile, fileName } from '../../lib/download';
import { useT } from '../../lib/phrases/site';
import { publicFilePath } from '../../lib/results';
import { ResultPaper } from '../../types';
import { PILL } from '../EditMode';
import { readsPrivately, useResultsAccess } from './access';

/** A file of the site's published copies. */
async function published(path: string): Promise<Uint8Array> {
  const response = await fetch(publicFilePath(path));
  if (!response.ok) throw new Error(String(response.status));
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Downloads the paper typeset as one article: the PDF stored with its last save, the one readers see (hidden
 * blocks left out). Whoever edits gets it only once it holds what the blocks say now.
 */
export const PdfButton: React.FC<{ paper: ResultPaper; editing: boolean; className?: string }> = ({ paper, editing, className = '' }) => {
  const t = useT();
  const access = useResultsAccess();
  const [state, setState] = useState<'idle' | 'loading' | 'stale' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle' || state === 'loading') return undefined;
    const timer = setTimeout(() => setState('idle'), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  const article = paper.article;
  if (!article) return null;

  const save = async () => {
    setState('loading');
    try {
      if (editing) {
        // Loaded here so readers' pages never carry the editor's code.
        const { articleHash } = await import('../../editor/results/article');
        if (articleHash(paper) !== article.inputHash) {
          setState('stale');
          return;
        }
      }
      const bytes = readsPrivately(access, paper.id) && access ? await access.readFile(article.pdf) : await published(article.pdf);
      downloadFile(bytes, fileName(paper.title, 'pdf'), 'application/pdf');
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  const words = { idle: t('导出 PDF'), loading: t('导出 PDF'), stale: t('整篇 PDF 还没按最新的内容排好，稍后再试'), failed: t('下载失败') }[state];
  return (
    <button
      type="button"
      onClick={() => void save()}
      disabled={state === 'loading'}
      title={t('下载整篇论文排版后的 PDF，不含隐藏的块')}
      className={`${PILL} ${className}`}
    >
      {state === 'loading' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      {words}
    </button>
  );
};
