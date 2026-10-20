/**
 * Lemma as an OAuth authorization server for MCP clients such as Claude Code (the MCP authorization spec:
 * RFC 9728 resource metadata, RFC 8414 server metadata, RFC 7591 registration, PKCE). People sign in with
 * GitHub through Lemma's App; the client gets Lemma's own tokens, which carry the GitHub ones sealed (seal.ts).
 *
 * The App allows GitHub to send people back only to the site's front page, so GitHub's answer lands there and
 * functions/index.ts hands it here by its state. Codes go only to addresses on the person's own computer, and
 * only after they said yes on Lemma's page in their own browser: a link someone else made gets them nothing.
 */
import { GITHUB_APP } from '../../app/github/config';
import { ACCESS_SECONDS, Env, REFRESH_SECONDS, TokenAnswer, askGitHub, configured, githubHeaders, readCookie } from '../auth';
import { consentPage, languageOf, problemPage } from './consent';
import { challengeOf, randomToken, seal, unseal } from './seal';

/** The one scope: the person's papers. */
const SCOPE = 'papers';
/** What the state sent to GitHub starts with, so the front page knows the answer is for an MCP client. */
export const STATE_PREFIX = 'mcp.';
const CONSENT_COOKIE = 'lemma_mcp_consent';

const MINUTE = 60_000;
const CODE_LIFE = 5 * MINUTE;
const CONSENT_LIFE = 10 * MINUTE;
const CLIENT_LIFE = 5 * 365 * 24 * 60 * MINUTE;
/** Lemma's access token runs out a little before the GitHub token it carries. */
const MARGIN = MINUTE;

/** The MCP endpoint: what the tokens are for. */
export const resourceOf = (origin: string): string => `${origin}/mcp`;
const originOf = (request: Request): string => new URL(request.url).origin;
/** Where GitHub sends the browser back: the front page, the App's callback URL (see the comment above). */
const githubReturn = (origin: string): string => `${origin}/`;

/** Anyone may call the metadata, registration, token and MCP endpoints from a web page: none of them reads cookies. */
export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

export const preflight = (): Response => new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers } });

const oauthError = (error: string, description: string, status = 400): Response => json({ error, error_description: description }, status);

