import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Image as ImageIcon, MonitorPlay, Quote, Search, Table2, X } from 'lucide-react';
import BlockView from '../../components/results/BlockView';
import { ResultsAccess, ResultsAccessContext } from '../../components/results/access';
import { slidesPath } from '../../editor/results/slidesFile';
import { useT } from '../../lib/phrases/app';
import { FloatKind, ResultPaper } from '../../types';
import { LabelWords, nodeLabels } from '../logic/labels';
import { blockBytes, drawPdf } from '../slides/SlideView';
import { LibraryItem, filterItems, libraryItems } from './results';

interface Props {
  login: string;
  /** The account's own papers that are not archived, in the order the list shows them. */
  papers: ResultPaper[];
  access: ResultsAccess;
}

/** Thumbnails by PDF path; a recompiled block gets a new path. */
const thumbs = new Map<string, Promise<string>>();
const THUMB_WIDTH = 640;

/** A block's compiled PDF as a small picture, drawn once it scrolls near the screen. */
const Thumb: React.FC<{ item: LibraryItem; access: ResultsAccess }> = ({ item, access }) => {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const output = item.block.output;

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
      found = blockBytes(output.pdf, access.readFile)
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
  }, [near, output, access]);

  return (
    <div ref={box} className="flex h-44 items-center justify-center overflow-hidden rounded-lg bg-white p-3 ring-1 ring-black/[0.06]">
      {!output ? (
        <span className="text-xs text-gray-400">{t('还没有编译')}</span>
      ) : failed ? (
        <span className="text-xs text-red-500">{t('读取 PDF 失败，请刷新页面重试')}</span>
      ) : url ? (
        <img src={url} alt={item.caption} className="max-h-full max-w-full object-contain" />
      ) : null}
    </div>
  );
};

/** Where an item is used, in a line: cited in the text, on slides. */
const Uses: React.FC<{ item: LibraryItem }> = ({ item }) => {
  const t = useT();
  if (item.citedBy.length === 0 && item.slides.length === 0) return <span className="text-gray-400">{t('正文和幻灯片里都还没有用到')}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {item.citedBy.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <Quote size={12} />
          {t('正文引用 {n} 处', { n: item.citedBy.length })}
        </span>
      )}
      {item.slides.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <MonitorPlay size={12} />
          {t('幻灯片第 {pages} 页', { pages: item.slides.join(', ') })}
        </span>
      )}
    </span>
  );
};

/**
 * The Management page: every figure and table of the account's own papers, grouped by the paper each belongs to,
 * with where each is used.
 */
