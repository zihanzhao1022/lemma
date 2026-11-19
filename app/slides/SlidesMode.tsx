import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Code2, Download, FileCode2, LayoutTemplate, Loader2, Play, Presentation as SlidesIcon, RotateCcw } from 'lucide-react';
import { describeSaveError } from '../../editor/backend';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import type { ReadFile } from '../../editor/results/actions';
import { resultsCommitMessage } from '../../editor/results/ops';
import { slidesPath } from '../../editor/results/slidesFile';
import { blockNumber } from '../../lib/headings';
import { LOCALES, getLang, useMessage } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultPaper, SlideDeck } from '../../types';
import Menu, { MenuItem } from '../Menu';
import { compileBeamer } from './beamer';
import { beamerDeck, visualDeck } from './deck';
import { withLatestLogic } from '../logic/latest';
import { HtmlDeck, StarterLabels, serializeDeck, starterHtmlDeck } from './htmlDeck';
import { htmlPage, loadHtmlDeck } from './htmlPage';
import { changedDeck, deckOf, savedDeck, unsavedText } from './latest';
import { stamped } from './sources';
import { hashText } from '../../editor/results/numbering';

const SlidesEditor = lazy(() => import('./SlidesEditor'));
const BeamerEditor = lazy(() => import('./BeamerEditor'));
const HtmlEditor = lazy(() => import('./HtmlEditor'));

interface Props {
  paper: ResultPaper;
  readFile: ReadFile;
  onSave: ResultsSave;
  /** Where the view starts, under the paper's bar. */
  top: number;
  visible: boolean;
  /** Whether the editor's keys work: off while the view is hidden or the deck is presented over it. */
  active: boolean;
  /** Presents the deck from a slide (a Beamer deck with its compiled PDF, an HTML deck with its page). */
  onPresent: (deck: SlideDeck, start: number, beamerPdf?: Uint8Array, htmlPage?: string) => void;
}

type Status = 'saved' | 'changed' | 'saving' | 'failed';

/**
 * A paper's slides: chosen as drawn (visual), written (Beamer) or written as a web page (HTML) the first time, then
 * edited here, saved a moment after each change (and when the view goes away), presented from the slide on screen,
 * and exported (PDF and PowerPoint; an HTML deck as a file of its own and as PDF).
 */
