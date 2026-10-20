import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { bundledContent } from '../content';
import { EditorToast, useResultsEditor } from '../editor/results/useResults';
import { createMockCollaboratorBackend, createMockResultsBackend, mockStore } from '../editor/results/mockBackend';
import { ResultsBackend } from '../editor/results/backend';
import { WorkerError } from '../editor/results/workerBackend';
import { SiteContent } from '../types';
import { ACCOUNTS, Account, collaboratorSession, connectedRepo, ownerSession, storeKeyOf } from './accounts';
import { repoBackend } from './github/backend';
import { LemmaRepo, repoLabel } from './github/repo';
import { Organizer, paperKey, tidy, touch } from './organizer';
import { examplesReady, loadOrganizer, saveOrganizer } from './seed';

/** Where an account's papers are: its GitHub repository, or a made-up account's store in this browser (`npm run dev:mock`). */
export type AccountSource = { kind: 'github'; repo: LemmaRepo } | { kind: 'mock' };

/** What the account can do besides keeping its own papers. */
export interface Features {
  /** Sharing papers with people, and papers others shared. */
  sharing: boolean;
  /** Papers anyone with the link can read. */
  publishing: boolean;
  /** Comments in the margin, and who is reading a paper. */
  comments: boolean;
}

// GitHub accounts keep their own papers for now; the made-up accounts show everything the app will do.
const GITHUB_FEATURES: Features = { sharing: false, publishing: false, comments: false };
const MOCK_FEATURES: Features = { sharing: true, publishing: true, comments: true };

/** One of the account's two lists of papers, with what saves to it. */
export type PaperList = ReturnType<typeof useResultsEditor> & { content: SiteContent };

export interface AccountValue {
  account: Account;
  /** owner/name of the repository the account's papers are in. */
  repo: string;
  features: Features;
  /** The account's own papers, in its repository. */
  mine: PaperList;
  /** Others' papers shared with the account, through the (mock) worker. */
  shared: PaperList;
  /** Whose repository a shared paper is in. */
  ownerOf: (paperId: string) => Account | undefined;
  /** The account's folders, tags and archive, over its own and shared papers. */
  organizer: Organizer;
  organize: (change: (organizer: Organizer) => Organizer) => void;
  /** Notes that the account just changed a paper, for "last modified". */
  touchPaper: (owner: string, paperId: string) => void;
  toast: EditorToast | null;
  setToast: (toast: EditorToast | null) => void;
}

const AccountContext = createContext<AccountValue | null>(null);

export const useAccount = (): AccountValue | null => useContext(AccountContext);

const noop = () => {};
const empty = (): SiteContent => ({ ...bundledContent, results: [] });

/** Others' papers shared with the account; an account nobody shared anything with simply has none. */
function sharedBackend(account: Account): ResultsBackend {
  const keys = ACCOUNTS.filter((other) => other.login !== account.login).map((other) => storeKeyOf(other.login));
  const inner = createMockCollaboratorBackend({ login: account.login, id: account.id }, keys);
  return {
    ...inner,
    async load() {
      try {
        return await inner.load();
      } catch (error) {
        if (error instanceof WorkerError && error.status === 403) return { state: 'ready', papers: [], roles: {} };
        throw error;
      }
    },
  };
}

/** Nothing is shared with a GitHub account yet. */
const NOTHING_SHARED: ResultsBackend = {
  load: async () => ({ state: 'ready', papers: [], roles: {} }),
  readFile: () => Promise.reject(new Error('nothing is shared')),
  save: () => Promise.reject(new Error('nothing is shared')),
  syncPublic: async () => null,
  resync: async () => null,
};

function useList(session: ReturnType<typeof ownerSession>, connect: () => Promise<ResultsBackend>, onToast: (toast: EditorToast | null) => void): PaperList {
  const [content, setContent] = useState(empty);
  const contentRef = useRef(content);
  contentRef.current = content;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const editor = useResultsEditor({
    session,
    setContent,
    contentRef,
    queue,
    onDeploy: noop,
    onToast,
    onSignedOut: noop,
    connect,
  });
  return { ...editor, content };
}

/** The signed-in account's papers: its own and those shared with it. */
export const AccountProvider: React.FC<{ account: Account; source: AccountSource; children: React.ReactNode }> = ({ account, source, children }) => {
  const [toast, setToast] = useState<EditorToast | null>(null);
  const [organizer, setOrganizer] = useState(() => loadOrganizer(account.login));
  const github = source.kind === 'github' ? source.repo : null;
  useEffect(() => {
    // The made-up accounts' example papers are sorted into folders once they are in.
    if (github) return undefined;
    let current = true;
    void examplesReady().then(() => {
      if (current) setOrganizer(loadOrganizer(account.login));
    });
    return () => {
      current = false;
    };
  }, [account.login, github]);
  const organize = useCallback(
    (change: (organizer: Organizer) => Organizer) =>
      setOrganizer((current) => {
        const next = tidy(change(current));
        saveOrganizer(account.login, next);
        return next;
      }),
    [account.login],
  );
  const touchPaper = useCallback((owner: string, paperId: string) => organize((current) => touch(current, paperKey(owner, paperId))), [organize]);
  const owner = useMemo(() => ownerSession(account), [account]);
  const collaborator = useMemo(() => collaboratorSession(account), [account]);
  // The made-up accounts' example papers are in their stores before anything is read.
  const mine = useList(owner, () => (github ? Promise.resolve(repoBackend(github, account.login)) : examplesReady().then(() => createMockResultsBackend(storeKeyOf(account.login)))), setToast);
  const shared = useList(collaborator, () => (github ? Promise.resolve(NOTHING_SHARED) : examplesReady().then(() => sharedBackend(account))), setToast);
  const ownerOf = useCallback(
    (paperId: string) => (github ? undefined : ACCOUNTS.find((other) => mockStore(storeKeyOf(other.login)).papers.some((paper) => paper.id === paperId))),
    [github],
  );
  // Papers changed elsewhere meanwhile (on another computer, or by Claude Code through Lemma's MCP server) show
  // when the person comes back to this tab.
  const { reload } = mine;
  useEffect(() => {
    if (!github) return undefined;
    let away = 0;
    const leave = () => {
      away = Date.now();
    };
    const back = () => {
      if (away && Date.now() - away > 5_000) reload();
      away = 0;
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? leave() : back());
    window.addEventListener('blur', leave);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [github, reload]);
  const repo = github ? repoLabel(github) : connectedRepo(account.login) ?? '';
  const features = github ? GITHUB_FEATURES : MOCK_FEATURES;
  const value = useMemo<AccountValue>(
    () => ({ account, repo, features, mine, shared, ownerOf, organizer, organize, touchPaper, toast, setToast }),
    [account, repo, features, mine, shared, ownerOf, organizer, organize, touchPaper, toast],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};
