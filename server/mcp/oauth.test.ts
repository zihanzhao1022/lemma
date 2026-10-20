import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_APP } from '../../app/github/config';
import { authorizationServer, authorize, caller, githubReturned, loopback, protectedResource, register, token, unauthorized } from './oauth';
import { challengeOf, seal, unseal } from './seal';

const SITE = 'https://lemma.example';
const env = { GITHUB_CLIENT_SECRET: 'made-up-secret' };
const CALLBACK = 'http://localhost:41234/callback';
const VERIFIER = 'a-made-up-pkce-verifier-that-is-long-enough-0123456789';

afterEach(() => vi.unstubAllGlobals());

/** A made-up GitHub: its token endpoint answers `answer`, /user a made-up account. */
function fakeGitHub(answer: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (input === 'https://github.com/login/oauth/access_token') return new Response(JSON.stringify(answer));
    if (input === 'https://api.github.com/user') return new Response(JSON.stringify({ login: 'ada-example', id: 42 }));
    return new Response(null, { status: 404 });
  });
  return calls;
}

async function registered(name = 'Claude Code (lemma)'): Promise<string> {
  const res = await register(new Request(`${SITE}/api/mcp/register`, { method: 'POST', body: JSON.stringify({ client_name: name, redirect_uris: [CALLBACK] }) }), env);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizeUrl = async (clientId: string, extra: Record<string, string> = {}) =>
  `${SITE}/api/mcp/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: await challengeOf(VERIFIER),
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${SITE}/mcp`,
    ...extra,
  }).toString()}`;

/** The consent page for a fresh client: its cookie and the sealed request its form posts. */
async function consent(clientId: string): Promise<{ cookie: string; sealed: string; html: string }> {
  const res = await authorize(new Request(await authorizeUrl(clientId), { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } }), env);
  const html = await res.text();
  return { cookie: (res.headers.get('Set-Cookie') ?? '').split(';')[0], sealed: /name="request" value="([^"]+)"/.exec(html)?.[1] ?? '', html };
}

const decide = (sealed: string, decision: string, cookie: string) =>
  authorize(
    new Request(`${SITE}/api/mcp/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ request: sealed, decision }).toString(),
    }),
    env,
  );

