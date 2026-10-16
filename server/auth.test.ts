import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_APP } from '../app/github/config';
import { handleLogout, handleRefresh, handleToken } from './auth';

const SITE = 'https://lemma.example';
const env = { GITHUB_CLIENT_SECRET: 'made-up-secret' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A made-up GitHub: the token endpoint answers `token`, /user answers a made-up account. */
function fakeGitHub(token: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    calls.push({
      url: input,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    if (input === 'https://github.com/login/oauth/access_token') return new Response(JSON.stringify(token));
    if (input === 'https://api.github.com/user') return new Response(JSON.stringify({ login: 'ada-example', id: 42, name: 'Ada Example', avatar_url: 'https://avatars.example/42' }));
    return new Response(null, { status: 204 });
  });
  return calls;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  GITHUB_APP.clientId = 'Iv1.madeup';
});

afterEach(() => {
  GITHUB_APP.clientId = '';
  vi.unstubAllGlobals();
});

describe('signing in', () => {
  it('trades the code (with its PKCE verifier) for a session, and keeps the refresh token in a cookie', async () => {
    const calls = fakeGitHub({ access_token: 'ghu_access', expires_in: 28800, refresh_token: 'ghr_refresh', refresh_token_expires_in: 15811200 });
    const res = await handleToken(post('/api/token', { code: 'the-code', verifier: 'the-verifier', redirectUri: `${SITE}/` }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token: 'ghu_access', login: 'ada-example', id: 42, name: 'Ada Example', avatarUrl: 'https://avatars.example/42' });
    expect(body.expiresAt).toBeGreaterThan(Date.now() + 28_000_000);
    expect(calls[0].body).toEqual({ client_id: 'Iv1.madeup', client_secret: 'made-up-secret', code: 'the-code', redirect_uri: `${SITE}/`, code_verifier: 'the-verifier' });
    expect(calls[1].headers.Authorization).toBe('Bearer ghu_access');
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('lemma_refresh=ghr_refresh');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api');
    expect(cookie).toContain('Max-Age=15811200');
  });

  it('takes the code GitHub sends after installing the App, which has no verifier', async () => {
    const calls = fakeGitHub({ access_token: 'ghu_access' });
    const res = await handleToken(post('/api/token', { code: 'install-code', redirectUri: `${SITE}/` }), env);
    expect(res.status).toBe(200);
    expect(calls[0].body).not.toHaveProperty('code_verifier');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('refuses other sites, other redirects, bad requests and an unset secret', async () => {
    fakeGitHub({ access_token: 'ghu_access' });
    expect((await handleToken(post('/api/token', { code: 'c', redirectUri: `${SITE}/` }, { Origin: 'https://evil.example' }), env)).status).toBe(403);
    expect((await handleToken(post('/api/token', { code: 'c', redirectUri: 'https://evil.example/' }), env)).status).toBe(400);
    expect((await handleToken(post('/api/token', { code: 42, redirectUri: `${SITE}/` }), env)).status).toBe(400);
    expect((await handleToken(post('/api/token', { code: 'c', redirectUri: `${SITE}/` }), {})).status).toBe(503);
  });

  it("passes on GitHub's refusal", async () => {
    fakeGitHub({ error: 'bad_verification_code' });
    const res = await handleToken(post('/api/token', { code: 'old', verifier: 'v', redirectUri: `${SITE}/` }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_verification_code' });
  });
});

describe('staying signed in', () => {
  it('renews the access token with the cookie, and keeps the new refresh token', async () => {
    const calls = fakeGitHub({ access_token: 'ghu_new', refresh_token: 'ghr_new' });
    const res = await handleRefresh(post('/api/refresh', {}, { Cookie: 'other=1; lemma_refresh=ghr_old' }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: 'ghu_new', login: 'ada-example' });
    expect(calls[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_old', client_secret: 'made-up-secret' });
    expect(res.headers.get('Set-Cookie')).toContain('lemma_refresh=ghr_new');
  });

  it('signs the browser out when there is no cookie or GitHub refuses it', async () => {
    fakeGitHub({ error: 'bad_refresh_token' });
    expect((await handleRefresh(post('/api/refresh', {}), env)).status).toBe(401);
    const refused = await handleRefresh(post('/api/refresh', {}, { Cookie: 'lemma_refresh=ghr_expired' }), env);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await handleRefresh(post('/api/refresh', {}, { Origin: 'https://evil.example', Cookie: 'lemma_refresh=x' }), env)).status).toBe(403);
  });
});

describe('signing out', () => {
  it('revokes the access token and drops the cookie', async () => {
    const calls = fakeGitHub({});
    const res = await handleLogout(post('/api/logout', { token: 'ghu_access' }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/applications/Iv1.madeup/token', method: 'DELETE', body: { access_token: 'ghu_access' } });
    expect(calls[0].headers.Authorization).toBe(`Basic ${btoa('Iv1.madeup:made-up-secret')}`);
  });
});
