import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileCode2, LayoutTemplate, Loader2, Play, Presentation as SlidesIcon, RotateCcw } from 'lucide-react';
import { describeSaveError } from '../../editor/backend';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import type { ReadFile } from '../../editor/results/actions';
import { resultsCommitMessage } from '../../editor/results/ops';
import { blockNumber } from '../../lib/headings';
import { useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultPaper, SlideDeck } from '../../types';
import Menu, { MenuItem } from '../Menu';
import { compileBeamer } from './beamer';
import { beamerDeck, visualDeck } from './deck';
import { withLatestLogic } from '../logic/latest';
import { changedDeck, deckOf, savedDeck } from './latest';

const SlidesEditor = lazy(() => import('./SlidesEditor'));
const BeamerEditor = lazy(() => import('./BeamerEditor'));

interface Props {
  paper: ResultPaper;
  readFile: ReadFile;
  onSave: ResultsSave;
  /** Where the view starts, under the paper's bar. */
  top: number;
  visible: boolean;
  /** Whether the editor's keys work: off while the view is hidden or the deck is presented over it. */
  active: boolean;
  /** Presents the deck from a slide (a Beamer deck with its compiled PDF). */
  onPresent: (deck: SlideDeck, start: number, beamerPdf?: Uint8Array) => void;
}

type Status = 'saved' | 'changed' | 'saving' | 'failed';

/**
 * A paper's slides: chosen as drawn (visual) or written (Beamer) the first time, then edited here, saved a
 * moment after each change (and when the view goes away), presented from the slide on screen, and exported as
 * PDF or PowerPoint.
 */
