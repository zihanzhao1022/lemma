import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Clipboard, Copy, LayoutGrid, PackagePlus, Plus, Trash2 } from 'lucide-react';
import CodeEditor, { CodeEditorHandle } from '../../editor/results/CodeEditor';
import type { ReadFile } from '../../editor/results/actions';
import { DEFAULT_PREAMBLE } from '../../editor/tex/document';
import { blockNumber } from '../../lib/headings';
import { LOCALES, useLang } from '../../lib/i18n';
import { useT } from '../../lib/phrases/app';
import { ResultPaper } from '../../types';
import Menu, { MenuItem, MenuLabel } from '../Menu';
import { nodeLabels } from '../logic/labels';
import { chartColumns, resolveBlocks } from './blockHtml';
import { changedSources, checkedSlide } from './sources';
import { pictureOf } from './blockPicture';
import { captionOf, refFor } from './deck';
import { buildDocument } from './deckDocument';
import HtmlFrame, { FrameState, HtmlFrameHandle, SlideProblem } from './HtmlFrame';
import { HtmlDeck, blankSlide, escapeHtml, duplicatedSlide, movedSlide, newSlideId, slideTitle, withSlide, withSlideHtml, withoutSlide } from './htmlDeck';

interface Props {
  paper: ResultPaper;
  deck: HtmlDeck;
  readFile: ReadFile;
  /** Every change, as the whole deck; the caller saves it. */
  onChange: (deck: HtmlDeck) => void;
  /** The slide on screen (0-based); a presentation starts from it. */
  current: number;
  onCurrent: (index: number) => void;
  /** ⌘S: save now rather than a moment later. */
  onSaveNow: () => void;
}

type Tab = 'slide' | 'style' | 'about';

/** A slide's markup is shown a moment after typing stops, so that the page is not rebuilt at every key. */
const PREVIEW_DELAY = 350;

/**
 * An HTML deck: the list of its slides, the code of the one chosen, and the deck as the talk shows it (in a frame
 * that cannot reach anything of this app). A slide puts a block of the paper on itself with <lemma-block ref="…">;
 * the menu above the code writes it.
 */
