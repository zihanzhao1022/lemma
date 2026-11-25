import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy as CopyIcon, FileText, GitCompareArrows, Image as ImageIcon, MonitorPlay, Plus, Quote, Search, Table2, X } from 'lucide-react';
import BlockView from '../../components/results/BlockView';
import { ResultsAccess, ResultsAccessContext } from '../../components/results/access';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import { resultsCommitMessage } from '../../editor/results/ops';
import { slidesPath } from '../../editor/results/slidesFile';
import { useT } from '../../lib/phrases/app';
import { FloatKind, ResultPaper } from '../../types';
import { LabelWords, nodeLabels } from '../logic/labels';
import { blockNumber } from '../../lib/headings';
import { LibraryItem, filterItems, libraryItems } from './results';
import Thumb from './Thumb';
import { useSyncWords } from './SyncDialog';
import { insertCopy } from './transfer';

const InsertIntoDialog = lazy(() => import('./CarryDialogs').then((module) => ({ default: module.InsertIntoDialog })));
const SyncDialog = lazy(() => import('./SyncDialog'));

interface Props {
  login: string;
  /** The account's own papers that are not archived, in the order the list shows them. */
  papers: ResultPaper[];
  /** All of them, archived ones too: where copies and the blocks they came from are looked for. */
  all: ResultPaper[];
  access: ResultsAccess;
  save: ResultsSave;
  /** Compiles a paper's changed blocks. */
  compile: (paperId: string) => void;
  /**
   * One paper's view (its Results tab): its own figures and tables, then the copies it took from other papers.
   * Opening a block goes through `onOpen`; `onImport` offers to insert one from the library.
   */
  scope?: { paper: ResultPaper; onOpen: (paper: ResultPaper, blockId: string) => void; onImport?: () => void };
}

