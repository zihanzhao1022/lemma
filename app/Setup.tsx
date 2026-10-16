import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Loader2, Lock, RefreshCw } from 'lucide-react';
import { useMessage } from '../lib/i18n';
import { useT } from '../lib/phrases/app';
import { NAME } from './brand';
import { Account } from './accounts';
import Avatar from './Avatar';
import { startInstall } from './github/auth';
import { SUGGESTED_REPO } from './github/config';
import { LemmaRepo, RepoStatus, initializeRepo, newRepoUrl, reachableRepos, rememberRepo, repoLabel, repoStatus, validRepoName } from './github/repo';
import { authorizedFetch } from './github/session';

/** The name being created on GitHub, kept across the trip there and back. */
const NEW_REPO_KEY = 'lemma-new-repo';

function newRepoName(): string | null {
  try {
    return sessionStorage.getItem(NEW_REPO_KEY);
  } catch {
    return null;
  }
}

function setNewRepoName(name: string | null): void {
  try {
    if (name) sessionStorage.setItem(NEW_REPO_KEY, name);
    else sessionStorage.removeItem(NEW_REPO_KEY);
  } catch {
    // Then the repository is found among the others.
  }
}

interface Found {
  repo: LemmaRepo;
  status: RepoStatus;
}

type Stage =
  | { kind: 'looking' }
  | { kind: 'form'; found: Found[] }
  /** Created on GitHub's form, in another tab; Lemma still to be installed on it. */
  | { kind: 'confirm'; name: string; missing: boolean }
  | { kind: 'starting'; repo: LemmaRepo }
  | { kind: 'failed' };

const FIELD = 'rounded-lg border border-gray-300 bg-white transition-[border-color,box-shadow] duration-150 focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-100';
const PRIMARY = 'inline-flex items-center gap-2 rounded-full bg-violet-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-40';

