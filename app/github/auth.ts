/**
 * Signing in with GitHub (the web flow with PKCE) and installing Lemma's App on a repository. Both leave the
 * site for GitHub and come back to its front page with ?code=…&state=… (installing signs in as well); the
 * code is traded for a session by /api/token (server/auth.ts).
 */
import { buildAuthorizeUrl, pkceChallenge, randomToken } from '../../editor/auth';
import { PhraseError } from '../../lib/i18n';
import { t } from '../../lib/phrases/app';
import { safeReturnHash } from '../../lib/session';
import { GITHUB_APP } from './config';
import { GitHubSession, currentSession, setSession, signedOut } from './session';

/** Kept in sessionStorage while the browser is at GitHub. */
interface Pending {
  state: string;
  /** PKCE verifier of a sign-in started here; installing has none. */
  verifier: string | null;
  returnHash: string;
}

/** What GitHub put in the address when it sent the browser back. */
export interface Callback {
  code: string | null;
  state: string | null;
  error: string | null;
  /** The App was just installed (or its repositories changed). */
  installed: boolean;
}

const PENDING_KEY = 'lemma-login';

function readPending(): Pending | null {
  try {
    return JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null;
  } catch {
    return null;
  }
}

function writePending(pending: Pending | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // The check after GitHub then fails, and the account signs in again.
  }
}

const redirectUri = (): string => `${window.location.origin}/`;

/** Sends the browser to GitHub to sign in; it comes back to the page it is on now. */
export async function startSignIn(): Promise<void> {
  const state = randomToken();
  const verifier = randomToken();
  writePending({ state, verifier, returnHash: safeReturnHash(window.location.hash) });
  window.location.assign(buildAuthorizeUrl({ clientId: GITHUB_APP.clientId, redirectUri: redirectUri(), state, challenge: await pkceChallenge(verifier) }));
}

/** Sends the browser to GitHub to install the App on a repository; it comes back to `returnHash`. */
export function startInstall(returnHash = '#/setup'): void {
  const state = randomToken();
  writePending({ state, verifier: null, returnHash });
  window.location.assign(`https://github.com/apps/${encodeURIComponent(GITHUB_APP.slug)}/installations/new?state=${encodeURIComponent(state)}`);
}

/**
 * Takes GitHub's answer out of the address bar before the router starts and puts back the page the browser
 * was on. Null on ordinary page loads.
 */
export function takeCallback(): Callback | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('code') && !params.has('error') && !params.has('installation_id')) return null;
  window.history.replaceState(null, '', window.location.pathname + safeReturnHash(readPending()?.returnHash ?? '#/'));
  return { code: params.get('code'), state: params.get('state'), error: params.get('error'), installed: params.has('installation_id') };
}

/** Finishes what GitHub sent back: the session, or the one there already was when nothing needs signing in. */
export async function finishSignIn(callback: Callback, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<GitHubSession | null> {
  const pending = readPending();
  writePending(null);
  const ours = !!pending && callback.state === pending.state;
  // GitHub's error codes only, and only for what this browser asked for: a link's own words never show here.
  if (callback.error && ours && /^[a-z_]{1,64}$/.test(callback.error)) {
    const error = callback.error;
    throw new PhraseError(() => (error === 'access_denied' ? t('已取消登录') : t('GitHub 登录失败（{error}）', { error })));
  }
  if (!callback.code) return currentSession();
  if (!ours) {
    // An installation made on GitHub's own pages also signs in, but this browser never asked for that code.
    if (callback.installed) return currentSession();
    throw new PhraseError(() => t('登录校验失败，请重新登录'));
  }
  let res: Response;
  try {
    res = await fetchImpl('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: callback.code, redirectUri: redirectUri(), ...(pending.verifier ? { verifier: pending.verifier } : {}) }),
    });
  } catch {
    throw new PhraseError(() => t('无法连接登录服务，请稍后重试'));
  }
  if (res.status === 503) throw new PhraseError(() => t('登录服务还没有设置好'));
  if (!res.ok) throw new PhraseError(() => t('登录失败，请重新登录'));
  const session = (await res.json()) as GitHubSession;
  setSession(session);
  return session;
}

/** Signs out here, in other tabs and at GitHub: the token stops working, and so does staying signed in. */
export async function signOut(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<void> {
  const session = currentSession();
  signedOut();
  try {
    await fetchImpl('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session?.token }) });
  } catch {
    // The token runs out on its own within 8 hours.
  }
}