const SlidesMode: React.FC<Props> = ({ paper, readFile, onSave, top, visible, active, onPresent }) => {
  const t = useT();
  const [deck, setDeck] = useState<SlideDeck | null>(() => deckOf(paper));
  const [current, setCurrent] = useState(0);
  // A deck changed here whose save had not landed when the view opened (or failed) is saved again.
  const [status, setStatus] = useState<Status>(() => (deckOf(paper) === (paper.slides ?? null) ? 'saved' : 'changed'));
  const [exporting, setExporting] = useState<'pdf' | 'pptx' | null>(null);
  const [problem, setProblem] = useMessage();
  const deckRef = useRef(deck);
  deckRef.current = deck;
  /** Changes not saved yet. */
  const unsaved = useRef(status === 'changed');
  /** Puts what is being typed in the editor into the deck. */
  const drafts = useRef<(() => void) | null>(null);
  const saving = useRef<Promise<void> | null>(null);

  const label = (kind: 'figure' | 'table', number?: string) => (kind === 'figure' ? (number ? t('图 {n}', { n: number }) : t('图')) : number ? t('表 {n}', { n: number }) : t('表格'));

  /** Saves what the deck is now; changes made while saving are saved after. */
  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    const run = (async () => {
      const shot = deckRef.current;
      setStatus('saving');
      try {
        await onSave(
          { kind: 'patchPaper', id: paper.id, fields: { slides: shot } },
          [],
          [],
          resultsCommitMessage('update slides of', paper.title),
          `content: update result "${paper.title}"`,
        );
        savedDeck(paper.id, shot);
        if (deckRef.current === shot) unsaved.current = false;
        setStatus(deckRef.current === shot ? 'saved' : 'changed');
      } catch (error) {
        setStatus('failed');
        setProblem(() => describeSaveError(error));
      } finally {
        saving.current = null;
      }
    })();
    saving.current = run;
    return run;
  }, [onSave, paper.id, paper.title, setProblem]);

  useEffect(() => {
    if (status !== 'changed') return undefined;
    const timer = window.setTimeout(() => void flush(), 800);
    return () => window.clearTimeout(timer);
  }, [deck, status, flush]);

  // Leaving the paper (for another, or the list) saves what is not saved yet, text still being typed included,
  // after any save on its way; closing the tab cannot wait for a save, so the browser asks first.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const typed = () => {
      if (deckRef.current?.kind === 'visual') drafts.current?.();
    };
    const onLeave = (event: BeforeUnloadEvent) => {
      typed();
      if (!unsaved.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      typed();
      const later = () => (unsaved.current ? flushRef.current() : undefined);
      if (unsaved.current) void (saving.current ? saving.current.then(later) : later());
    };
  }, []);

  const change = (next: SlideDeck | null) => {
    deckRef.current = next;
    unsaved.current = true;
    changedDeck(paper.id, next);
    setDeck(next);
    setStatus('changed');
    setProblem(null);
  };

  /** A Beamer deck's PDF for its source as it is now: the editor's compile of it, or one made now. */
  const beamer = async (): Promise<Uint8Array | undefined> => {
    if (!deck || deck.kind !== 'beamer') return undefined;
    const result = await compileBeamer(paper, deck.beamer ?? '', readFile);
    if (!result.pdf) setProblem(() => t('幻灯片还没编译成功，先修好代码里的问题'));
    return result.pdf;
  };

  const exportAs = async (kind: 'pdf' | 'pptx') => {
    if (!deck || exporting) return;
    setExporting(kind);
    setProblem(null);
    try {
      const { exportPdf, exportPptx } = await import('./exporters');
      const pdf = await beamer();
      if (deck.kind === 'beamer' && !pdf) return;
      await (kind === 'pdf' ? exportPdf : exportPptx)(deck, paper, readFile, pdf);
    } catch (error) {
      setProblem(() => describeSaveError(error));
    } finally {
      setExporting(null);
    }
  };

  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';

  return (
    <div className={`fixed inset-x-0 bottom-0 z-20 flex flex-col bg-white ${visible ? '' : 'hidden'}`} style={{ top }}>
      {deck ? (
        <>
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
            <span className="mr-2 inline-flex items-center gap-1.5 text-sm font-medium text-gray-800">
              {deck.kind === 'visual' ? <LayoutTemplate size={15} className="text-violet-600" /> : <FileCode2 size={15} className="text-violet-600" />}
              {deck.kind === 'visual' ? t('可视化幻灯片') : t('Beamer 幻灯片')}
            </span>
            <span className="whitespace-nowrap text-xs text-gray-400">
              {{ saved: t('已保存'), changed: t('有未保存的修改'), saving: t('保存中…'), failed: t('没有保存') }[status]}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => void exportAs('pdf')} disabled={exporting !== null} className={bar}>
                {exporting === 'pdf' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {t('导出 PDF')}
              </button>
              <button type="button" onClick={() => void exportAs('pptx')} disabled={exporting !== null} className={bar}>
                {exporting === 'pptx' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {t('导出 PowerPoint')}
              </button>
              <Menu label={t('换一种做法')} className={bar} trigger={<RotateCcw size={14} />}>
                {(close) => (
                  <MenuItem
                    danger
                    onSelect={() => {
                      close();
                      if (window.confirm(t('删掉这套幻灯片，重新选择做法？'))) change(null);
                    }}
                  >
                    {t('删掉这套幻灯片，重新开始')}
                  </MenuItem>
                )}
              </Menu>
              <button
                type="button"
                onClick={() =>
                  void beamer()
                    .then((pdf) => (deck.kind === 'visual' || pdf) && onPresent(deck, deck.kind === 'visual' ? current : 0, pdf))
                    .catch((error: unknown) => setProblem(() => describeSaveError(error)))
                }
                className="galley-press ml-1 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-violet-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-violet-800"
              >
                <Play size={14} />
                {deck.kind === 'visual' ? t('从这一页演示') : t('演示')}
              </button>
            </span>
          </div>
          {problem && (
            <p role="alert" className="shrink-0 border-b border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-700">
              {problem}
            </p>
          )}
          <div className="min-h-0 flex-1">
            <Suspense fallback={null}>
              {deck.kind === 'visual' ? (
                <SlidesEditor paper={paper} deck={deck} readFile={readFile} onChange={change} current={current} onCurrent={setCurrent} active={active && visible} drafts={drafts} />
              ) : (
                <BeamerEditor paper={paper} deck={deck} readFile={readFile} onChange={change} onSaveNow={() => void flush()} />
              )}
            </Suspense>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center overflow-y-auto bg-[#f5f5f7] p-6">
          <div className="w-full max-w-3xl">
            <h2 className="galley-display text-[2rem] text-[#1d1d1f]">{t('给这篇论文做一套幻灯片')}</h2>
            <p className="mt-2 text-[15px] text-[#6e6e73]">{t('论文里编译好的表格和图可以直接放上去，论文改了，幻灯片里的也跟着变。')}</p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['visual', LayoutTemplate, t('可视化幻灯片'), t('用论文里的图和表格先生成一套，再拖拽排版、加文字。可以导出 PDF 和 PowerPoint。')],
                  ['beamer', FileCode2, t('Beamer'), t('用 LaTeX 写，\\lemmablock{tab:main} 把论文里编译好的表格放到一页上。')],
                ] as const
              ).map(([kind, Icon, title, body]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    // The deck follows the paper's logic as last changed, saved or not.
                    const logical = withLatestLogic(paper);
                    change(kind === 'visual' ? visualDeck(logical, label, blockNumber) : beamerDeck(logical, blockNumber));
                    setCurrent(0);
                  }}
                  className="galley-press rounded-2xl border border-black/[0.06] bg-white p-6 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-shadow duration-150 hover:shadow-[0_12px_32px_-16px_rgba(0,0,0,0.25)]"
                >
                  <Icon size={22} className="text-violet-600" />
                  <span className="mt-4 block text-lg font-semibold text-gray-900">{title}</span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-gray-600">{body}</span>
                </button>
              ))}
            </div>
            <p className="mt-6 inline-flex items-center gap-1.5 text-xs text-gray-400">
              <SlidesIcon size={13} />
              {t('之后也可以删掉重来，换另一种做法。')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default SlidesMode;