const ResultsLibrary: React.FC<Props> = ({ login, papers, access }) => {
  const t = useT();
  const navigate = useNavigate();
  const [kind, setKind] = useState<FloatKind | undefined>(undefined);
  const [paperId, setPaperId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  // The text of each HTML deck, which lives in a file of its own, by paper ID and the hash it was read at.
  const [htmlDecks, setHtmlDecks] = useState<Record<string, { hash: string; text: string }>>({});

  const asked = useRef(new Map<string, string>());
  useEffect(() => {
    for (const paper of papers) {
      const hash = paper.slides?.kind === 'html' ? paper.slides.html?.hash : undefined;
      if (!hash || asked.current.get(paper.id) === hash) continue;
      asked.current.set(paper.id, hash);
      access
        .readFile(slidesPath(paper.id), hash)
        .then((bytes) =>
          setHtmlDecks((current) => ({
            ...current,
            [paper.id]: { hash, text: new TextDecoder().decode(bytes) },
          })),
        )
        .catch(() => asked.current.delete(paper.id));
    }
  }, [papers, access]);

  const items = useMemo(() => libraryItems(papers, Object.fromEntries(Object.entries(htmlDecks).map(([id, deck]) => [id, deck.text]))), [papers, htmlDecks]);
  const shown = useMemo(() => filterItems(items, { kind, paper: paperId || undefined, search }), [items, kind, paperId, search]);
  const groups = useMemo(() => {
    const byPaper = new Map<string, { paper: ResultPaper; items: LibraryItem[] }>();
    for (const item of shown) {
      const group = byPaper.get(item.paper.id) ?? {
        paper: item.paper,
        items: [],
      };
      group.items.push(item);
      byPaper.set(item.paper.id, group);
    }
    return [...byPaper.values()];
  }, [shown]);
  const counts = useMemo(
    () => ({
      figure: items.filter((item) => item.kind === 'figure').length,
      table: items.filter((item) => item.kind === 'table').length,
    }),
    [items],
  );

  const words = useMemo<LabelWords>(
    () => ({
      figure: (n) => (n ? t('图 {n}', { n }) : t('图')),
      table: (n) => (n ? t('表 {n}', { n }) : t('表格')),
      abstract: t('摘要'),
      empty: t('（空白）'),
    }),
    [t],
  );
  const name = (item: LibraryItem) => (item.kind === 'figure' ? words.figure(item.number) : words.table(item.number));
  const open = (item: LibraryItem) => navigate(`/p/${login}/${item.paper.slug}?block=${encodeURIComponent(item.block.id)}`);
  const detail = chosen ? items.find((item) => item.key === chosen) : undefined;
  const detailLabels = useMemo(() => (detail ? nodeLabels(detail.paper, words) : {}), [detail, words]);

  useEffect(() => {
    if (!detail) return undefined;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setChosen(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [detail]);

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm transition-colors duration-150 ${active ? 'bg-white text-gray-900 shadow-sm ring-1 ring-black/[0.06]' : 'text-gray-600 hover:bg-black/[0.04]'}`;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="galley-display text-[2rem] text-gray-900">{t('成果管理')}</h1>
        <label className="relative block w-full sm:w-72">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('搜索图注、label 或论文')}
            aria-label={t('搜索图注、label 或论文')}
            className="w-full rounded-xl border border-transparent bg-black/[0.04] py-2 pl-9 pr-3 text-sm outline-none transition-colors duration-150 focus:border-violet-300 focus:bg-white"
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-xl bg-[#f5f5f7] p-1.5">
        <button type="button" className={chip(kind === undefined)} onClick={() => setKind(undefined)}>
          {t('全部成果')} <span className="text-gray-400">{items.length}</span>
        </button>
        <button type="button" className={chip(kind === 'figure')} onClick={() => setKind('figure')}>
          <ImageIcon size={14} />
          {t('图')} <span className="text-gray-400">{counts.figure}</span>
        </button>
        <button type="button" className={chip(kind === 'table')} onClick={() => setKind('table')}>
          <Table2 size={14} />
          {t('表格')} <span className="text-gray-400">{counts.table}</span>
        </button>
        <select
          value={paperId}
          onChange={(event) => setPaperId(event.target.value)}
          aria-label={t('论文')}
          className="ml-auto max-w-full rounded-lg border-0 bg-transparent py-1 pl-2 pr-8 text-sm text-gray-700 focus:ring-2 focus:ring-violet-300 sm:max-w-xs"
        >
          <option value="">{t('全部论文')}</option>
          {papers.map((paper) => (
            <option key={paper.id} value={paper.id}>
              {paper.title}
            </option>
          ))}
        </select>
      </div>

      {groups.length === 0 ? (
        <p className="px-3 py-14 text-gray-800">{items.length === 0 ? t('你的论文里还没有图和表格。') : t('没有找到这样的图或表格')}</p>
      ) : (
        groups.map((group) => (
          <section key={group.paper.id} className="mt-8">
            <h2 className="flex items-baseline gap-2 border-b border-black/[0.06] pb-2">
              <span className="truncate text-base font-medium text-gray-900">{group.paper.title}</span>
              {group.paper.venue && <span className="truncate text-sm text-gray-400">{group.paper.venue}</span>}
              <span className="ml-auto shrink-0 text-xs text-gray-400">{group.items.length}</span>
            </h2>
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => setChosen(item.key)}
                    className="galley-press block w-full rounded-xl bg-[#f5f5f7] p-2 text-left transition-shadow duration-150 hover:shadow-[0_0_0_2px_rgba(167,139,250,0.55)]"
                  >
                    <Thumb item={item} access={access} />
                    <div className="px-1.5 pb-1 pt-2.5">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-900">{name(item)}</span>
                        {item.block.hidden && <span className="rounded bg-gray-200 px-1.5 text-xs text-gray-600">{t('已隐藏')}</span>}
                      </div>
                      <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-gray-600">
                        {item.caption || <span className="text-gray-400">{t('没有图注')}</span>}
                      </p>
                      <div className="mt-2 text-xs text-gray-500">
                        <Uses item={item} />
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {detail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={name(detail)}
          className="fixed inset-0 z-[100] flex justify-end bg-black/30"
          onMouseDown={() => setChosen(null)}
        >
          <div className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-white p-6 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-900">{name(detail)}</h2>
                <p className="truncate text-sm text-gray-500">{t('来自《{title}》', { title: detail.paper.title })}</p>
              </div>
              <button type="button" onClick={() => setChosen(null)} aria-label={t('关闭')} className="ml-auto p-1 text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>

            <div className="mt-5 rounded-lg p-2 ring-1 ring-black/[0.06]">
              <ResultsAccessContext.Provider value={access}>
                <BlockView paperId={detail.paper.id} block={detail.block} />
              </ResultsAccessContext.Provider>
            </div>

            <dl className="mt-5 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
              <dt className="text-gray-500">{t('图注')}</dt>
              <dd className="text-gray-800">{detail.caption || <span className="text-gray-400">{t('没有图注')}</span>}</dd>
              <dt className="text-gray-500">label</dt>
              <dd className="font-mono text-[13px] text-gray-800">
                {detail.labels.length > 0 ? detail.labels.join(', ') : <span className="font-sans text-gray-400">{t('没有 label')}</span>}
              </dd>
              <dt className="text-gray-500">{t('正文引用')}</dt>
              <dd className="text-gray-800">
                {detail.citedBy.length === 0 ? (
                  <span className="text-gray-400">{t('没有')}</span>
                ) : (
                  <ul className="space-y-1">
                    {detail.citedBy.map((id) => (
                      <li key={id} className="truncate">
                        {detailLabels[id]?.title ?? id}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt className="text-gray-500">{t('幻灯片')}</dt>
              <dd className="text-gray-800">
                {detail.slides.length > 0 ? t('第 {pages} 页', { pages: detail.slides.join(', ') }) : <span className="text-gray-400">{t('没有')}</span>}
              </dd>
            </dl>

            <div className="mt-6">
              <button
                type="button"
                onClick={() => open(detail)}
                className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700"
              >
                <FileText size={14} />
                {t('在论文里打开')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ResultsLibrary;
