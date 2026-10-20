/**
 * A person's papers as the MCP tools see them: their Lemma repository, read and saved with their GitHub token
 * exactly as Lemma's own pages do (commitResults: the edit applied to the latest results.json, one commit).
 */
import { LemmaRepo, reachableRepos, repoLabel, repoStatuses } from '../../app/github/repo';
import { GitHubError, createGitHubApi } from '../../editor/github';
import { RESULTS_PATH, commitResults, parsePapers, readTextFile } from '../../editor/results/backend';
import { ResultsOp } from '../../editor/results/ops';
import { ResultPaper } from '../../types';

/** A problem to tell the person in words, rather than a failure of the server. */
export class ToolError extends Error {}

export interface Library {
  /** owner/name of the repository. */
  repo: string;
  papers(): Promise<ResultPaper[]>;
  /**
   * Applies `op` to the latest papers and commits it with `deletes` (files no paper refers to any more); the
   * papers after. `check` sees the latest papers first and throws to stop.
   */
  save(op: ResultsOp, message: string, deletes?: string[], check?: (latest: ResultPaper[]) => void): Promise<ResultPaper[]>;
  /** A text file of the repository; null when there is none. */
  readText(path: string): Promise<string | null>;
}

/**
 * fetch for GitHub's API with the person's token. Workers send no User-Agent of their own, which GitHub
 * requires, and may refuse the `cache` option the browser code passes.
 */
export function githubFetch(token: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return (input, init = {}) => {
    const { cache: _cache, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/vnd.github+json');
    headers.set('User-Agent', 'Lemma');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    return fetchImpl(input, { ...rest, headers });
  };
}

// Finding the repository takes a few requests: kept a while per account by this server's instance.
const found = new Map<string, { repos: LemmaRepo[]; at: number }>();
const FOUND_LIFE = 5 * 60_000;

/** The person's Lemma repositories: those Lemma's App was installed on that have its lemma.json. */
async function lemmaRepos(login: string, fetchImpl: typeof fetch): Promise<LemmaRepo[]> {
  const key = login.toLowerCase();
  const kept = found.get(key);
  if (kept && Date.now() - kept.at < FOUND_LIFE) return kept.repos;
  const { repos } = await reachableRepos(login, fetchImpl).catch((error: unknown) => {
    // It says what failed in words ("installations: 401"); as a GitHubError its status tells the person what to do.
    const status = error instanceof Error ? /: (\d{3})$/.exec(error.message)?.[1] : undefined;
    throw status && error instanceof Error ? new GitHubError(error.message, Number(status)) : error;
  });
  const lemma = (await repoStatuses(repos, fetchImpl)).filter((item) => item.status === 'lemma').map((item) => item.repo);
  if (lemma.length > 0) found.set(key, { repos: lemma, at: Date.now() });
  return lemma;
}

/** The papers of the person signed in with `token`; `wanted` (owner/name) picks one of several repositories. */
export async function openLibrary(token: string, login: string, wanted?: string, fetchImpl?: typeof fetch): Promise<Library> {
  const github = githubFetch(token, fetchImpl);
  const repos = await lemmaRepos(login, github);
  if (repos.length === 0) throw new ToolError(`${login} has no Lemma repository yet: sign in at Lemma and set one up first.`);
  const names = repos.map(repoLabel).join(', ');
  let repo: LemmaRepo | undefined = repos[0];
  if (wanted) {
    repo = repos.find((item) => repoLabel(item).toLowerCase() === wanted.toLowerCase());
    if (!repo) throw new ToolError(`${wanted} is not one of your Lemma repositories (${names}).`);
  } else if (repos.length > 1) {
    throw new ToolError(`You have several Lemma repositories (${names}): say which one with "repo".`);
  }
  const api = createGitHubApi(token, { owner: repo.owner, repo: repo.name, branch: repo.branch }, github);
  return {
    repo: repoLabel(repo),
    papers: async () => parsePapers(await readTextFile(api, RESULTS_PATH, await api.headSha())),
    save: async (op, message, deletes = [], check) => (await commitResults(api, op, [], deletes, message, check)).papers,
    readText: async (path) => readTextFile(api, path, await api.headSha()),
  };
}