/** RFC 9728: the MCP endpoint, and where its tokens come from. */
export function protectedResource(request: Request): Response {
  const origin = originOf(request);
  return json({ resource: resourceOf(origin), authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Lemma' });
}

/** RFC 8414: the site as an authorization server. */
export function authorizationServer(request: Request): Response {
  const origin = originOf(request);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/authorize`,
    token_endpoint: `${origin}/api/mcp/token`,
    registration_endpoint: `${origin}/api/mcp/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

/** The answer to a request without a valid token, saying where to get one. */
export function unauthorized(request: Request, invalid: boolean): Response {
  const challenge = `Bearer resource_metadata="${originOf(request)}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"${invalid ? ', error="invalid_token"' : ''}`;
  return json(
    { error: invalid ? 'invalid_token' : 'unauthorized', error_description: invalid ? 'The token is not valid or has expired.' : 'Sign in to Lemma first.' },
    401,
    { 'WWW-Authenticate': challenge },
  );
}

/** An address on the person's own computer, where an MCP client like Claude Code waits for the answer. */
export function loopback(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** A registered client, sealed into its client ID. */
interface Client {
  uris: string[];
  name: string;
}

/** What the client asked for, carried from the consent page to GitHub and back. */
interface Asked {
  clientId: string;
  redirectUri: string;
  challenge: string;
  /** The client's own state, sent back with the answer. */
  state: string | null;
}

/** GitHub's tokens for the person. */
interface Grant {
  github: string;
  /** Epoch milliseconds. */
  githubExpires: number;
  refresh: string | null;
  refreshExpires: number;
  login: string;
}

/** POST /api/mcp/register (RFC 7591): a client ID for a client listening on this computer. */
export async function register(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) return oauthError('temporarily_unavailable', 'Signing in is not set up on this site.', 503);
  const body = (await request.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
  const uris = body && Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]) : [];
  if (uris.length === 0 || uris.length > 5 || !uris.every((uri): uri is string => typeof uri === 'string' && loopback(uri))) {
    return oauthError('invalid_redirect_uri', 'Only addresses on this computer (http://localhost, http://127.0.0.1 or http://[::1]) can receive codes.');
  }
  const name = typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'MCP client';
  const issued = Date.now();
  const client: Client = { uris, name };
  return json(
    {
      client_id: await seal(env.GITHUB_CLIENT_SECRET, 'client', client, issued + CLIENT_LIFE),
      client_id_issued_at: Math.floor(issued / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    },
    201,
  );
}

/** The client's address with the answer in its query. */
function answer(redirectUri: string, params: Record<string, string | null>, headers: Record<string, string> = {}): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store', ...headers } });
}

/** The resource a client names, if it is this site's MCP endpoint (with or without "/mcp" or a final slash). */
const ours = (resource: string, origin: string): boolean => [origin, resourceOf(origin)].includes(resource.replace(/\/+$/, ''));

/**
 * GET /api/mcp/authorize: asks the person whether to let the client in; POST: their answer, which sends them on
 * to GitHub to sign in, or back to the client with a refusal.
 */
export async function authorize(request: Request, env: Env): Promise<Response> {
  const lang = languageOf(request);
  if (!configured(env)) return problemPage(lang, 'unavailable', 503);
  const secret = env.GITHUB_CLIENT_SECRET;
  if (request.method === 'POST') return decide(request, secret);
  const url = new URL(request.url);
  const query = url.searchParams;
  const clientId = query.get('client_id') ?? '';
  const redirectUri = query.get('redirect_uri') ?? '';
  const client = clientId ? await unseal<Client>(secret, 'client', clientId) : null;
  // Without a known client and one of its own addresses there is nowhere safe to send an answer.
  if (!client || !client.uris.includes(redirectUri)) return problemPage(lang, 'badClient', 400);
  const state = query.get('state');
  if (query.get('response_type') !== 'code') return answer(redirectUri, { error: 'unsupported_response_type', state });
  const challenge = query.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || query.get('code_challenge_method') !== 'S256') {
    return answer(redirectUri, { error: 'invalid_request', error_description: 'PKCE with S256 is required.', state });
  }
  const resource = query.get('resource');
  if (resource !== null && !ours(resource, url.origin)) return answer(redirectUri, { error: 'invalid_target', state });
  // The yes must come from this browser: the cookie and the sealed request carry the same nonce.
  const nonce = randomToken();
  const asked: Asked = { clientId, redirectUri, challenge, state };
  const sealed = await seal(secret, 'consent', { asked, nonce }, Date.now() + CONSENT_LIFE);
  return consentPage(
    lang,
    { client: client.name, where: new URL(redirectUri).host, sealed },
    { 'Set-Cookie': `${CONSENT_COOKIE}=${nonce}; Path=/api/mcp; HttpOnly; Secure; SameSite=Strict; Max-Age=${CONSENT_LIFE / 1000}` },
  );
}

async function decide(request: Request, secret: string): Promise<Response> {
  const lang = languageOf(request);
  const form = await request.formData().catch(() => null);
  const sealed = form?.get('request');
  const consent = typeof sealed === 'string' ? await unseal<{ asked: Asked; nonce: string }>(secret, 'consent', sealed) : null;
  if (!consent || readCookie(request, CONSENT_COOKIE) !== consent.nonce) return problemPage(lang, 'expired', 400);
  const { asked } = consent;
  const cleared = { 'Set-Cookie': `${CONSENT_COOKIE}=; Path=/api/mcp; HttpOnly; Secure; SameSite=Strict; Max-Age=0` };
  if (form?.get('decision') !== 'allow') return answer(asked.redirectUri, { error: 'access_denied', state: asked.state }, cleared);
  const verifier = randomToken();
  const origin = originOf(request);
  const state = STATE_PREFIX + (await seal(secret, 'state', { asked, verifier }, Date.now() + CONSENT_LIFE));
  const github = new URLSearchParams({
    client_id: GITHUB_APP.clientId,
    redirect_uri: githubReturn(origin),
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
  });
  return new Response(null, { status: 302, headers: { Location: `https://github.com/login/oauth/authorize?${github.toString()}`, 'Cache-Control': 'no-store', ...cleared } });
}

/** The GitHub account a token belongs to. */
async function loginOf(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user', { headers: githubHeaders(`Bearer ${token}`) });
    return res.ok ? ((await res.json()) as { login: string }).login : null;
  } catch {
    return null;
  }
}

const grantOf = (tokens: TokenAnswer & { access_token: string }, login: string): Grant => {
  const now = Date.now();
  return {
    github: tokens.access_token,
    githubExpires: now + (tokens.expires_in ?? ACCESS_SECONDS) * 1000,
    refresh: tokens.refresh_token ?? null,
    refreshExpires: now + (tokens.refresh_token_expires_in ?? REFRESH_SECONDS) * 1000,
    login,
  };
};

/**
 * GitHub's answer for an MCP client, at the front page (functions/index.ts): the GitHub code traded for the
 * person's tokens, sealed into a code of Lemma's own for the client.
 */