/** A text field that offers `suggestion` in grey until something else is typed; Tab takes it. */
const SuggestingInput: React.FC<{ id: string; value: string; onChange: (value: string) => void; suggestion: string; describedBy?: string }> = ({ id, value, onChange, suggestion, describedBy }) => {
  const rest = suggestion.startsWith(value) ? suggestion.slice(value.length) : '';
  const text = 'px-3 py-2 text-[15px] leading-6';
  return (
    <div className={`relative ${FIELD}`}>
      {/* What is typed, invisibly, so the rest of the suggestion lines up after it. */}
      <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre ${text}`}>
        <span className="invisible">{value}</span>
        <span className="text-gray-400">{rest}</span>
      </div>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Tab' && !event.shiftKey && rest) {
            event.preventDefault();
            onChange(suggestion);
          }
        }}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        className={`relative w-full bg-transparent outline-none ${text}`}
      />
    </div>
  );
};

/** A step of the form, numbered like GitHub's, with a line down to the next. */
const Step: React.FC<{ number: number; title: string; last?: boolean; children: React.ReactNode }> = ({ number, title, last, children }) => (
  <section className="relative pl-12">
    <span className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full bg-[#f5f5f7] text-sm tabular-nums text-gray-600">{number}</span>
    {!last && <span aria-hidden="true" className="absolute bottom-0 left-4 top-10 w-px bg-gray-200" />}
    <h2 className="pt-1 text-lg font-semibold text-gray-900">{title}</h2>
    <div className={`mt-4 ${last ? '' : 'pb-10'}`}>{children}</div>
  </section>
);

/**
 * The first time an account signs in: a repository for its papers. Lemma never sees an account's other
 * repositories, so the repository is created on GitHub's own form (filled in from here) and the App installed
 * on it; back here, Lemma starts its files in it. An account with a Lemma repository already goes straight on.
 */
const Setup: React.FC<{ account: Account; onConnect: (repo: LemmaRepo) => void }> = ({ account, onConnect }) => {
  const t = useT();
  const [stage, setStage] = useState<Stage>({ kind: 'looking' });
  const [name, setName] = useState(() => newRepoName() ?? '');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [problem, setProblem] = useMessage();
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  // One look or start at a time: React may run the first look twice, and a repository is started only once.
  const busy = useRef<Promise<void> | null>(null);

  const connect = useCallback(
    (repo: LemmaRepo) => {
      setNewRepoName(null);
      rememberRepo(account.login, repo);
      onConnectRef.current(repo);
    },
    [account.login],
  );

  const start = useCallback(
    async (found: Found) => {
      setStage({ kind: 'starting', repo: found.repo });
      setProblem(null);
      try {
        const repo = found.status === 'lemma' ? found.repo : await initializeRepo(found.repo, found.status === 'fresh' ? 'fresh' : 'empty', window.location.origin, authorizedFetch());
        connect(repo);
      } catch {
        setProblem(() => t('没能在 {repo} 里写入 {name} 的文件，请稍后重试', { repo: repoLabel(found.repo), name: NAME }));
        setStage({ kind: 'failed' });
      }
    },
    [connect, setProblem, t],
  );

  const find = useCallback(async () => {
    setStage({ kind: 'looking' });
    setProblem(null);
    try {
      const fetchImpl = authorizedFetch();
      const repos = await reachableRepos(account.login, fetchImpl);
      const found = await Promise.all(repos.map(async (repo): Promise<Found> => ({ repo, status: await repoStatus(repo, fetchImpl) })));
      const wanted = newRepoName();
      const created = wanted ? found.find((item) => item.repo.name.toLowerCase() === wanted.toLowerCase()) : undefined;
      if (created && created.status !== 'other' && created.status !== 'missing') {
        await start(created);
        return;
      }
      const lemma = found.filter((item) => item.status === 'lemma');
      if (!wanted && lemma.length === 1) {
        connect(lemma[0].repo);
        return;
      }
      // Halfway through: created on GitHub, perhaps, but Lemma not installed on it yet.
      if (wanted && !created) {
        setStage({ kind: 'confirm', name: wanted, missing: true });
        return;
      }
      setStage({ kind: 'form', found });
    } catch {
      setProblem(() => t('没能读到你在 GitHub 上的仓库，请稍后重试'));
      setStage({ kind: 'failed' });
    }
  }, [account.login, connect, start, setProblem, t]);

  const look = useCallback(() => {
    busy.current ??= find().finally(() => {
      busy.current = null;
    });
    return busy.current;
  }, [find]);
  const use = (found: Found) => {
    busy.current ??= start(found).finally(() => {
      busy.current = null;
    });
  };

  // Once, when the page opens.
  const first = useRef(look);
  useEffect(() => {
    void first.current();
  }, []);

  const validName = validRepoName(name);
  const openGitHub = (repoName: string) => window.open(newRepoUrl(account.login, repoName, description, isPrivate), '_blank', 'noopener');
  const create = () => {
    if (!validName) return;
    setNewRepoName(name);
    openGitHub(name);
    setStage({ kind: 'confirm', name, missing: false });
  };

  if (stage.kind === 'looking' || stage.kind === 'starting') {
    return (
      <p className="flex items-center justify-center gap-2 py-28 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" />
        {stage.kind === 'looking' ? t('正在查找你的仓库…') : t('正在准备 {repo}…', { repo: repoLabel(stage.repo) })}
      </p>
    );
  }

  if (stage.kind === 'failed') {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <p role="alert" className="text-gray-800">
          {problem}
        </p>
        <button type="button" onClick={() => void look()} className={`mt-6 ${PRIMARY}`}>
          <RefreshCw size={15} />
          {t('重试')}
        </button>
      </div>
    );
  }

  if (stage.kind === 'confirm') {
    const label = `${account.login}/${stage.name}`;
    return (
      <div className="mx-auto max-w-2xl py-14">
        <h1 className="galley-display text-[clamp(1.75rem,1.2rem+1.6vw,2.25rem)] text-[#1d1d1f]">{t('在 GitHub 上建好，再把 {name} 装上', { name: NAME })}</h1>
        {stage.missing && (
          <p role="status" className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {t('还没找到 {repo}。确认它在 GitHub 上建好了，并且安装 {name} 时勾选了它。', { repo: label, name: NAME })}
          </p>
        )}
        <ol className="mt-10 space-y-10">
          <li>
            <Step number={1} title={t('在 GitHub 上点 Create repository')}>
              <p className="text-[15px] leading-relaxed text-gray-600">{t('新打开的页面已经填好了仓库名和说明，确认后点页面底部的 Create repository。')}</p>
              <button type="button" onClick={() => openGitHub(stage.name)} className="mt-3 text-sm text-violet-700 hover:underline">
                {t('没有打开？再打开一次')}
              </button>
            </Step>
          </li>
          <li>
            <Step number={2} title={t('把 {name} 装到这个仓库上', { name: NAME })} last>
              <p className="text-[15px] leading-relaxed text-gray-600">
                {t('在 GitHub 上选 Only select repositories，勾选 {repo}，再点 Install。{name} 只能读写你勾选的仓库。', { repo: label, name: NAME })}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
                <button type="button" onClick={() => startInstall('#/setup')} className={PRIMARY}>
                  {t('把 {name} 装到 {repo}', { name: NAME, repo: label })}
                </button>
                <button type="button" onClick={() => void look()} className="text-sm text-gray-600 hover:text-gray-900">
                  {t('已经装好了？重新查找')}
                </button>
              </div>
            </Step>
          </li>
        </ol>
        <button
          type="button"
          onClick={() => {
            setNewRepoName(null);
            setStage({ kind: 'form', found: [] });
          }}
          className="mt-12 text-sm text-gray-500 hover:text-gray-800"
        >
          {t('返回修改')}
        </button>
      </div>
    );
  }

  const usable = stage.found.filter((item) => item.status !== 'missing');
  return (
    <div className="mx-auto max-w-2xl py-14">
      <h1 className="galley-display text-[clamp(1.75rem,1.2rem+1.6vw,2.25rem)] text-[#1d1d1f]">{t('新建一个仓库存放论文')}</h1>
      <p className="galley-prose mt-3 text-[15px] leading-relaxed text-gray-600">
        {t('论文、编译好的 PDF 和附件都存在你 GitHub 账号下的这个仓库里，以后新建的论文也默认放在这里。{name} 只读写这一个仓库。', { name: NAME })}
      </p>

      <form
        className="mt-10"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <Step number={1} title={t('基本信息')}>
          <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-end gap-x-3 gap-y-1.5">
            <span className="text-sm font-medium text-gray-700">{t('所有者')}</span>
            <span />
            <label htmlFor="repo-name" className="text-sm font-medium text-gray-700">
              {t('仓库名')} <span className="text-red-600">*</span>
            </label>
            <span className="flex items-center gap-2 rounded-lg border border-gray-200 bg-[#f5f5f7] px-3 py-2 text-[15px] leading-6 text-gray-800">
              <Avatar account={account} size={22} />
              {account.login}
            </span>
            <span aria-hidden="true" className="pb-2 text-xl text-gray-400">
              /
            </span>
            <SuggestingInput id="repo-name" value={name} onChange={setName} suggestion={SUGGESTED_REPO} describedBy="repo-name-hint" />
          </div>
          <p id="repo-name-hint" className="mt-3 text-sm text-gray-600">
            {name && !validName ? (
              <span className="text-red-700">{t('只能用英文字母、数字和 - _ .')}</span>
            ) : (
              <>
                {t('名字短一点、好记就行。用')}{' '}
                <button type="button" onClick={() => setName(SUGGESTED_REPO)} className="font-medium text-violet-700 hover:underline">
                  {SUGGESTED_REPO}
                </button>
                {t('？按 Tab 填入。')}
              </>
            )}
          </p>
          <label className="mt-6 block">
            <span className="text-sm font-medium text-gray-700">{t('说明（可以不填）')}</span>
            <div className={`mt-1.5 ${FIELD}`}>
              <input value={description} onChange={(event) => setDescription(event.target.value.slice(0, 350))} className="w-full bg-transparent px-3 py-2 text-[15px] leading-6 outline-none" />
            </div>
          </label>
        </Step>

        <Step number={2} title={t('谁能看到')} last>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">{t('谁能看到')}</legend>
            {(
              [
                [true, Lock, t('私有'), t('只有你能看到。论文还没发表时选这个。')],
                [false, Globe, t('公开'), t('任何人都能看到仓库里的所有内容，包括 LaTeX 源码。')],
              ] as const
            ).map(([value, Icon, title, body]) => (
              <label
                key={title}
                className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors duration-150 ${isPrivate === value ? 'border-violet-500 bg-violet-50/50' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <input type="radio" name="visibility" checked={isPrivate === value} onChange={() => setPrivate(value)} className="mt-1 accent-violet-700" />
                <span>
                  <span className="flex items-center gap-1.5 font-medium text-gray-900">
                    <Icon size={15} className="text-gray-500" />
                    {title}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-gray-600">{body}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <button type="submit" disabled={!validName} className={PRIMARY}>
              {t('创建仓库')}
            </button>
            <span className="text-sm text-gray-500">{t('会在 GitHub 上打开一个填好的新建页面，你在那里确认。')}</span>
          </div>
        </Step>
      </form>

      {usable.length > 0 && (
        <section className="mt-16 border-t border-gray-200 pt-8">
          <h2 className="text-lg font-semibold text-gray-900">{t('或者用已经装了 {name} 的仓库', { name: NAME })}</h2>
          <ul className="mt-4 space-y-2">
            {usable.map((item) => {
              const open = item.status !== 'other';
              return (
                <li key={repoLabel(item.repo)} className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3">
                  {item.repo.private ? <Lock size={14} className="text-gray-400" /> : <Globe size={14} className="text-gray-400" />}
                  <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{repoLabel(item.repo)}</span>
                  <span className="shrink-0 text-sm text-gray-500">
                    {item.status === 'lemma' ? t('{name} 的仓库', { name: NAME }) : open ? t('空仓库，可以用') : t('里面已经有别的文件')}
                  </span>
                  <button type="button" disabled={!open} onClick={() => use(item)} className="shrink-0 rounded-full border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                    {t('使用')}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
};

export default Setup;