const tokenRequest = (params: Record<string, string>) =>
  token(new Request(`${SITE}/api/mcp/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }), env);

/** Goes through the whole sign-in and returns the client's code. */
async function signedInCode(clientId: string): Promise<string> {
  const { cookie, sealed } = await consent(clientId);
  const toGitHub = new URL((await decide(sealed, 'allow', cookie)).headers.get('Location') ?? '');
  fakeGitHub({ access_token: 'ghu_made_up', expires_in: 28800, refresh_token: 'ghr_made_up', refresh_token_expires_in: 15811200 });
  const back = await githubReturned(new Request(`${SITE}/?code=github-code&state=${encodeURIComponent(toGitHub.searchParams.get('state') ?? '')}`), env);
  return new URL(back.headers.get('Location') ?? '').searchParams.get('code') ?? '';
}

describe('sealing', () => {
  it('opens only what it sealed, as the same kind, while it lasts, with the same secret', async () => {
    const sealed = await seal('secret', 'code', { a: 1 }, Date.now() + 60_000);
    expect(await unseal('secret', 'code', sealed)).toEqual({ a: 1 });
    expect(await unseal('secret', 'access', sealed)).toBeNull();
    expect(await unseal('other-secret', 'code', sealed)).toBeNull();
    expect(await unseal('secret', 'code', `${sealed.slice(0, -2)}AA`)).toBeNull();
    expect(await unseal('secret', 'code', await seal('secret', 'code', { a: 1 }, Date.now() - 1))).toBeNull();
    expect(await unseal('secret', 'code', 'not-sealed')).toBeNull();
  });
});

describe('where an MCP client learns how to sign in', () => {
  it('describes the MCP endpoint and the authorization server', async () => {
    expect(await protectedResource(new Request(`${SITE}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({ resource: `${SITE}/mcp`, authorization_servers: [SITE] });
    expect(await authorizationServer(new Request(`${SITE}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/api/mcp/authorize`,
      token_endpoint: `${SITE}/api/mcp/token`,
      registration_endpoint: `${SITE}/api/mcp/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    const res = unauthorized(new Request(`${SITE}/mcp`), false);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="papers"`);
  });

  it('registers clients that wait on this computer, and no others', async () => {
    expect(loopback('http://localhost:5000/callback')).toBe(true);
    expect(loopback('http://127.0.0.1:5000/callback')).toBe(true);
    expect(loopback('http://[::1]:5000/callback')).toBe(true);
    expect(loopback('https://attacker.example/callback')).toBe(false);
    expect(loopback('http://localhost.attacker.example/callback')).toBe(false);
    expect(loopback('http://user@localhost:5000/callback')).toBe(false);
    const ok = await register(new Request(`${SITE}/api/mcp/register`, { method: 'POST', body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [CALLBACK] }) }), env);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ client_name: 'Claude Code', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const refused = await register(new Request(`${SITE}/api/mcp/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://attacker.example/cb'] }) }), env);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });
});

describe('signing in for an MCP client', () => {
  it('asks the person first, on a page no other site can frame, naming the client safely', async () => {
    const { cookie, sealed, html } = await consent(await registered('<script>alert(1)</script>'));
    expect(cookie).toMatch(/^lemma_mcp_consent=.+/);
    expect(sealed).not.toBe('');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('localhost:41234');
    expect(html).toContain('允许');
    const res = await authorize(new Request(await authorizeUrl(await registered())), env);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('Set-Cookie')).toContain('SameSite=Strict');
  });

  it('refuses unknown clients and addresses outright, and other mistakes back to the client', async () => {
    const clientId = await registered();
    expect((await authorize(new Request(await authorizeUrl('made-up-client')), env)).status).toBe(400);
    expect((await authorize(new Request(await authorizeUrl(clientId, { redirect_uri: 'http://localhost:9999/elsewhere' })), env)).status).toBe(400);
    const plain = await authorize(new Request(await authorizeUrl(clientId, { code_challenge_method: 'plain' })), env);
    expect(new URL(plain.headers.get('Location') ?? '').searchParams.get('error')).toBe('invalid_request');
    const elsewhere = await authorize(new Request(await authorizeUrl(clientId, { resource: 'https://other.example/mcp' })), env);
    expect(new URL(elsewhere.headers.get('Location') ?? '').searchParams.get('error')).toBe('invalid_target');
  });

  it('takes the yes only from the browser that was asked', async () => {
    const { sealed } = await consent(await registered());
    expect((await decide(sealed, 'allow', 'lemma_mcp_consent=someone-else')).status).toBe(400);
    expect((await decide(sealed, 'allow', '')).status).toBe(400);
  });

  it('sends a refusal back to the client', async () => {
    const { cookie, sealed } = await consent(await registered());
    const res = await decide(sealed, 'deny', cookie);
    const back = new URL(res.headers.get('Location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('client-state');
  });

  it('signs in with GitHub through the front page and gives the client a code for its tokens', async () => {
    const clientId = await registered();
    const { cookie, sealed } = await consent(clientId);
    const res = await decide(sealed, 'allow', cookie);
    const github = new URL(res.headers.get('Location') ?? '');
    expect(`${github.origin}${github.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(github.searchParams.get('client_id')).toBe(GITHUB_APP.clientId);
    expect(github.searchParams.get('redirect_uri')).toBe(`${SITE}/`);
    expect(github.searchParams.get('state')).toMatch(/^mcp\./);
    expect(github.searchParams.get('code_challenge_method')).toBe('S256');

    const calls = fakeGitHub({ access_token: 'ghu_made_up', expires_in: 28800, refresh_token: 'ghr_made_up', refresh_token_expires_in: 15811200 });
    const back = await githubReturned(new Request(`${SITE}/?code=github-code&state=${encodeURIComponent(github.searchParams.get('state') ?? '')}`), env);
    const answer = new URL(back.headers.get('Location') ?? '');
    expect(`${answer.origin}${answer.pathname}`).toBe(CALLBACK);
    expect(answer.searchParams.get('state')).toBe('client-state');
    expect(calls[0].body).toMatchObject({ client_id: GITHUB_APP.clientId, client_secret: 'made-up-secret', code: 'github-code', redirect_uri: `${SITE}/` });
    expect(await challengeOf(String(calls[0].body?.code_verifier))).toBe(github.searchParams.get('code_challenge'));

    const code = answer.searchParams.get('code') ?? '';
    const wrong = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: 'not-the-verifier' });
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
    const elsewhere = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:1/other', client_id: clientId, code_verifier: VERIFIER });
    expect(await elsewhere.json()).toMatchObject({ error: 'invalid_grant' });
    const tokens = (await (await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER, resource: `${SITE}/mcp` })).json()) as Record<string, unknown>;
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'papers' });
    expect(tokens.expires_in).toBeGreaterThan(28_000);
    // Lemma's tokens carry GitHub's sealed: the client never sees them.
    expect(String(tokens.access_token)).not.toContain('ghu_made_up');
    expect(String(tokens.refresh_token)).not.toContain('ghr_made_up');

    const mcp = (authorization: string, site = SITE) => new Request(`${site}/mcp`, { method: 'POST', headers: { Authorization: authorization } });
    expect(await caller(mcp(`Bearer ${String(tokens.access_token)}`), env)).toEqual({ github: 'ghu_made_up', login: 'ada-example' });
    expect(await caller(mcp(`Bearer ${String(tokens.refresh_token)}`), env)).toBeNull();
    expect(await caller(mcp(`Bearer ${String(tokens.access_token)}`, 'https://other.example'), env)).toBeNull();
    expect(await caller(mcp('Bearer made-up'), env)).toBeNull();
  });

  it('sends GitHub refusals back to the client, and turns away answers it never asked for', async () => {
    const { cookie, sealed } = await consent(await registered());
    const state = new URL((await decide(sealed, 'allow', cookie)).headers.get('Location') ?? '').searchParams.get('state') ?? '';
    const cancelled = await githubReturned(new Request(`${SITE}/?error=access_denied&state=${encodeURIComponent(state)}`), env);
    expect(new URL(cancelled.headers.get('Location') ?? '').searchParams.get('error')).toBe('access_denied');
    expect((await githubReturned(new Request(`${SITE}/?code=x&state=mcp.made-up`), env)).status).toBe(400);
  });
});

describe('renewing the tokens', () => {
  it("renews them with GitHub's refresh token, and ends the sign-in only when GitHub says it is dead", async () => {
    const clientId = await registered();
    const code = await signedInCode(clientId);
    const first = (await (await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: VERIFIER })).json()) as Record<string, string>;
    const calls = fakeGitHub({ access_token: 'ghu_renewed', expires_in: 28800, refresh_token: 'ghr_renewed', refresh_token_expires_in: 15811200 });
    const renewed = (await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })).json()) as Record<string, string>;
    expect(calls[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_made_up' });
    expect(await caller(new Request(`${SITE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${renewed.access_token}` } }), env)).toEqual({ github: 'ghu_renewed', login: 'ada-example' });

    fakeGitHub({ error: 'bad_refresh_token' });
    expect(await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: renewed.refresh_token })).json()).toMatchObject({ error: 'invalid_grant' });
    fakeGitHub({ error: 'rate_limited' });
    expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: renewed.refresh_token })).status).toBe(503);
    expect(await (await tokenRequest({ grant_type: 'refresh_token', refresh_token: renewed.refresh_token, client_id: 'another-client' })).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await (await tokenRequest({ grant_type: 'password' })).json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});
