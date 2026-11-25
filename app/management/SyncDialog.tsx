import React, { useEffect, useMemo, useState } from 'react';
import type { ReadFile } from '../../editor/results/actions';
import { describeSaveError } from '../../editor/backend';
import type { ResultsSave } from '../../editor/results/BlockEditor';
import { resultsCommitMessage } from '../../editor/results/ops';
import { useT } from '../../lib/phrases/app';
import { ResultPaper } from '../../types';
import { SyncState, diffLines, homeOf, homeSource, mergeThree, syncState } from './carry';
import { CarrySummary, DIALOG_BUTTON, DIALOG_PRIMARY, DialogFrame } from './CarryDialogs';
import { CarryChoices, CarryPlan, CopyRef, addsAnything, planPull, planPush, pullOps, pushOps, suggestedChoices } from './transfer';

/** What each state says. */
export const useSyncWords = (): Record<SyncState, string> => {
  const t = useT();
  return {
    synced: t('和库里一致'),
    behind: t('库里有更新'),
    ahead: t('本文有改动，还没推送到库'),
    diverged: t('两边都改了'),
    orphan: t('原来的图表已经删除'),
  };
};

const MARKERS = /^(<<<<<<<|=======|>>>>>>>)( |$)/m;

/** Comparing a copied figure or table with the block it came from, and bringing them together. */
const SyncDialog: React.FC<{
  copy: CopyRef;
  name: string;
  /** All the owner's papers. */
  papers: ResultPaper[];
  readFile: ReadFile;
  save: ResultsSave;
  /** Compiles a paper's changed blocks. */
  compile: (paperId: string) => void;
  onClose: () => void;
}> = ({ copy, name, papers, readFile, save, compile, onClose }) => {
  const t = useT();
  const words = useSyncWords();
  const { paper: copyPaper, block: copyBlock } = copy;
  const origin = copy.block.origin!;
  const home = homeOf(origin, papers);
  const state = syncState(copy.block, papers) ?? 'synced';
  const mine = copy.block.source ?? '';
  const theirs = home ? homeSource(origin, home.block) : '';
  const [merged, setMerged] = useState(() => mergeThree(origin.base, mine, theirs, { mine: t('本文'), theirs: t('库') }).text);
  const [plans, setPlans] = useState<{ pull: CarryPlan | null; push: CarryPlan | null }>({ pull: null, push: null });
  const [choices, setChoices] = useState<{ pull: CarryChoices; push: CarryChoices }>({ pull: { packages: [] }, push: { packages: [] } });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const diff = useMemo(() => diffLines(theirs, mine), [theirs, mine]);

  useEffect(() => {
    let cancelled = false;
    const ref = { paper: copyPaper, block: copyBlock };
    void Promise.all([planPull(ref, papers, readFile), planPush(ref, papers, readFile)]).then(
      ([pull, push]) => {
        if (cancelled) return;
        setPlans({ pull, push });
        setChoices({ pull: pull ? suggestedChoices(pull) : { packages: [] }, push: push ? suggestedChoices(push) : { packages: [] } });
      },
      (error: unknown) => !cancelled && setProblem(describeSaveError(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [copyPaper, copyBlock, papers, readFile]);

  const note = t('从《{title}》带来的定义', { title: home?.paper.title ?? '' });
  const run = async (work: () => Promise<void>) => {
    setSaving(true);
    setProblem(null);
    try {
      await work();
      onClose();
    } catch (error) {
      setProblem(describeSaveError(error));
      setSaving(false);
    }
  };
  /** Takes the home's version, or `source` (a merge) while agreeing with the home's version. */
  const pull = (source?: string) =>
    run(async () => {
      if (!plans.pull) return;
      const made = await pullOps(copy, plans.pull, choices.pull, readFile, note, source);
      await save(made.op, made.writes, [], resultsCommitMessage('pull from the library into', copy.paper.title), `content: update result "${copy.paper.title}"`);
      compile(copy.paper.id);
    });
  /** Gives the home this copy's version, or `source` (a merge, which the copy takes too). */
  const push = (source?: string) =>
    run(async () => {
      const plan = source === undefined ? plans.push : await planPush(copy, papers, readFile, source);
      if (!plan || !home) return;
      const made = await pushOps(copy, plan, source === undefined ? choices.push : suggestedChoices(plan), readFile, t('从《{title}》带来的定义', { title: copy.paper.title }), source);
      await save(made.op, made.writes, [], resultsCommitMessage(`push "${copy.paper.title}" to the library in`, home.paper.title), `content: update result "${home.paper.title}"`);
      compile(home.paper.id);
      if (source !== undefined) compile(copy.paper.id);
    });
  const unlink = () =>
    run(async () => {
      await save({ kind: 'setOrigin', paperId: copy.paper.id, blockId: copy.block.id, origin: null }, [], [], resultsCommitMessage('unlink a copy in', copy.paper.title), `content: update result "${copy.paper.title}"`);
    });

  const conflicted = MARKERS.test(merged);
  const footer = (
    <>
      {problem && <p role="alert" className="mr-auto text-sm text-red-600">{problem}</p>}
      <button type="button" className={`${DIALOG_BUTTON} ${problem ? '' : 'mr-auto'}`} disabled={saving} onClick={() => void unlink()} title={t('之后这一块和库里的版本互不影响')}>
        {t('解除关联')}
      </button>
      {state === 'behind' && (
        <button type="button" className={DIALOG_PRIMARY} disabled={saving || !plans.pull} onClick={() => void pull()}>
          {t('拉取库里的版本')}
        </button>
      )}
      {state === 'ahead' && (
        <>
          <button type="button" className={DIALOG_BUTTON} disabled={saving || !plans.pull} onClick={() => void pull()}>
            {t('放弃本文的改动')}
          </button>
          <button type="button" className={DIALOG_PRIMARY} disabled={saving || !plans.push} onClick={() => void push()}>
            {t('推送到库')}
          </button>
        </>
      )}
      {state === 'diverged' && (
        <>
          <button type="button" className={DIALOG_BUTTON} disabled={saving || !plans.pull} onClick={() => void pull()}>
            {t('用库里的版本')}
          </button>
          <button type="button" className={DIALOG_BUTTON} disabled={saving || conflicted || !plans.pull} onClick={() => void pull(merged)}>
            {t('合并，只更新本文')}
          </button>
          <button type="button" className={DIALOG_PRIMARY} disabled={saving || conflicted || !plans.push} onClick={() => void push(merged)}>
            {t('合并并推送到库')}
          </button>
        </>
      )}
      {(state === 'synced' || state === 'orphan') && (
        <button type="button" className={DIALOG_PRIMARY} onClick={onClose}>
          {t('完成')}
        </button>
      )}
    </>
  );

  return (
    <DialogFrame title={t('{name}和库里的版本', { name })} onClose={onClose} footer={footer} wide>
      <p className="text-sm text-gray-700">
        <span className="font-medium">{words[state]}</span>
        {home && <span className="text-gray-500"> · {t('库里的版本在《{title}》', { title: home.paper.title })}</span>}
      </p>
      {state === 'orphan' && <p className="mt-2 text-sm text-gray-500">{t('它来自的论文或图表已经删除，现在它就是本文自己的图表。解除关联后会作为一项单独的成果列出。')}</p>}

      {(state === 'behind' || state === 'ahead') && (
        <>
          <p className="mt-3 text-xs text-gray-500">{t('红色是只在库里的行，绿色是只在本文的行。')}</p>
          <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-gray-50 py-1.5 text-[12px] leading-relaxed">
            {diff.map((line, index) => (
              <div key={index} className={line.kind === 'del' ? 'bg-red-50 text-red-800' : line.kind === 'add' ? 'bg-green-50 text-green-800' : 'text-gray-700'}>
                <span className="inline-block w-5 select-none text-center text-gray-400">{line.kind === 'del' ? '−' : line.kind === 'add' ? '+' : ' '}</span>
                {line.text}
              </div>
            ))}
          </pre>
        </>
      )}

      {state === 'diverged' && (
        <>
          <p className="mt-3 text-sm text-gray-600">
            {t('下面是自动合并的结果。两边改了同一处的地方用 <<<<<<< 和 >>>>>>> 标出来，上面是本文的，下面是库里的；改好并删掉这些标记后才能保存。')}
          </p>
          <textarea
            value={merged}
            onChange={(event) => setMerged(event.target.value)}
            spellCheck={false}
            rows={14}
            className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-[12px] leading-relaxed focus:border-purple-500 focus:outline-none"
          />
        </>
      )}

      {state === 'behind' && plans.pull && addsAnything(plans.pull, choices.pull) && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-gray-700">{t('拉取时一起带过来：')}</p>
          <CarrySummary plan={plans.pull} choices={choices.pull} onChoices={(next) => setChoices((current) => ({ ...current, pull: next }))} />
        </div>
      )}
      {state === 'ahead' && plans.push && addsAnything(plans.push, choices.push) && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-gray-700">{t('推送时一起带到《{title}》：', { title: plans.push.to.title })}</p>
          <CarrySummary plan={plans.push} choices={choices.push} onChoices={(next) => setChoices((current) => ({ ...current, push: next }))} />
        </div>
      )}
    </DialogFrame>
  );
};

export default SyncDialog;
