import { describe, expect, it } from 'vitest';
import { ResultPaper } from '../../types';
import { ToolError, githubFetch, openLibrary } from './library';

const PAPERS: ResultPaper[] = [{ id: 'res-a', slug: 'made-up', title: 'A Made-up Study', authors: [], blocks: [{ id: 'intro', kind: 'text', source: '\\section{Introduction}' }] }];

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A made-up GitHub for `login`: Lemma's App installed on the repositories named, those in `lemma` holding
 * lemma.json and results.json, saving as the Git data API does.
 */
function fakeGitHub(login: string, repos: string[], lemma: string[]) {
  const requests: { path: string; method: string; init: RequestInit; headers: Headers; body: Record<string, unknown> | null }[] = [];
  let head = 'commit-1';
  let results = `${JSON.stringify(PAPERS, null, 2)}\n`;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ path: url.pathname, method, init, headers: new Headers(init.headers), body });
    const repoPath = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (url.pathname === '/user/installations') return answer({ installations: [{ id: 1, app_slug: 'lemmatex', account: { login }, repository_selection: 'selected' }] });
    if (url.pathname === '/user/installations/1/repositories') {
      return answer({ repositories: repos.map((name) => ({ name, owner: { login }, private: true, default_branch: 'main' })) });
    }
    if (!repoPath) return answer({}, 404);
    const [, , name, rest] = repoPath;
    const isLemma = lemma.includes(name);
    if (rest === '/contents/lemma.json') return isLemma ? answer({ content: '' }) : answer({}, 404);
    if (rest === '/commits') return answer([{ sha: 'x' }]);
    if (rest === '/contents/') return answer([{ name: 'src' }]);
    if (rest === '/git/ref/heads/main') return answer({ object: { sha: head } });
    if (rest === '/branches/main') return answer({ commit: { sha: head, commit: { tree: { sha: `tree-of-${head}` } } } });
    if (rest === '/contents/results.json') return new Response(results);
    if (rest === '/git/trees' && method === 'POST') {
      const entry = (body?.tree as { path: string; content?: string }[]).find((item) => item.path === 'results.json');
      if (entry?.content) results = entry.content;
      return answer({ sha: 'tree-2' });
    }
    if (rest === '/git/commits' && method === 'POST') return answer({ sha: 'commit-2' });
    if (rest === '/git/refs/heads/main' && method === 'PATCH') {
      head = String(body?.sha);
      return answer({});
    }
    return answer({}, 404);
  }) as typeof fetch;
  return { fetchImpl, requests, results: () => results };
}

describe("the person's papers through GitHub", () => {
  it('signs each request, names itself, and leaves out what Workers refuse', async () => {
    const seen: RequestInit[] = [];
    const signed = githubFetch('ghu_made_up', (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return answer({});
    }) as typeof fetch);
    await signed('https://api.github.com/user', { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw+json' } });
    expect(seen[0]).not.toHaveProperty('cache');
    const headers = new Headers(seen[0].headers);
    expect(headers.get('Authorization')).toBe('Bearer ghu_made_up');
    expect(headers.get('User-Agent')).toBe('Lemma');
    expect(headers.get('Accept')).toBe('application/vnd.github.raw+json');
  });

  it("finds the Lemma repository among those the App was installed on, reads its papers and saves to it", async () => {
    const github = fakeGitHub('ada-example', ['dotfiles', 'lemma-papers'], ['lemma-papers']);
    const library = await openLibrary('ghu_made_up', 'ada-example', undefined, github.fetchImpl);
    expect(library.repo).toBe('ada-example/lemma-papers');
    expect(await library.papers()).toEqual(PAPERS);
    const after = await library.save({ kind: 'patchPaper', id: 'res-a', fields: { logic: { intro: '' } } }, 'results: update logic of "A Made-up Study" (Claude Code)');
    expect(after[0].logic).toEqual({ intro: '' });
    expect(JSON.parse(github.results())[0].logic).toEqual({ intro: '' });
    const commit = github.requests.find((request) => request.path.endsWith('/git/commits'));
    expect(commit?.body).toMatchObject({ message: 'results: update logic of "A Made-up Study" (Claude Code)', parents: ['commit-1'] });
    expect(github.requests.find((request) => request.method === 'PATCH')?.body).toEqual({ sha: 'commit-2', force: false });
    for (const request of github.requests) {
      expect(request.init).not.toHaveProperty('cache');
      expect(request.headers.get('User-Agent')).toBe('Lemma');
      expect(request.headers.get('Authorization')).toBe('Bearer ghu_made_up');
    }
  });

  it('passes on GitHub refusing the sign-in with its status', async () => {
    const refused = (async () => answer({ message: 'Bad credentials' }, 401)) as typeof fetch;
    await expect(openLibrary('ghu_revoked', 'di-example', undefined, refused)).rejects.toMatchObject({ status: 401 });
  });

  it('says when there is no Lemma repository, or several to choose from', async () => {
    await expect(openLibrary('ghu', 'bo-example', undefined, fakeGitHub('bo-example', ['dotfiles'], []).fetchImpl)).rejects.toThrow(ToolError);
    const several = fakeGitHub('cy-example', ['lemma-a', 'lemma-b'], ['lemma-a', 'lemma-b']);
    await expect(openLibrary('ghu', 'cy-example', undefined, several.fetchImpl)).rejects.toThrow('cy-example/lemma-a, cy-example/lemma-b');
    expect((await openLibrary('ghu', 'cy-example', 'cy-example/lemma-b', several.fetchImpl)).repo).toBe('cy-example/lemma-b');
    await expect(openLibrary('ghu', 'cy-example', 'cy-example/elsewhere', several.fetchImpl)).rejects.toThrow('not one of your Lemma repositories');
  });
});
