/**
 * Signing in to Lemma with GitHub, run by the Cloudflare Pages Functions in functions/api on the site's own
 * origin. GitHub's token endpoint needs the App's client secret and has no CORS, so the browser cannot call it.
 * The browser keeps the access token (8 hours); the refresh token (6 months) stays in a cookie that only these
 * endpoints can read, so a signed-in browser renews its access without asking again. Nothing is stored here.
 */
import { GITHUB_APP } from '../app/github/config';

export interface Env {
  /** A secret of the Pages project, never in the repository. */
  GITHUB_CLIENT_SECRET?: string;
}

/** What a signed-in browser gets (see app/github/session.ts). */
export interface SignedIn {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  login: string;
  id: number;
  name: string;
  avatarUrl: string;
}

const REFRESH_COOKIE = 'lemma_refresh';
// GitHub's lifetimes, for an answer that leaves them out.
const ACCESS_SECONDS = 8 * 60 * 60;
const REFRESH_SECONDS = 180 * 24 * 60 * 60;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const keepCookie = (token: string, seconds: number): string => `${REFRESH_COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
// Only signing out clears the cookie: a failed renewal must not wipe the newer one another tab may just have got.
const CLEARED_COOKIE = `${REFRESH_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** The site's own pages only: the refresh cookie must never answer another site. */
const sameOrigin = (request: Request): boolean => request.headers.get('Origin') === new URL(request.url).origin;

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

const githubHeaders = (authorization: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  Authorization: authorization,
  'User-Agent': 'Lemma',
  'X-GitHub-Api-Version': '2022-11-28',
});

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

async function askGitHub(params: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return (await res.json().catch(() => ({ error: 'bad_answer' }))) as TokenAnswer;
}

/**
 * The session for a new access token, with its refresh token kept in the cookie, also when looking up the
 * account fails: GitHub has already retired the old refresh token by then.
 */
async function signedIn(answer: TokenAnswer, accessToken: string): Promise<Response> {
  const cookie: Record<string, string> = answer.refresh_token ? { 'Set-Cookie': keepCookie(answer.refresh_token, answer.refresh_token_expires_in ?? REFRESH_SECONDS) } : {};
  let res: Response;
  try {
    res = await fetch('https://api.github.com/user', { headers: githubHeaders(`Bearer ${accessToken}`) });
  } catch {
    return json({ error: 'github_unreachable' }, 502, cookie);
  }
  if (!res.ok) return json({ error: 'user_lookup_failed' }, 502, cookie);
  const user = (await res.json()) as { login: string; id: number; name?: string | null; avatar_url?: string };
  const body: SignedIn = {
    token: accessToken,
    expiresAt: Date.now() + (answer.expires_in ?? ACCESS_SECONDS) * 1000,
    login: user.login,
    id: user.id,
    name: user.name || user.login,
    avatarUrl: user.avatar_url ?? '',
  };
  return json(body, 200, cookie);
}

const configured = (env: Env): env is Env & { GITHUB_CLIENT_SECRET: string } => Boolean(env.GITHUB_CLIENT_SECRET && GITHUB_APP.clientId);

/** POST /api/token {code, verifier?, redirectUri}: the code GitHub sent back, for a session. */
export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
  if (!configured(env)) return json({ error: 'not_configured' }, 503);
  const body = (await request.json().catch(() => null)) as { code?: unknown; verifier?: unknown; redirectUri?: unknown } | null;
  if (!body || typeof body.code !== 'string' || (body.verifier !== undefined && typeof body.verifier !== 'string')) {
    return json({ error: 'bad_request' }, 400);
  }
  // GitHub sends the browser back to the site's front page, and nowhere else.
  const redirectUri = `${new URL(request.url).origin}/`;
  if (body.redirectUri !== redirectUri) return json({ error: 'bad_redirect_uri' }, 400);
  try {
    const answer = await askGitHub({
      client_id: GITHUB_APP.clientId,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: body.code,
      redirect_uri: redirectUri,
      // A sign-in started here has one; the sign-in GitHub adds to installing the App has none.
      ...(typeof body.verifier === 'string' ? { code_verifier: body.verifier } : {}),
    });
    if (!answer.access_token) return json({ error: answer.error ?? 'token_exchange_failed' }, 400);
    return await signedIn(answer, answer.access_token);
  } catch {
    return json({ error: 'github_unreachable' }, 502);
  }
}

/** POST /api/refresh: a new access token for the browser holding the refresh cookie. */
export async function handleRefresh(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
  if (!configured(env)) return json({ error: 'not_configured' }, 503);
  const refresh = readCookie(request, REFRESH_COOKIE);
  if (!refresh) return json({ error: 'signed_out' }, 401);
  try {
    const answer = await askGitHub({
      client_id: GITHUB_APP.clientId,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refresh,
    });
    // Only GitHub's word that the refresh token is dead signs the browser out; anything else (an outage, a rate
    // limit) may pass, and the browser keeps its session.
    if (!answer.access_token) return json({ error: answer.error ?? 'refresh_failed' }, answer.error === 'bad_refresh_token' ? 401 : 502);
    return await signedIn(answer, answer.access_token);
  } catch {
    return json({ error: 'github_unreachable' }, 502);
  }
}

/** POST /api/logout {token}: the access token stops working at once, and the refresh cookie goes. */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  if (configured(env) && typeof body?.token === 'string') {
    await fetch(`https://api.github.com/applications/${GITHUB_APP.clientId}/token`, {
      method: 'DELETE',
      headers: { ...githubHeaders(`Basic ${btoa(`${GITHUB_APP.clientId}:${env.GITHUB_CLIENT_SECRET}`)}`), 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: body.token }),
    }).catch(() => undefined);
  }
  return new Response(null, { status: 204, headers: { 'Set-Cookie': CLEARED_COOKIE, 'Cache-Control': 'no-store' } });
}