const SlidesMode: React.FC<Props> = ({ paper, readFile, onSave, top, visible, active, onPresent }) => {
  const t = useT();
  const [deck, setDeck] = useState<SlideDeck | null>(() => deckOf(paper));
  const [current, setCurrent] = useState(0);
  // A deck changed here whose save had not landed when the view opened (or failed) is saved again.
  const [status, setStatus] = useState<Status>(() => (deckOf(paper) === (paper.slides ?? null) ? 'saved' : 'changed'));
  const [exporting, setExporting] = useState<'pdf' | 'pptx' | 'html' | null>(null);
  const [problem, setProblem] = useMessage();
  const deckRef = useRef(deck);
  deckRef.current = deck;
  /** An HTML deck is a file of its own: its slides as the editor has them, and the text they come to. */
  const [html, setHtml] = useState<HtmlDeck | null>(null);
  const htmlRef = useRef<{ deck: HtmlDeck; text: string } | null>(null);
  /** The HTML deck's file is to be deleted with the next save (the deck was dropped). */
  const dropFile = useRef(false);
  /** Changes not saved yet. */
  const unsaved = useRef(status === 'changed');
  /** Puts what is being typed in the editor into the deck. */
  const drafts = useRef<(() => void) | null>(null);
  const saving = useRef<Promise<void> | null>(null);

  const label = (kind: 'figure' | 'table', number?: string) => (kind === 'figure' ? (number ? t('图 {n}', { n: number }) : t('图')) : number ? t('表 {n}', { n: number }) : t('表格'));
  const starterLabels: StarterLabels = {
    figure: (number) => label('figure', number),
    table: (number) => label('table', number),
    part: (n) => t('第 {n} 部分', { n }),
    brief: [t('场合：'), t('时长：'), t('听众：'), t('重点：'), t('语言：')].join('\n'),
  };

  // An HTML deck's file is read when the view opens (what was changed here and not saved yet comes from memory).
  const kind = deck?.kind;
  useEffect(() => {
    if (kind !== 'html' || html || !deckRef.current) return undefined;
    let cancelled = false;
    loadHtmlDeck(paper, deckRef.current, readFile)
      .then((loaded) => {
        if (cancelled) return;
        htmlRef.current = { deck: loaded, text: unsavedText(paper) ?? serializeDeck(loaded) };
        setHtml(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(() => describeSaveError(error));
      });
    return () => {
      cancelled = true;
    };
    // Read once for the deck that is open: later changes come from the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, html]);

  // The paper's slides changed elsewhere (Claude Code, another tab) while nothing here waits to be saved: show
  // them. A deck read again from the paper is the same as one saved from here, so only a real change counts.
  const outside = paper.slides ?? null;
  useEffect(() => {
    if (unsaved.current || saving.current) return;
    if (JSON.stringify(deckRef.current ?? null) === JSON.stringify(outside)) return;
    deckRef.current = outside;
    htmlRef.current = null;
    setHtml(null);
    setDeck(outside);
    setStatus('saved');
  }, [outside]);

  /** Saves what the deck is now; changes made while saving are saved after. */
  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    const run = (async () => {
      const shot = deckRef.current;
      const text = shot?.kind === 'html' ? htmlRef.current?.text : undefined;
      const removing = dropFile.current && shot === null;
      setStatus('saving');
      try {
        await onSave(
          { kind: 'patchPaper', id: paper.id, fields: { slides: shot } },
          text === undefined ? [] : [{ path: slidesPath(paper.id), data: new TextEncoder().encode(text), version: shot?.kind === 'html' ? shot.html?.hash : undefined }],
          removing ? [slidesPath(paper.id)] : [],
          resultsCommitMessage('update slides of', paper.title),
          `content: update result "${paper.title}"`,
        );
        if (removing) dropFile.current = false;
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
    // Dropping an HTML deck takes its file with it.
    if (next === null && deckRef.current?.kind === 'html') dropFile.current = true;
    if (next === null || next.kind !== 'html') {
      htmlRef.current = null;
      setHtml(null);
    }
    deckRef.current = next;
    unsaved.current = true;
    changedDeck(paper.id, next);
    setDeck(next);
    setStatus('changed');
    setProblem(null);
  };

  /** A change to an HTML deck: the deck in the paper keeps the hash of its text, and the text goes to its own file. */
  const changeHtml = (changed: HtmlDeck) => {
    // A slide written anew records the blocks it is written from, as they are now (sources.ts).
    const next = stamped(changed, htmlRef.current?.deck ?? null, paper);
    const text = serializeDeck(next);
    const marker: SlideDeck = { kind: 'html', slides: [], html: { hash: hashText(text) } };
    htmlRef.current = { deck: next, text };
    deckRef.current = marker;
    unsaved.current = true;
    changedDeck(paper.id, marker, text);
    setHtml(next);
    setDeck(marker);
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

  /** An HTML deck's page as it is now, its blocks in place. */
  const page = (mode: 'present' | 'export' | 'print', start?: number) =>
    htmlRef.current ? htmlPage(htmlRef.current.deck, paper, readFile, mode, LOCALES[getLang()], start === undefined ? undefined : { slide: start, step: 0 }) : Promise.reject(new Error('no deck'));

  const exportAs = async (what: 'pdf' | 'pptx' | 'html') => {
    if (!deck || exporting) return;
    setExporting(what);
    setProblem(null);
    try {
      const exporters = await import('./exporters');
      if (deck.kind === 'html') {
        if (what === 'html') exporters.exportHtml(await page('export'), htmlRef.current?.deck.title || paper.title);
        else await exporters.printPage(await page('print'));
        return;
      }
      const pdf = await beamer();
      if (deck.kind === 'beamer' && !pdf) return;
      await (what === 'pdf' ? exporters.exportPdf : exporters.exportPptx)(deck, paper, readFile, pdf);
    } catch (error) {
      setProblem(() => describeSaveError(error));
    } finally {
      setExporting(null);
    }
  };

  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  const download = (what: 'pdf' | 'pptx' | 'html', text: string) => (
    <button type="button" onClick={() => void exportAs(what)} disabled={exporting !== null || (deck?.kind === 'html' && !html)} className={bar}>
      {exporting === what ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      {text}
    </button>
  );

  return (
    <div className={`fixed inset-x-0 bottom-0 z-20 flex flex-col bg-white ${visible ? '' : 'hidden'}`} style={{ top }}>
      {deck ? (
        <>
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
            <span className="mr-2 inline-flex items-center gap-1.5 text-sm font-medium text-gray-800">
              {deck.kind === 'visual' ? <LayoutTemplate size={15} className="text-violet-600" /> : deck.kind === 'html' ? <Code2 size={15} className="text-violet-600" /> : <FileCode2 size={15} className="text-violet-600" />}
              {deck.kind === 'visual' ? t('可视化幻灯片') : deck.kind === 'html' ? t('HTML 幻灯片') : t('Beamer 幻灯片')}
            </span>
            <span className="whitespace-nowrap text-xs text-gray-400">
              {{ saved: t('已保存'), changed: t('有未保存的修改'), saving: t('保存中…'), failed: t('没有保存') }[status]}
            </span>
            <span className="ml-auto flex items-center gap-1">
              {deck.kind === 'html' ? (
                <>
                  {download('html', t('导出 HTML'))}
                  {download('pdf', t('导出 PDF'))}
                </>
              ) : (
                <>
                  {download('pdf', t('导出 PDF'))}
                  {download('pptx', t('导出 PowerPoint'))}
                </>
              )}
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
                disabled={deck.kind === 'html' && !html}
                onClick={() => {
                  if (deck.kind === 'html') {
                    void page('present', current)
                      .then((made) => onPresent(deck, current, undefined, made))
                      .catch((error: unknown) => setProblem(() => describeSaveError(error)));
                    return;
                  }
                  void beamer()
                    .then((pdf) => (deck.kind === 'visual' || pdf) && onPresent(deck, deck.kind === 'visual' ? current : 0, pdf))
                    .catch((error: unknown) => setProblem(() => describeSaveError(error)));
                }}
                className="galley-press ml-1 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-violet-700 px-3 py-1 text-[13px] font-medium text-white hover:bg-violet-800 disabled:opacity-50"
              >
                <Play size={14} />
                {deck.kind === 'beamer' ? t('演示') : t('从这一页演示')}
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
              ) : deck.kind === 'html' ? (
                html ? (
                  <HtmlEditor paper={paper} deck={html} readFile={readFile} onChange={changeHtml} current={current} onCurrent={setCurrent} onSaveNow={() => void flush()} />
                ) : (
                  <p className="flex h-full items-center justify-center text-sm text-gray-400">{problem ? '' : t('正在打开幻灯片…')}</p>
                )
              ) : (
                <BeamerEditor paper={paper} deck={deck} readFile={readFile} onChange={change} onSaveNow={() => void flush()} />
              )}
            </Suspense>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center overflow-y-auto bg-[#f5f5f7] p-6">
          <div className="w-full max-w-5xl">
            <h2 className="galley-display text-[2rem] text-[#1d1d1f]">{t('给这篇论文做一套幻灯片')}</h2>
            <p className="mt-2 text-[15px] text-[#6e6e73]">{t('论文里编译好的表格和图可以直接放上去，论文改了，幻灯片里的也跟着变。')}</p>
            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {(
                [
                  ['html', Code2, t('HTML 幻灯片'), t('白底、学术的版式；表格可以一步步聚焦到某一行、某一格。Claude Code 能读论文来帮你写。导出单个 HTML 文件或 PDF。'), true],
                  ['visual', LayoutTemplate, t('可视化幻灯片'), t('用论文里的图和表格先生成一套，再拖拽排版、加文字。可以导出 PDF 和 PowerPoint。'), false],
                  ['beamer', FileCode2, t('Beamer'), t('用 LaTeX 写，\\lemmablock{tab:main} 把论文里编译好的表格放到一页上。'), false],
                ] as const
              ).map(([name, Icon, title, body, recommended]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    // The deck follows the paper's logic as last changed, saved or not.
                    const logical = withLatestLogic(paper);
                    if (name === 'html') changeHtml(starterHtmlDeck(logical, starterLabels, blockNumber));
                    else change(name === 'visual' ? visualDeck(logical, label, blockNumber) : beamerDeck(logical, blockNumber));
                    setCurrent(0);
                  }}
                  className="galley-press rounded-2xl border border-black/[0.06] bg-white p-6 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-shadow duration-150 hover:shadow-[0_12px_32px_-16px_rgba(0,0,0,0.25)]"
                >
                  <span className="flex items-center justify-between">
                    <Icon size={22} className="text-violet-600" />
                    {recommended && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">{t('推荐')}</span>}
                  </span>
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