export async function githubReturned(request: Request, env: Env): Promise<Response> {
  const lang = languageOf(request);
  if (!configured(env)) return problemPage(lang, 'unavailable', 503);
  const secret = env.GITHUB_CLIENT_SECRET;
  const url = new URL(request.url);
  const sent = await unseal<{ asked: Asked; verifier: string }>(secret, 'state', (url.searchParams.get('state') ?? '').slice(STATE_PREFIX.length));
  if (!sent) return problemPage(lang, 'expired', 400);
  const { asked, verifier } = sent;
  const code = url.searchParams.get('code');
  // GitHub's own refusal (the person cancelled there) goes back as one.
  if (!code) return answer(asked.redirectUri, { error: 'access_denied', state: asked.state });
  let tokens: TokenAnswer;
  try {
    tokens = await askGitHub({ client_id: GITHUB_APP.clientId, client_secret: secret, code, redirect_uri: githubReturn(url.origin), code_verifier: verifier });
  } catch {
    return answer(asked.redirectUri, { error: 'temporarily_unavailable', error_description: 'GitHub could not be reached.', state: asked.state });
  }
  const access = tokens.access_token;
  if (!access) return answer(asked.redirectUri, { error: 'access_denied', error_description: `GitHub did not sign you in (${tokens.error ?? 'no token'}).`, state: asked.state });
  const login = await loginOf(access);
  if (!login) return answer(asked.redirectUri, { error: 'temporarily_unavailable', error_description: 'GitHub could not say who signed in.', state: asked.state });
  const grant = grantOf({ ...tokens, access_token: access }, login);
  const ourCode = await seal(secret, 'code', { grant, clientId: asked.clientId, redirectUri: asked.redirectUri, challenge: asked.challenge }, Date.now() + CODE_LIFE);
  return answer(asked.redirectUri, { code: ourCode, state: asked.state });
}

/** The token request's parameters: a form, as OAuth has it, or JSON, which some clients send. */
async function paramsOf(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('Content-Type') ?? '';
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(body).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])));
  }
  return new URLSearchParams(await request.text().catch(() => ''));
}

async function tokensFor(secret: string, grant: Grant, clientId: string, origin: string): Promise<Response> {
  const audience = resourceOf(origin);
  const expires = grant.githubExpires - MARGIN;
  const accessToken = await seal(secret, 'access', { github: grant.github, login: grant.login, aud: audience }, expires);
  const refreshToken = grant.refresh ? await seal(secret, 'refresh', { github: grant.refresh, login: grant.login, clientId, aud: audience }, grant.refreshExpires) : null;
  return json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((expires - Date.now()) / 1000)),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: SCOPE,
    },
    200,
    { Pragma: 'no-cache' },
  );
}

/** POST /api/mcp/token: Lemma's tokens for a code (with its PKCE verifier) or for a refresh token. */
export async function token(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) return oauthError('temporarily_unavailable', 'Signing in is not set up on this site.', 503);
  const secret = env.GITHUB_CLIENT_SECRET;
  const origin = originOf(request);
  const params = await paramsOf(request);
  const resource = params.get('resource');
  if (resource !== null && !ours(resource, origin)) return oauthError('invalid_target', 'Lemma gives tokens for its MCP endpoint only.');
  const clientId = params.get('client_id');
  const grantType = params.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = await unseal<{ grant: Grant; clientId: string; redirectUri: string; challenge: string }>(secret, 'code', params.get('code') ?? '');
    if (!code) return oauthError('invalid_grant', 'The code is not valid or has expired.');
    if ((clientId !== null && clientId !== code.clientId) || params.get('redirect_uri') !== code.redirectUri) {
      return oauthError('invalid_grant', 'The code was given to another client or address.');
    }
    const verifier = params.get('code_verifier') ?? '';
    if (!verifier || (await challengeOf(verifier)) !== code.challenge) return oauthError('invalid_grant', 'PKCE verification failed.');
    return tokensFor(secret, code.grant, code.clientId, origin);
  }
  if (grantType === 'refresh_token') {
    const kept = await unseal<{ github: string; login: string; clientId: string; aud: string }>(secret, 'refresh', params.get('refresh_token') ?? '');
    if (!kept || kept.aud !== resourceOf(origin) || (clientId !== null && clientId !== kept.clientId)) {
      return oauthError('invalid_grant', 'The refresh token is not valid or has expired.');
    }
    let tokens: TokenAnswer;
    try {
      tokens = await askGitHub({ client_id: GITHUB_APP.clientId, client_secret: secret, grant_type: 'refresh_token', refresh_token: kept.github });
    } catch {
      return oauthError('temporarily_unavailable', 'GitHub could not be reached.', 503);
    }
    const access = tokens.access_token;
    if (!access) {
      // Only GitHub's word that the refresh token is dead ends the sign-in; an outage may pass.
      return tokens.error === 'bad_refresh_token'
        ? oauthError('invalid_grant', 'GitHub no longer accepts this sign-in; connect Lemma again.')
        : oauthError('temporarily_unavailable', `GitHub did not renew the sign-in (${tokens.error ?? 'no token'}).`, 503);
    }
    return tokensFor(secret, grantOf({ ...tokens, access_token: access }, kept.login), kept.clientId, origin);
  }
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

/** Who calls the MCP endpoint: the GitHub token and account its Lemma token carries; null without a valid one. */
export async function caller(request: Request, env: Env): Promise<{ github: string; login: string } | null> {
  if (!configured(env)) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]+)\s*$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match) return null;
  const data = await unseal<{ github: string; login: string; aud: string }>(env.GITHUB_CLIENT_SECRET, 'access', match[1]);
  return data && data.aud === resourceOf(originOf(request)) ? { github: data.github, login: data.login } : null;
}
