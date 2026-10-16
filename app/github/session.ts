/**
 * The GitHub account signed in in this browser. Its access token lasts 8 hours and is renewed through
 * /api/refresh (server/auth.ts) a minute before it runs out, or when GitHub turns it away; the refresh token
 * itself never reaches this code. Every request to GitHub goes through authorizedFetch, which always sends
 * the newest token, so a page left open overnight keeps working.
 */
import type { SignedIn } from '../../server/auth';

export type GitHubSession = SignedIn;

const STORAGE_KEY = 'lemma-session';
const RENEW_BEFORE_MS = 60 * 1000;

const valid = (value: unknown): value is GitHubSession => {
  const session = value as Partial<GitHubSession> | null;
  return (
    !!session &&
    typeof session.token === 'string' &&
    typeof session.expiresAt === 'number' &&
    typeof session.login === 'string' &&
    typeof session.id === 'number' &&
    typeof session.name === 'string' &&
    typeof session.avatarUrl === 'string'
  );
};

function stored(): GitHubSession | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

let current: GitHubSession | null = typeof window === 'undefined' ? null : stored();
const listeners = new Set<(session: GitHubSession | null) => void>();

/** The signed-in account, or null; its token may have run out (see freshSession). */
export const currentSession = (): GitHubSession | null => current;

export function setSession(next: GitHubSession | null): void {
  current = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Signed in for this page only.
  }
  listeners.forEach((listener) => listener(next));
}

/** Calls `listener` whenever the account signs in, renews its token or signs out. */
export function onSession(listener: (session: GitHubSession | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let renewing: Promise<GitHubSession | null> | null = null;

/**
 * A new access token from the refresh cookie; null (and signed out) when there is none or GitHub refuses it.
 * Calls made while one is under way share it.
 */
export function renewSession(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<GitHubSession | null> {
  renewing ??= (async () => {
    try {
      const res = await fetchImpl('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status === 401) {
        setSession(null);
        return null;
      }
      if (!res.ok) return current;
      const next: unknown = await res.json();
      if (!valid(next)) return current;
      setSession(next);
      return next;
    } catch {
      // Offline: keep what there is; a request with an old token fails on its own.
      return current;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

/** The session with a token good for at least another minute, renewed if it needs to be. */
export async function freshSession(fetchImpl?: typeof fetch): Promise<GitHubSession | null> {
  if (current && current.expiresAt - Date.now() > RENEW_BEFORE_MS) return current;
  return current ? renewSession(fetchImpl) : null;
}

/**
 * fetch for api.github.com with the account's newest token. A 401 means the token was revoked or ran out
 * early: it is renewed once and the request sent again.
 */
export function authorizedFetch(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  const send = (input: RequestInfo | URL, init: RequestInit | undefined, token: string) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
  return async (input, init) => {
    const session = await freshSession(fetchImpl);
    if (!session) return new Response(JSON.stringify({ message: 'signed out' }), { status: 401 });
    const res = await send(input, init, session.token);
    if (res.status !== 401) return res;
    const renewed = await renewSession(fetchImpl);
    return renewed && renewed.token !== session.token ? send(input, init, renewed.token) : res;
  };
}
