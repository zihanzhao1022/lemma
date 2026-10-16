import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITHUB_APP } from './config';
import { LemmaRepo, initializeRepo, newRepoUrl, reachableRepos, repoStatus, validRepoName } from './repo';
import { GitHubSession, authorizedFetch, currentSession, setSession } from './session';

const session = (token: string, inMs: number): GitHubSession => ({ token, expiresAt: Date.now() + inMs, login: 'ada-example', id: 42, name: 'Ada Example', avatarUrl: '' });

interface Sent {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** A made-up GitHub and /api: `answer` decides each response; every request is kept in `sent`. */
function fake(answer: (url: string, method: string, authorization: string | null) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const authorization = new Headers(init.headers).get('Authorization');
    sent.push({ url, method, authorization, body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null });
    return answer(url, method, authorization);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => setSession(null));

describe('requests to GitHub', () => {
  it("send the account's token", async () => {
    setSession(session('ghu_now', 60 * 60 * 1000));
    const { sent, fetchImpl } = fake(() => ok({}));
    await authorizedFetch(fetchImpl)('https://api.github.com/user/installations');
    expect(sent).toHaveLength(1);
    expect(sent[0].authorization).toBe('Bearer ghu_now');
  });

  it('renew a token about to run out before sending', async () => {
    setSession(session('ghu_old', 10 * 1000));
    const { sent, fetchImpl } = fake((url) => (url === '/api/refresh' ? ok(session('ghu_new', 8 * 60 * 60 * 1000)) : ok({})));
    await authorizedFetch(fetchImpl)('https://api.github.com/repos/a/b');
    expect(sent.map((item) => item.url)).toEqual(['/api/refresh', 'https://api.github.com/repos/a/b']);
    expect(sent[1].authorization).toBe('Bearer ghu_new');
    expect(currentSession()?.token).toBe('ghu_new');
  });

  it('renew once and send again when GitHub turns the token away', async () => {
    setSession(session('ghu_revoked', 60 * 60 * 1000));
    const { sent, fetchImpl } = fake((url, _method, authorization) => {
      if (url === '/api/refresh') return ok(session('ghu_new', 8 * 60 * 60 * 1000));
      return authorization === 'Bearer ghu_new' ? ok({}) : new Response('{}', { status: 401 });
    });
    const res = await authorizedFetch(fetchImpl)('https://api.github.com/repos/a/b');
    expect(res.status).toBe(200);
    expect(sent.map((item) => item.authorization)).toEqual(['Bearer ghu_revoked', null, 'Bearer ghu_new']);
  });

  it('sign out when the refresh cookie is refused, and send nothing without an account', async () => {
    setSession(session('ghu_old', 10 * 1000));
    const { sent, fetchImpl } = fake((url) => (url === '/api/refresh' ? new Response('{}', { status: 401 }) : ok({})));
    expect((await authorizedFetch(fetchImpl)('https://api.github.com/repos/a/b')).status).toBe(401);
    expect(currentSession()).toBeNull();
    expect(sent.map((item) => item.url)).toEqual(['/api/refresh']);
    expect((await authorizedFetch(fetchImpl)('https://api.github.com/repos/a/b')).status).toBe(401);
    expect(sent).toHaveLength(1);
  });
});

describe("the account's repository", () => {
  beforeEach(() => {
    GITHUB_APP.slug = 'lemmatex';
  });
  afterEach(() => {
    GITHUB_APP.slug = '';
  });

  const repo: LemmaRepo = { owner: 'ada-example', name: 'lemma-papers', branch: 'main', private: true };
  const answer = (name: string, owner = 'ada-example') => ({ name, owner: { login: owner }, private: true, default_branch: 'main' });

  it("is found among the repositories the account installed Lemma's App on", async () => {
    const { fetchImpl } = fake((url) => {
      if (url.endsWith('/user/installations?per_page=100')) {
        return ok({
          installations: [
            { id: 1, app_slug: 'lemmatex', account: { login: 'Ada-Example' } },
            { id: 2, app_slug: 'another-app', account: { login: 'ada-example' } },
            { id: 3, app_slug: 'lemmatex', account: { login: 'some-org' } },
          ],
        });
      }
      if (url.endsWith('/user/installations/1/repositories?per_page=100')) return ok({ repositories: [answer('lemma-papers'), answer('fork', 'someone')] });
      throw new Error(`unexpected ${url}`);
    });
    expect(await reachableRepos('ada-example', fetchImpl)).toEqual([repo]);
  });

  it("is told apart: Lemma's, empty, fresh from GitHub's form, someone else's files, or out of reach", async () => {
    const status = (marker: number, commits: number, root: string[] = []) =>
      repoStatus(
        repo,
        fake((url) => {
          if (url.endsWith('/contents/lemma.json')) return new Response('{}', { status: marker });
          if (url.endsWith('/contents/')) return ok(root.map((name) => ({ name })));
          return new Response('[]', { status: commits });
        }).fetchImpl,
      );
    expect(await status(200, 200)).toBe('lemma');
    expect(await status(404, 409)).toBe('empty');
    expect(await status(404, 200, ['README.md', 'LICENSE', '.gitignore'])).toBe('fresh');
    expect(await status(404, 200, ['README.md', 'main.tex'])).toBe('other');
    expect(await status(404, 404)).toBe('missing');
  });

  it('is started with a README and lemma.json, and learns its new default branch', async () => {
    const { sent, fetchImpl } = fake((_url, method) => (method === 'PUT' ? new Response('{}', { status: 201 }) : ok({ ...answer('lemma-papers'), default_branch: 'trunk' })));
    const started = await initializeRepo({ ...repo, branch: '' }, 'empty', 'https://lemma.example', fetchImpl);
    expect(sent.filter((item) => item.method === 'PUT').map((item) => item.url)).toEqual([
      'https://api.github.com/repos/ada-example/lemma-papers/contents/README.md',
      'https://api.github.com/repos/ada-example/lemma-papers/contents/lemma.json',
    ]);
    const marker = sent[1].body as { content: string };
    expect(JSON.parse(atob(marker.content))).toEqual({ lemma: 1 });
    expect(started.branch).toBe('trunk');
    // A fresh repository keeps its own README.
    const fresh = fake((_url, method) => (method === 'PUT' ? new Response('{}', { status: 201 }) : ok(answer('lemma-papers'))));
    await initializeRepo(repo, 'fresh', 'https://lemma.example', fresh.fetchImpl);
    expect(fresh.sent.filter((item) => item.method === 'PUT').map((item) => item.url.split('/').pop())).toEqual(['lemma.json']);
  });

  it("is made on GitHub's own form, filled in, under a name GitHub accepts", () => {
    expect(newRepoUrl('ada-example', 'lemma-papers', ' Papers ', true)).toBe('https://github.com/new?owner=ada-example&name=lemma-papers&visibility=private&description=Papers');
    expect(validRepoName('lemma-papers')).toBe(true);
    expect(validRepoName('my papers')).toBe(false);
    expect(validRepoName('..')).toBe(false);
    expect(validRepoName('a'.repeat(101))).toBe(false);
  });
});