const HtmlEditor: React.FC<Props> = ({ paper, deck, readFile, onChange, current, onCurrent, onSaveNow }) => {
  const t = useT();
  const lang = LOCALES[useLang()];
  const editor = useRef<CodeEditorHandle>(null);
  const frame = useRef<HtmlFrameHandle>(null);
  const [tab, setTab] = useState<Tab>('slide');
  const [copied, setCopied] = useState(false);
  /** Every slide at once in the preview: the deck's thumbnails, with its layout problems marked. */
  const [overview, setOverview] = useState(false);
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  /** What the page found wrong with each slide's layout, by slide. */
  const [problems, setProblems] = useState<Record<number, SlideProblem['kinds']>>({});
  const [state, setState] = useState<FrameState | null>(null);
  const index = Math.max(0, Math.min(current, deck.slides.length - 1));
  const slide = deck.slides[index];

  // The page the frame shows: the deck as it was a moment ago, with its blocks in place.
  const picture = useMemo(() => pictureOf(readFile), [readFile]);
  const [shown, setShown] = useState(deck);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(deck), PREVIEW_DELAY);
    return () => window.clearTimeout(timer);
  }, [deck]);
  /** Where a page that loads again opens: where the last one was. */
  const where = useRef({ slide: index, step: 0 });
  where.current = { slide: index, step: state?.slide === index ? state.step : 0 };
  const memo = useRef<{ blocks: unknown; preamble: unknown; resolved: Map<string, Promise<string>> }>({ blocks: null, preamble: null, resolved: new Map() });
  const [page, setPage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (memo.current.blocks !== paper.blocks || memo.current.preamble !== paper.preamble) memo.current = { blocks: paper.blocks, preamble: paper.preamble, resolved: new Map() };
    const { resolved } = memo.current;
    const current = new Set(shown.slides.map((item) => item.html));
    resolved.forEach((_, key) => {
      if (!current.has(key)) resolved.delete(key);
    });
    Promise.all(
      shown.slides.map((item) => {
        let found = resolved.get(item.html);
        if (!found) {
          found = resolveBlocks(item.html, paper, picture);
          resolved.set(item.html, found);
        }
        return found;
      }),
    )
      .then((html) => {
        if (!cancelled) setPage(buildDocument({ ...shown, slides: shown.slides.map((item, at) => ({ ...item, html: html[at] })) }, { mode: 'preview', start: where.current, lang }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // The paper's other fields do not change what a slide shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, paper.blocks, paper.preamble, picture, lang]);

  // Choosing another slide shows it, from its first step.
  useEffect(() => {
    frame.current?.go(index, 0);
  }, [index]);

  const choices = useMemo(
    () =>
      paper.blocks.flatMap((block, at) => {
        if (!block.output) return [];
        const caption = captionOf(block.source);
        const number = blockNumber(paper.blocks, at);
        const name = block.kind === 'text' ? t('文字') : block.kind === 'figure' ? (number ? t('图 {n}', { n: number }) : t('图')) : number ? t('表 {n}', { n: number }) : t('表格');
        return [{ ref: refFor(block), name: caption ? `${name}  ${caption}` : name }];
      }),
    [paper.blocks, t],
  );

  // The columns of each table a chart can be drawn from (<lemma-chart>).
  const charts = useMemo(
    () =>
      paper.blocks.flatMap((block, at) => {
        if (block.kind !== 'table' || !block.output) return [];
        const number = blockNumber(paper.blocks, at);
        const name = number ? t('表 {n}', { n: number }) : t('表格');
        return chartColumns(block, paper.preamble ?? DEFAULT_PREAMBLE).map((column) => ({ ref: refFor(block), column, name: `${name} · ${column}` }));
      }),
    [paper.blocks, paper.preamble, t],
  );

  const bar = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-[13px] text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-40';
  const icon = 'rounded-md p-1.5 text-gray-600 transition-colors duration-150 hover:bg-black/[0.05] hover:text-gray-900 disabled:opacity-30';
  // The blocks each slide was written from that changed since (sources.ts), and their names.
  const labels = useMemo(
    () =>
      nodeLabels(paper, {
        figure: (n) => (n ? t('图 {n}', { n }) : t('图')),
        table: (n) => (n ? t('表 {n}', { n }) : t('表格')),
        abstract: t('摘要'),
        empty: t('（空白）'),
      }),
    [paper, t],
  );
  const stale = useMemo(() => deck.slides.map((item) => changedSources(item, paper)), [deck.slides, paper]);
  const staleText = (ids: string[]): string =>
    t('这一页依据的块后来改过：{names}', { names: ids.map((id) => labels[id]?.title ?? t('一个已删除的块')).join(' · ') });

  const problemText = (kinds: SlideProblem['kinds']): string =>
    kinds.map((kind) => (kind === 'overflow' ? t('有内容超出了页面或内容区') : t('标题或页脚和内容重叠了'))).join(' · ');
  const tabs: [Tab, string][] = [
    ['slide', t('这一页')],
    ['style', t('样式')],
    ['about', t('说明和页脚')],
  ];

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-black/[0.06]">
        <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-black/[0.06] px-2">
          <button
            type="button"
            onClick={() => {
              onChange(withSlide(deck, { id: newSlideId(deck), html: blankSlide() }, index + 1));
              onCurrent(index + 1);
              setTab('slide');
            }}
            aria-label={t('新幻灯片')}
            title={t('新幻灯片')}
            className={icon}
          >
            <Plus size={15} />
          </button>
          <button type="button" onClick={() => { onChange(duplicatedSlide(deck, index)); onCurrent(index + 1); }} aria-label={t('复制这一页')} title={t('复制这一页')} className={icon}>
            <Copy size={15} />
          </button>
          <button type="button" onClick={() => { onChange(movedSlide(deck, index, -1)); onCurrent(Math.max(0, index - 1)); }} disabled={index === 0} aria-label={t('上移')} title={t('上移')} className={icon}>
            <ArrowUp size={15} />
          </button>
          <button type="button" onClick={() => { onChange(movedSlide(deck, index, 1)); onCurrent(Math.min(deck.slides.length - 1, index + 1)); }} disabled={index >= deck.slides.length - 1} aria-label={t('下移')} title={t('下移')} className={icon}>
            <ArrowDown size={15} />
          </button>
          <button type="button" onClick={() => { onChange(withoutSlide(deck, index)); onCurrent(Math.max(0, index - 1)); }} disabled={deck.slides.length <= 1} aria-label={t('删除这一页')} title={t('删除这一页')} className={`${icon} ml-auto`}>
            <Trash2 size={15} />
          </button>
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto py-1">
          {deck.slides.map((item, at) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onCurrent(at)}
                aria-current={at === index}
                aria-label={t('第 {n} 页', { n: at + 1 })}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px] transition-colors duration-150 ${at === index ? 'bg-violet-50 text-gray-900' : 'text-gray-600 hover:bg-black/[0.03]'}`}
              >
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-gray-400">{at + 1}</span>
                <span className="min-w-0 flex-1 truncate">{slideTitle(item.html) || <span className="text-gray-400">{t('（没有标题）')}</span>}</span>
                {problems[at] && <span title={problemText(problems[at])} aria-label={problemText(problems[at])} className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-red-500" />}
                {stale[at]?.length > 0 && <span title={staleText(stale[at])} aria-label={staleText(stale[at])} className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-amber-500" />}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col border-r border-black/[0.06]">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
          {tabs.map(([name, label]) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              aria-pressed={tab === name}
              className={`rounded-lg px-2.5 py-1 text-[13px] transition-colors duration-150 ${tab === name ? 'bg-black/[0.06] font-medium text-gray-900' : 'text-gray-600 hover:bg-black/[0.04]'}`}
            >
              {label}
            </button>
          ))}
          {tab === 'slide' && (
            <Menu label={t('插入论文里的块')} align="left" className={`${bar} ml-auto`} trigger={<><PackagePlus size={14} />{t('插入论文里的块')}</>}>
              {(close) => (
                <>
                  <MenuLabel>{t('在光标处写入 <lemma-block ref="…">')}</MenuLabel>
                  {choices.map((choice) => (
                    <MenuItem
                      key={choice.ref}
                      onSelect={() => {
                        editor.current?.insert(`<lemma-block ref="${choice.ref}"></lemma-block>`);
                        close();
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-gray-400">{choice.ref}</span>
                    </MenuItem>
                  ))}
                  {choices.length === 0 && <p className="px-3 py-1 text-xs text-gray-400">{t('这篇论文还没有编译好的块。')}</p>}
                  {charts.length > 0 && <MenuLabel>{t('一列数字画成柱状图：<lemma-chart ref="…" col="…">')}</MenuLabel>}
                  {charts.map((chart) => (
                    <MenuItem
                      key={`${chart.ref} ${chart.column}`}
                      onSelect={() => {
                        editor.current?.insert(`<lemma-chart ref="${escapeHtml(chart.ref)}" col="${escapeHtml(chart.column)}"></lemma-chart>`);
                        close();
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{chart.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-gray-400">{chart.ref}</span>
                    </MenuItem>
                  ))}
                </>
              )}
            </Menu>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {tab === 'about' ? (
            <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
              <label className="block text-xs font-medium text-gray-500">
                {t('这套幻灯片的标题')}
                <input value={deck.title} onChange={(event) => onChange({ ...deck, title: event.target.value })} className="mt-1 block w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-violet-400" />
              </label>
              <label className="block text-xs font-medium text-gray-500">
                {t('每页底部的一行字')}
                <input value={deck.footer} onChange={(event) => onChange({ ...deck, footer: event.target.value })} className="mt-1 block w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-violet-400" />
              </label>
              <label className="flex min-h-0 flex-1 flex-col text-xs font-medium text-gray-500">
                {t('场合和要求（写给写幻灯片的人，包括 Claude Code）')}
                <textarea value={deck.brief} onChange={(event) => onChange({ ...deck, brief: event.target.value })} className="mt-1 min-h-[8rem] flex-1 resize-none rounded-lg border border-black/10 px-3 py-2 text-sm leading-relaxed text-gray-900 outline-none focus:border-violet-400" />
              </label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    // Claude Code reads the brief from the saved deck: save it first.
                    onSaveNow();
                    void navigator.clipboard
                      .writeText(t('用 OnizukaTex 的 MCP 工具（lemma）写论文「{title}」（ID {id}）的 HTML 幻灯片。先读 slides_guide，再看 get_paper 和 get_slides；场合和要求在幻灯片的说明里，照它写。数字只从论文的块里取（read_blocks）。用 update_slide、add_slide、move_slide 和 delete_slide 一页一页地改。', { title: paper.title, id: paper.id }))
                      .then(() => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                      });
                  }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-[13px] text-gray-800 transition-colors duration-150 hover:bg-black/[0.04]"
                >
                  {copied ? <Check size={14} /> : <Clipboard size={14} />}
                  {copied ? t('已复制') : t('复制给 Claude Code 的指令')}
                </button>
                <p className="text-xs leading-snug text-gray-500">{t('Claude Code 连上 OnizukaTex 之后，把它粘贴给 Claude Code。它改的幻灯片会存进论文仓库，回到这一页就能看到。')}</p>
              </div>
            </div>
          ) : (
            <CodeEditor
              key={tab}
              ref={editor}
              language={tab === 'style' ? 'css' : 'html'}
              value={tab === 'style' ? deck.css : (slide?.html ?? '')}
              onChange={(text) => onChange(tab === 'style' ? { ...deck, css: text } : withSlideHtml(deck, index, text))}
              onSave={onSaveNow}
            />
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/[0.06] px-3">
          <button type="button" onClick={() => frame.current?.go(index, (state?.step ?? 0) - 1)} disabled={!state || state.step <= 0} aria-label={t('上一步')} title={t('上一步')} className={icon}>
            <ChevronLeft size={15} />
          </button>
          <span className="min-w-[6rem] text-center text-xs tabular-nums text-gray-500">{state && state.steps > 0 ? t('步骤 {n} / {m}', { n: state.step, m: state.steps }) : t('这一页没有步骤')}</span>
          <button type="button" onClick={() => frame.current?.go(index, (state?.step ?? 0) + 1)} disabled={!state || state.step >= state.steps} aria-label={t('下一步')} title={t('下一步')} className={icon}>
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            onClick={() => {
              frame.current?.overview(!overview);
              setOverview(!overview);
            }}
            aria-pressed={overview}
            title={t('所有幻灯片')}
            className={`${bar} ml-auto ${overview ? 'bg-black/[0.06] text-gray-900' : ''}`}
          >
            <LayoutGrid size={14} />
            {t('所有幻灯片')}
          </button>
        </div>
        {problems[index] && !overview && <p className="shrink-0 border-b border-red-100 bg-red-50 px-4 py-1.5 text-xs text-red-700">{problemText(problems[index])}</p>}
        {stale[index]?.length > 0 && !overview && (
          <div className="flex shrink-0 items-center gap-3 border-b border-amber-100 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
            <span className="min-w-0 flex-1">{staleText(stale[index])}{t('：看看这一页的数字和说法还对不对。')}</span>
            <button type="button" onClick={() => onChange(checkedSlide(deck, index, paper))} className="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 font-medium transition-colors duration-150 hover:bg-amber-100">
              {t('核对过了')}
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[#e9e9ec] p-4">
          {page ? (
            <div className={overview ? 'relative h-full w-full' : 'relative w-full max-w-[1100px]'} style={overview ? undefined : { aspectRatio: '16 / 9' }}>
              <HtmlFrame
                ref={frame}
                html={page}
                title={t('幻灯片预览')}
                onState={setState}
                onProblems={(found) => setProblems(Object.fromEntries(found.map((item) => [item.slide, item.kinds])))}
                onPick={(slide) => {
                  onCurrent(slide);
                  setOverview(false);
                  frame.current?.overview(false);
                }}
                onReady={() => {
                  if (overviewRef.current) frame.current?.overview(true);
                  frame.current?.go(where.current.slide, where.current.step);
                }}
                className="absolute inset-0 h-full w-full border border-black/10 bg-white shadow-sm"
              />
            </div>
          ) : (
            <p className="text-sm text-gray-500">{t('正在准备预览…')}</p>
          )}
        </div>
      </section>
    </div>
  );
};

export default HtmlEditor;
