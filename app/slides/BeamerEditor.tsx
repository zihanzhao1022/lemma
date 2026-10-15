import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, PackagePlus, RefreshCw } from 'lucide-react';
import CodeEditor, { CodeEditorHandle } from '../../editor/results/CodeEditor';
import type { ReadFile } from '../../editor/results/actions';
import { blockNumber } from '../../lib/headings';
import { useT } from '../../lib/phrases/app';
import { ResultPaper, SlideDeck } from '../../types';
import Menu, { MenuItem, MenuLabel } from '../Menu';
import PdfPages from '../writing/PdfPages';
import { BeamerResult, compileBeamer } from './beamer';
import { captionOf, refFor } from './deck';

interface Props {
  paper: ResultPaper;
  deck: SlideDeck;
  readFile: ReadFile;
  onChange: (deck: SlideDeck) => void;
  /** ⌘S: save now rather than a moment later. */
  onSaveNow: () => void;
}

const noop = () => {};

/**
 * A Beamer deck: its LaTeX on the left, the compiled slides on the right, recompiled a moment after typing stops.
 * \lemmablock{label} puts one of the paper's compiled blocks on a frame; the menu above the code writes it.
 */
const BeamerEditor: React.FC<Props> = ({ paper, deck, readFile, onChange, onSaveNow }) => {
  const t = useT();
  const editor = useRef<CodeEditorHandle>(null);
  const source = deck.beamer ?? '';
  const [result, setResult] = useState<BeamerResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [listing, setListing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const latest = useRef(source);
  latest.current = source;

  const compile = () => {
    setCompiling(true);
    const asked = latest.current;
    compileBeamer(paper, asked, readFile)
      .then((done) => {
        if (asked !== latest.current) return;
        setResult((previous) => ({ ...done, pdf: done.pdf ?? previous?.pdf }));
      })
      .catch((error: unknown) => setResult({ issues: [{ message: String(error) }], seconds: 0 }))
      .finally(() => setCompiling(false));
  };

  // A moment after typing stops, and right away when the deck opens.
  const first = useRef(true);
  useEffect(() => {
    const timer = window.setTimeout(compile, first.current ? 0 : 1200);
    first.current = false;
    return () => window.clearTimeout(timer);
  }, [source, paper.blocks]);

  const label = (kind: 'figure' | 'table', number?: string) => (kind === 'figure' ? (number ? t('图 {n}', { n: number }) : t('图')) : number ? t('表 {n}', { n: number }) : t('表格'));
  const choices = useMemo(
    () =>
      paper.blocks.flatMap((block, index) => {
        if (!block.output) return [];
        const caption = captionOf(block.source);
        const name = block.kind === 'text' ? t('文字') : label(block.kind, blockNumber(paper.blocks, index));
        return [{ ref: refFor(block), name: caption ? `${name}  ${caption}` : name }];
      }),
    [paper.blocks, t],
  );

  const issues = result?.issues ?? [];
  const problems = issues.flatMap((issue) => (issue.line ? [{ line: issue.line, message: issue.message }] : []));
  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900';

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col border-r border-black/[0.06]">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
          <span className="mr-2 text-sm font-medium text-gray-800">slides.tex</span>
          <Menu label={t('插入论文里的块')} align="left" className={bar} trigger={<><PackagePlus size={14} />{t('插入论文里的块')}</>}>
            {(close) => (
              <>
                <MenuLabel>{t('在光标处写入 \\lemmablock{…}')}</MenuLabel>
                {choices.map((choice) => (
                  <MenuItem
                    key={choice.ref}
                    onSelect={() => {
                      editor.current?.insert(`\\lemmablock{${choice.ref}}`);
                      close();
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-gray-400">{choice.ref}</span>
                  </MenuItem>
                ))}
                {choices.length === 0 && <p className="px-3 py-1 text-xs text-gray-400">{t('这篇论文还没有编译好的块。')}</p>}
              </>
            )}
          </Menu>
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor ref={editor} value={source} onChange={(text) => onChange({ ...deck, beamer: text })} problems={problems} onRun={compile} onSave={onSaveNow} />
        </div>
      </section>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
          <button type="button" onClick={compile} disabled={compiling} className="galley-press inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-gray-900 px-3 py-1 text-[13px] font-medium text-white hover:bg-gray-700 disabled:opacity-60">
            {compiling ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('重新编译')}
          </button>
          {issues.length > 0 && (
            <button type="button" onClick={() => setListing((on) => !on)} aria-expanded={listing} className={`${bar} text-red-700 hover:text-red-800`}>
              <AlertTriangle size={14} />
              {t('{n} 个问题', { n: issues.length })}
            </button>
          )}
          <span className="ml-1 whitespace-nowrap text-xs text-gray-400">{compiling ? t('编译中…') : result ? t('{s} 秒', { s: result.seconds.toFixed(1) }) : ''}</span>
          <span className="ml-auto flex shrink-0 items-center">
            <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))} aria-label={t('缩小')} className={bar}>
              −
            </button>
            <button type="button" onClick={() => setZoom(1)} className={`${bar} tabular-nums`} title={t('适合宽度')}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))} aria-label={t('放大')} className={bar}>
              +
            </button>
          </span>
        </div>
        {listing && issues.length > 0 && (
          <ul className="max-h-48 shrink-0 overflow-y-auto border-b border-red-100 bg-red-50/60 py-1 text-xs">
            {issues.map((issue, index) => (
              <li key={index}>
                <button type="button" disabled={!issue.line} onClick={() => issue.line && editor.current?.goToLine(issue.line)} className="w-full px-3 py-1 text-left text-red-800 enabled:hover:bg-red-100/70">
                  {issue.line ? t('{file} 第 {line} 行：{message}', { file: 'slides.tex', line: issue.line, message: issue.message }) : issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="min-h-0 flex-1">
          {result?.pdf ? (
            <PdfPages data={result.pdf} zoom={zoom} onDoubleClick={noop} />
          ) : (
            <p className="flex h-full items-center justify-center bg-[#e9e9ec] px-6 text-center text-sm text-gray-500">
              {compiling || !result ? t('正在编译幻灯片…（第一次要下载 Beamer，会慢一些）') : t('没有生成 PDF')}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

export default BeamerEditor;
