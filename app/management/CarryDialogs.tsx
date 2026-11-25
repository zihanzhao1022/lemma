import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Search, X } from 'lucide-react';
import type { ReadFile } from '../../editor/results/actions';
import { describeSaveError } from '../../editor/backend';
import { useT } from '../../lib/phrases/app';
import { ResultBlock, ResultPaper } from '../../types';
import { LibraryItem, filterItems, libraryItems } from './results';
import Thumb from './Thumb';
import { CarryChoices, CarryPlan, planCarry, suggestedChoices } from './transfer';

/** What carrying a source brings along, with the packages to choose. */
export const CarrySummary: React.FC<{ plan: CarryPlan; choices: CarryChoices; onChoices: (next: CarryChoices) => void }> = ({ plan, choices, onChoices }) => {
  const t = useT();
  const nothing = plan.copies.length === 0 && plan.definitions.length === 0 && plan.packages.length === 0 && plan.bib.keys.length === 0;
  const head = 'text-xs font-medium text-gray-500';
  return (
    <div className="space-y-4 text-sm">
      {plan.clashes.length > 0 && (
        <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{t('《{title}》里已经有同名的 label：{labels}。\\ref 会指向其中一个，插入后最好改掉一个。', { title: plan.to.title, labels: plan.clashes.join(', ') })}</span>
        </p>
      )}
      {nothing && <p className="text-gray-500">{t('不需要额外的附件、导言区定义或参考文献。')}</p>}
      {plan.copies.length > 0 && (
        <section>
          <h3 className={head}>{t('一起复制的附件')}</h3>
          <ul className="mt-1 space-y-0.5 font-mono text-[13px] text-gray-800">
            {plan.copies.map((copy) => (
              <li key={copy.to}>
                {copy.to}
                {copy.to !== copy.from && <span className="ml-2 font-sans text-xs text-gray-500">{t('（本文已有同名文件，放进了文件夹）')}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.definitions.length > 0 && (
        <section>
          <h3 className={head}>{t('加到导言区的定义')}</h3>
          <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-gray-50 px-2 py-1.5 text-[12px] leading-relaxed text-gray-800">{plan.definitions.map((item) => item.text).join('\n')}</pre>
        </section>
      )}
      {plan.packages.length > 0 && (
        <section>
          <h3 className={head}>{t('《{title}》用到、本文没有加载的宏包', { title: plan.from.title })}</h3>
          <p className="mt-0.5 text-xs text-gray-500">{t('默认只勾选排版图表用的宏包；字体、页面、模板类的宏包会改变整篇论文。')}</p>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {plan.packages.map((item) => (
              <li key={item.name}>
                <label className="inline-flex items-center gap-1.5 font-mono text-[13px] text-gray-800">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-violet-700"
                    checked={choices.packages.includes(item.name)}
                    onChange={(event) =>
                      onChoices({ packages: event.target.checked ? [...choices.packages, item.name] : choices.packages.filter((name) => name !== item.name) })
                    }
                  />
                  {item.name}
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.bib.keys.length > 0 && (
        <section>
          <h3 className={head}>{t('加到 references.bib 的条目')}</h3>
          <p className="mt-1 font-mono text-[13px] text-gray-800">{plan.bib.keys.join(', ')}</p>
        </section>
      )}
    </div>
  );
};

/** A dialog's frame: title, a way back, closing. */
const Frame: React.FC<{ title: string; onClose: () => void; onBack?: () => void; wide?: boolean; children: React.ReactNode; footer?: React.ReactNode }> = ({
  title,
  onClose,
  onBack,
  wide = false,
  children,
  footer,
}) => {
  const t = useT();
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        className={`flex max-h-[min(90vh,52rem)] w-full flex-col rounded-xl bg-white shadow-xl ${wide ? 'max-w-4xl' : 'max-w-xl'}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-5 py-3">
          {onBack && (
            <button type="button" onClick={onBack} aria-label={t('返回')} className="-ml-1 rounded p-1 text-gray-500 hover:bg-gray-100">
              <ArrowLeft size={16} />
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('关闭')} className="rounded p-1 text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
};

export { Frame as DialogFrame };

const button = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50';
const primary = 'rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-60';
export const DIALOG_BUTTON = button;
export const DIALOG_PRIMARY = primary;

export type InsertResult = (plan: CarryPlan, home: ResultBlock, choices: CarryChoices) => Promise<void>;

/** Confirming one item into one paper: what comes along, then inserting. */
const ConfirmStep: React.FC<{
  home: { paper: ResultPaper; block: ResultBlock };
  target: ResultPaper;
  name: string;
  readFile: ReadFile;
  onInsert: InsertResult;
  onClose: () => void;
  onBack?: () => void;
}> = ({ home, target, name, readFile, onInsert, onClose, onBack }) => {
  const t = useT();
  const [plan, setPlan] = useState<CarryPlan | null>(null);
  const [choices, setChoices] = useState<CarryChoices>({ packages: [] });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { paper: homePaper, block: homeBlock } = home;
  useEffect(() => {
    let cancelled = false;
    planCarry(homeBlock.source ?? '', homePaper, target, readFile).then(
      (made) => {
        if (cancelled) return;
        setPlan(made);
        setChoices(suggestedChoices(made));
      },
      (error: unknown) => !cancelled && setProblem(describeSaveError(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [homePaper, homeBlock, target, readFile]);
  const insert = async () => {
    if (!plan) return;
    setSaving(true);
    setProblem(null);
    try {
      await onInsert(plan, home.block, choices);
      onClose();
    } catch (error) {
      setProblem(describeSaveError(error));
      setSaving(false);
    }
  };
  return (
    <Frame
      title={t('把{name}插入《{title}》', { name, title: target.title })}
      onClose={onClose}
      onBack={onBack}
      footer={
        <>
          {problem && <p role="alert" className="mr-auto text-sm text-red-600">{problem}</p>}
          <button type="button" className={button} onClick={onClose}>
            {t('取消')}
          </button>
          <button type="button" className={primary} disabled={!plan || saving} onClick={() => void insert()}>
            {saving ? t('正在插入…') : t('插入')}
          </button>
        </>
      }
    >
      <Thumb block={home.block} alt={name} readFile={readFile} className="h-52" />
      <p className="mt-2 text-xs text-gray-500">{t('来自《{title}》。插入的是一份副本：之后两边各自修改，可以随时从库里拉取更新，或把本文的改动推送回去。', { title: home.paper.title })}</p>
      <div className="mt-4">{plan ? <CarrySummary plan={plan} choices={choices} onChoices={setChoices} /> : !problem && <p className="text-sm text-gray-400">{t('正在检查需要的附件和定义…')}</p>}</div>
    </Frame>
  );
};

/** Inserting one item of the library into a paper the person picks (from the Management page). */
export const InsertIntoDialog: React.FC<{
  home: { paper: ResultPaper; block: ResultBlock };
  name: string;
  papers: ResultPaper[];
  readFile: ReadFile;
  onInsert: (target: ResultPaper) => InsertResult;
  onClose: () => void;
}> = ({ home, name, papers, readFile, onInsert, onClose }) => {
  const t = useT();
  const [target, setTarget] = useState<ResultPaper | null>(null);
  const others = papers.filter((paper) => paper.id !== home.paper.id);
  if (target) return <ConfirmStep home={home} target={target} name={name} readFile={readFile} onInsert={onInsert(target)} onClose={onClose} onBack={() => setTarget(null)} />;
  return (
    <Frame title={t('把{name}插入哪篇论文？', { name })} onClose={onClose}>
      {others.length === 0 ? (
        <p className="text-sm text-gray-500">{t('你还没有别的论文。')}</p>
      ) : (
        <ul className="space-y-1">
          {others.map((paper) => (
            <li key={paper.id}>
              <button type="button" onClick={() => setTarget(paper)} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-100">
                <span className="text-gray-900">{paper.title}</span>
                {paper.venue && <span className="ml-2 text-gray-400">{paper.venue}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-gray-500">{t('插在论文最后；之后可以在网页模式里拖到想要的位置。')}</p>
    </Frame>
  );
};

/** Picking a figure or table of the owner's other papers to insert into this one. */
export const ResultPicker: React.FC<{
  papers: ResultPaper[];
  target: ResultPaper;
  readFile: ReadFile;
  onInsert: InsertResult;
  onClose: () => void;
}> = ({ papers, target, readFile, onInsert, onClose }) => {
  const t = useT();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<LibraryItem | null>(null);
  const items = useMemo(() => libraryItems(papers).filter((item) => item.paper.id !== target.id), [papers, target.id]);
  const shown = useMemo(() => filterItems(items, { search }), [items, search]);
  const name = (item: LibraryItem) => (item.kind === 'figure' ? (item.number ? t('图 {n}', { n: item.number }) : t('图')) : item.number ? t('表 {n}', { n: item.number }) : t('表格'));
  if (chosen) {
    return (
      <ConfirmStep home={{ paper: chosen.paper, block: chosen.block }} target={target} name={name(chosen)} readFile={readFile} onInsert={onInsert} onClose={onClose} onBack={() => setChosen(null)} />
    );
  }
  return (
    <Frame title={t('从成果库插入')} onClose={onClose} wide>
      <label className="relative block">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="search"
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('搜索图注、label 或论文')}
          aria-label={t('搜索图注、label 或论文')}
          className="w-full rounded-xl border border-transparent bg-black/[0.04] py-2 pl-9 pr-3 text-sm outline-none focus:border-violet-300 focus:bg-white"
        />
      </label>
      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">{items.length === 0 ? t('你的其他论文里还没有图和表格。') : t('没有找到这样的图或表格')}</p>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((item) => {
            const here = item.copies.some((copy) => copy.paper.id === target.id);
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => setChosen(item)}
                  className="block w-full rounded-xl bg-[#f5f5f7] p-2 text-left transition-shadow duration-150 hover:shadow-[0_0_0_2px_rgba(167,139,250,0.55)]"
                >
                  <Thumb block={item.block} alt={item.caption} readFile={readFile} className="h-32" />
                  <div className="px-1 pt-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-900">{name(item)}</span>
                      {here && <span className="rounded bg-violet-100 px-1.5 text-xs text-violet-800">{t('本文已有副本')}</span>}
                    </div>
                    <p className="truncate text-xs text-gray-500">{item.paper.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-gray-600">{item.caption}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Frame>
  );
};