/** Where an item is used, in a line: cited in the text, on slides. */
const Uses: React.FC<{ item: LibraryItem }> = ({ item }) => {
  const t = useT();
  if (item.citedBy.length === 0 && item.slides.length === 0 && item.copies.length === 0) return <span className="text-gray-400">{t('正文和幻灯片里都还没有用到')}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {item.citedBy.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <Quote size={12} />
          {t('正文引用 {n} 处', { n: item.citedBy.length })}
        </span>
      )}
      {item.copies.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <CopyIcon size={12} />
          {t('{n} 篇论文里有副本', { n: new Set(item.copies.map((copy) => copy.paper.id)).size })}
          {item.copies.some((copy) => copy.state !== 'synced') && <span className="h-1.5 w-1.5 rounded-full bg-violet-500" title={t('有副本和库里的版本不一致')} />}
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
const ResultsLibrary: React.FC<Props> = ({ login, papers, all, access, save, compile, scope }) => {
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

  const items = useMemo(
    () => libraryItems(papers, Object.fromEntries(Object.entries(htmlDecks).map(([id, deck]) => [id, deck.text])), all),
    [papers, htmlDecks, all],
  );
  const syncWords = useSyncWords();
  // Inserting the item shown into another paper; comparing one of its copies with it.
  const [inserting, setInserting] = useState(false);
  const [syncing, setSyncing] = useState<{ paperId: string; blockId: string } | null>(null);
  const scoped = scope?.paper;
  const shown = useMemo(() => filterItems(items, { kind, paper: (scoped?.id ?? paperId) || undefined, search }), [items, kind, paperId, search, scoped]);
  // In one paper's view: the copies it took from other papers, each with the item it came from and its number here.
  const taken = useMemo(() => {
    if (!scoped) return [];
    return filterItems(items, { kind, search }).flatMap((item) =>
      item.copies
        .filter((copy) => copy.paper.id === scoped.id)
        .map((copy) => ({ item, copy, number: blockNumber(scoped.blocks, scoped.blocks.findIndex((block) => block.id === copy.block.id)) })),
    );
  }, [items, kind, search, scoped]);
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
  // What the chips count: everything, or in one paper's view its own items and the copies it took.
  const counted = useMemo(
    () => (scoped ? [...items.filter((item) => item.paper.id === scoped.id), ...items.flatMap((item) => item.copies.filter((copy) => copy.paper.id === scoped.id).map(() => item))] : items),
    [items, scoped],
  );
  const counts = useMemo(
    () => ({
      figure: counted.filter((item) => item.kind === 'figure').length,
      table: counted.filter((item) => item.kind === 'table').length,
    }),
    [counted],
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
  const openBlock = (paper: ResultPaper, blockId: string) =>
    scope ? scope.onOpen(paper, blockId) : navigate(`/p/${login}/${paper.slug}?block=${encodeURIComponent(blockId)}`);
  const open = (item: LibraryItem) => openBlock(item.paper, item.block.id);
  const detail = chosen ? items.find((item) => item.key === chosen) : undefined;
  const detailLabels = useMemo(() => (detail ? nodeLabels(detail.paper, words) : {}), [detail, words]);

  useEffect(() => {
    if (!detail) return undefined;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && !inserting && !syncing && setChosen(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [detail, inserting, syncing]);

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm transition-colors duration-150 ${active ? 'bg-white text-gray-900 shadow-sm ring-1 ring-black/[0.06]' : 'text-gray-600 hover:bg-black/[0.04]'}`;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        {scoped ? (
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="galley-display text-[1.6rem] text-gray-900">{t('本文的成果')}</h1>
            {scope?.onImport && (
              <button type="button" onClick={scope.onImport} className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-sm text-gray-700 hover:bg-gray-50">
                <Plus size={14} />
                {t('从成果库插入')}
              </button>
            )}
          </div>
        ) : (
          <h1 className="galley-display text-[2rem] text-gray-900">{t('成果管理')}</h1>
        )}
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
          {t('全部成果')} <span className="text-gray-400">{counted.length}</span>
        </button>
        <button type="button" className={chip(kind === 'figure')} onClick={() => setKind('figure')}>
          <ImageIcon size={14} />
          {t('图')} <span className="text-gray-400">{counts.figure}</span>
        </button>
        <button type="button" className={chip(kind === 'table')} onClick={() => setKind('table')}>
          <Table2 size={14} />
          {t('表格')} <span className="text-gray-400">{counts.table}</span>
        </button>
        {!scoped && (
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
        )}
      </div>

      {groups.length === 0 && taken.length === 0 ? (
        <p className="px-3 py-14 text-gray-800">
          {counted.length > 0 ? t('没有找到这样的图或表格') : scoped ? t('这篇论文还没有图和表格。') : t('你的论文里还没有图和表格。')}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.paper.id} className="mt-8">
            <h2 className="flex items-baseline gap-2 border-b border-black/[0.06] pb-2">
              <span className="truncate text-base font-medium text-gray-900">{scoped ? t('本文的图和表格') : group.paper.title}</span>
              {!scoped && group.paper.venue && <span className="truncate text-sm text-gray-400">{group.paper.venue}</span>}
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
                    <Thumb block={item.block} alt={item.caption} readFile={access.readFile} />
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

      {taken.length > 0 && (
        <section className="mt-8">
          <h2 className="flex items-baseline gap-2 border-b border-black/[0.06] pb-2">
            <span className="text-base font-medium text-gray-900">{t('从其他论文引用的')}</span>
            <span className="ml-auto shrink-0 text-xs text-gray-400">{taken.length}</span>
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {taken.map(({ item, copy, number }) => (
              <li key={copy.block.id}>
                <button
                  type="button"
                  onClick={() => setChosen(item.key)}
                  className="galley-press block w-full rounded-xl bg-[#f5f5f7] p-2 text-left transition-shadow duration-150 hover:shadow-[0_0_0_2px_rgba(167,139,250,0.55)]"
                >
                  <Thumb block={copy.block} alt={item.caption} readFile={access.readFile} />
                  <div className="px-1.5 pb-1 pt-2.5">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-900">{copy.block.kind === 'figure' ? words.figure(number) : words.table(number)}</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded px-1.5 text-xs ${copy.state === 'synced' ? 'bg-gray-200 text-gray-600' : 'bg-violet-100 text-violet-800'}`}
                      >
                        <GitCompareArrows size={11} />
                        {syncWords[copy.state]}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-gray-500">{t('来自《{title}》', { title: item.paper.title })}</p>
                    <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-gray-600">{item.caption || <span className="text-gray-400">{t('没有图注')}</span>}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
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
              <dt className="text-gray-500">{t('副本')}</dt>
              <dd className="text-gray-800">
                {detail.copies.length === 0 ? (
                  <span className="text-gray-400">{t('还没有放进别的论文')}</span>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.copies.map((copy) => (
                      <li key={`${copy.paper.id}/${copy.block.id}`} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{copy.paper.title}</span>
                        <button
                          type="button"
                          onClick={() => setSyncing({ paperId: copy.paper.id, blockId: copy.block.id })}
                          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs ${copy.state === 'synced' ? 'text-gray-500 hover:bg-gray-100' : 'bg-violet-50 text-violet-800 hover:bg-violet-100'}`}
                        >
                          <GitCompareArrows size={12} />
                          {syncWords[copy.state]}
                        </button>
                        <button
                          type="button"
                          onClick={() => openBlock(copy.paper, copy.block.id)}
                          className="shrink-0 rounded-md px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100"
                        >
                          {t('打开')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => open(detail)}
                className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700"
              >
                <FileText size={14} />
                {t('在论文里打开')}
              </button>
              <button
                type="button"
                onClick={() => setInserting(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                <Plus size={14} />
                {t('插入到另一篇论文')}
              </button>
            </div>
          </div>
        </div>
      )}
      {detail && inserting && (
        <Suspense fallback={null}>
          <InsertIntoDialog
            home={{ paper: detail.paper, block: detail.block }}
            name={name(detail)}
            papers={papers}
            readFile={access.readFile}
            onInsert={(target) => async (plan, home, choices) => {
              const made = await insertCopy(plan, home, choices, access.readFile, t('从《{title}》带来的定义', { title: plan.from.title }));
              await save(made.op, made.writes, [], resultsCommitMessage('insert a result from the library into', target.title), `content: update result "${target.title}"`);
              compile(target.id);
            }}
            onClose={() => setInserting(false)}
          />
        </Suspense>
      )}
      {syncing &&
        (() => {
          const copyPaper = all.find((paper) => paper.id === syncing.paperId);
          const copyBlock = copyPaper?.blocks.find((block) => block.id === syncing.blockId);
          if (!copyPaper || !copyBlock?.origin) return null;
          return (
            <Suspense fallback={null}>
              <SyncDialog
                copy={{ paper: copyPaper, block: copyBlock }}
                name={t('《{title}》里的副本', { title: copyPaper.title })}
                papers={all}
                readFile={access.readFile}
                save={save}
                compile={compile}
                onClose={() => setSyncing(null)}
              />
            </Suspense>
          );
        })()}
    </div>
  );
};

export default ResultsLibrary;
