import React, { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Toast } from '../components/EditMode';
import { PhraseError, useMessage } from '../lib/i18n';
import { MOCK_MODE } from '../lib/session';
import { useT } from '../lib/phrases/app';
import { Account, connectRepo, connectedRepo, signIn, signOut as mockSignOut, signedIn } from './accounts';
import { AccountProvider, useAccount } from './AccountContext';
import AppShell, { SignInDialog } from './AppShell';
import Dashboard from './Dashboard';
import { Callback, finishSignIn, signOut, startSignIn, takeCallback } from './github/auth';
import { appConfigured } from './github/config';
import { LemmaRepo, rememberRepo, rememberedRepo, repoLabel, repoStatus } from './github/repo';
import { GitHubSession, authorizedFetch, currentSession, freshSession, onSession } from './github/session';
import Landing from './Landing';
import MockSetup from './MockSetup';
import PaperRoute from './PaperRoute';
import Setup from './Setup';

/** The signed-in account's notices: saves, uploads, switches. */
const Notices: React.FC = () => {
  const account = useAccount();
  if (!account?.toast) return null;
  return <Toast message={account.toast.message} onClose={() => account.setToast(null)} action={account.toast.action} />;
};

// What GitHub sent back, read before the router starts, and finished once even if React mounts twice.
const callback: Callback | null = MOCK_MODE ? null : takeCallback();
const signingIn: Promise<GitHubSession | null> | null = callback ? finishSignIn(callback) : null;

const accountOf = (session: GitHubSession): Account => ({ login: session.login, id: session.id, name: session.name, avatarUrl: session.avatarUrl });

/** Signing in with GitHub: the account, then its repository (Setup), then its papers. */
const GitHubPages: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const [session, setSessionState] = useState(currentSession);
  const [waiting, setWaiting] = useState(signingIn !== null);
  const [problem, setProblem] = useMessage();
  const [repo, setRepo] = useState<LemmaRepo | null>(() => (session ? rememberedRepo(session.login) : null));
  const login = session?.login;

  useEffect(() => onSession(setSessionState), []);
  useEffect(() => {
    if (!signingIn) {
      // A token that ran out while the page was closed is renewed before anything is read.
      void freshSession();
      return;
    }
    signingIn
      .then((next) => {
        if (next) setRepo(rememberedRepo(next.login));
      })
      .catch((error: unknown) => setProblem(() => (error instanceof PhraseError ? error.message : t('登录失败，请重新登录'))))
      .finally(() => setWaiting(false));
  }, [t, setProblem]);
  // Another account, or none: its repository is looked up again.
  useEffect(() => {
    setRepo(login ? rememberedRepo(login) : null);
  }, [login]);
  // The repository this browser remembers may have been deleted, or Lemma uninstalled from it.
  useEffect(() => {
    if (!login || !repo) return undefined;
    let current = true;
    repoStatus(repo, authorizedFetch())
      .then((status) => {
        if (!current || status === 'lemma') return;
        rememberRepo(login, null);
        setRepo(null);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [login, repo]);

  const account = session ? accountOf(session) : null;
  const begin = () => {
    if (!appConfigured()) {
      setProblem(() => t('登录服务还没有设置好'));
      return;
    }
    setProblem(null);
    void startSignIn();
  };
  const leave = () => {
    void signOut();
    navigate('/');
  };

  if (waiting) {
    return (
      <p className="flex min-h-screen items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" />
        {t('正在登录…')}
      </p>
    );
  }

  const pages = (
    <AppShell account={account} repo={repo ? repoLabel(repo) : null} onSignIn={begin} onSignOut={leave}>
      {problem && (
        <p role="alert" className="mx-auto mt-4 max-w-xl rounded-lg bg-red-50 px-4 py-3 text-center text-sm text-red-800">
          {problem}
        </p>
      )}
      <Routes>
        <Route path="/" element={!account ? <Landing onSignIn={begin} /> : repo ? <Dashboard /> : <Navigate to="/setup" replace />} />
        <Route
          path="/setup"
          element={
            account ? (
              <Setup
                account={account}
                onConnect={(next) => {
                  setRepo(next);
                  navigate('/');
                }}
              />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route path="/p/:owner/:slug" element={account && repo ? <PaperRoute /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Notices />
    </AppShell>
  );
  return account && repo ? (
    <AccountProvider key={`${account.login}:${repoLabel(repo)}`} account={account} source={{ kind: 'github', repo }}>
      {pages}
    </AccountProvider>
  ) : (
    pages
  );
};

/** `npm run dev:mock`: the made-up accounts, with everything kept in this browser. */
const MockPages: React.FC = () => {
  const navigate = useNavigate();
  const [account, setAccount] = useState<Account | null>(signedIn);
  const [choosing, setChoosing] = useState(false);
  const [repo, setRepo] = useState(() => (account ? connectedRepo(account.login) : null));

  const choose = (next: Account) => {
    signIn(next);
    setChoosing(false);
    setRepo(connectedRepo(next.login));
    setAccount(next);
    navigate('/');
  };
  const leave = () => {
    mockSignOut();
    setAccount(null);
    navigate('/');
  };

  const pages = (
    <AppShell account={account} repo={repo} onSignIn={() => setChoosing(true)} onSwitch={() => setChoosing(true)} onSignOut={leave}>
      <Routes>
        <Route path="/" element={!account ? <Landing onSignIn={() => setChoosing(true)} /> : repo ? <Dashboard /> : <Navigate to="/setup" replace />} />
        <Route
          path="/setup"
          element={
            account ? (
              <MockSetup
                account={account}
                onConnect={(chosen) => {
                  connectRepo(account.login, chosen);
                  setRepo(chosen);
                  navigate('/');
                }}
              />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route path="/p/:owner/:slug" element={<PaperRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {choosing && <SignInDialog current={account} onChoose={choose} onClose={() => setChoosing(false)} />}
      <Notices />
    </AppShell>
  );
  // Switching accounts starts the lists over.
  return account ? (
    <AccountProvider key={account.login} account={account} source={{ kind: 'mock' }}>
      {pages}
    </AccountProvider>
  ) : (
    pages
  );
};

/** Lemma: experiment results and research writing in one place, kept in each account's own GitHub repository. */
const App: React.FC = () => <HashRouter>{MOCK_MODE ? <MockPages /> : <GitHubPages />}</HashRouter>;

export default App;
