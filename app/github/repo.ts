/**
 * The repository an account keeps its papers in. Lemma's App reaches only the repositories the account
 * installed it on; one of them is Lemma's when it has a lemma.json, which Lemma writes into an empty
 * repository the first time (with a README saying what the files are).
 */
import { toBase64 } from '../../editor/results/backend';
import { GITHUB_APP } from './config';

export interface LemmaRepo {
  owner: string;
  name: string;
  /** The default branch (main, usually); unknown in an empty repository, which gets it with its first file. */
  branch: string;
  private: boolean;
}

/**
 * Lemma's (it has lemma.json); empty, or fresh (only what GitHub's form adds: a README, a licence, a
 * .gitignore), which Lemma can start; holding other files; or out of reach.
 */
export type RepoStatus = 'lemma' | 'empty' | 'fresh' | 'other' | 'missing';

/** What GitHub's form for a new repository can put in it. */
const STARTER_FILES = /^(README(\.md)?|LICENSE(\.md|\.txt)?|\.gitignore)$/i;

export const MARKER_PATH = 'lemma.json';

const API = 'https://api.github.com';

export const repoLabel = (repo: LemmaRepo): string => `${repo.owner}/${repo.name}`;

/** GitHub's rule for repository names: letters, digits, "-", "_" and ".", at most 100, not "." or "..". */
export const validRepoName = (name: string): boolean => /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';

/** GitHub's own form for a new repository, filled in. */
export function newRepoUrl(owner: string, name: string, description: string, isPrivate: boolean): string {
  const query = new URLSearchParams({ owner, name, visibility: isPrivate ? 'private' : 'public' });
  if (description.trim()) query.set('description', description.trim());
  return `https://github.com/new?${query.toString()}`;
}

async function getJson<T>(fetchImpl: typeof fetch, path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetchImpl(`${API}${path}`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}

interface RepoAnswer {
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
}

const fromAnswer = (repo: RepoAnswer): LemmaRepo => ({ owner: repo.owner.login, name: repo.name, branch: repo.default_branch, private: repo.private });

export interface Reachable {
  repos: LemmaRepo[];
  /** Lemma was installed on all of the account's repositories, not just the one for its papers. */
  everything: boolean;
}

const PAGE = 100;

/** The account's own repositories that Lemma's App was installed on. */
export async function reachableRepos(login: string, fetchImpl: typeof fetch): Promise<Reachable> {
  const installations = await getJson<{ installations: { id: number; app_slug: string; account: { login: string }; repository_selection?: string }[] }>(
    fetchImpl,
    `/user/installations?per_page=${PAGE}`,
  );
  if (!installations.body) throw new Error(`installations: ${installations.status}`);
  const mine = installations.body.installations.filter(
    (item) => item.app_slug === GITHUB_APP.slug && item.account.login.toLowerCase() === login.toLowerCase(),
  );
  const repos: LemmaRepo[] = [];
  for (const installation of mine) {
    for (let page = 1; ; page += 1) {
      const listed = await getJson<{ repositories: RepoAnswer[] }>(fetchImpl, `/user/installations/${installation.id}/repositories?per_page=${PAGE}&page=${page}`);
      if (!listed.body) throw new Error(`repositories: ${listed.status}`);
      repos.push(...listed.body.repositories.filter((repo) => repo.owner.login.toLowerCase() === login.toLowerCase()).map(fromAnswer));
      if (listed.body.repositories.length < PAGE) break;
    }
  }
  return { repos, everything: mine.some((item) => item.repository_selection === 'all') };
}

/** Whether a repository is Lemma's, empty, or holds other files. */
export async function repoStatus(repo: LemmaRepo, fetchImpl: typeof fetch): Promise<RepoStatus> {
  const marker = await fetchImpl(`${API}/repos/${repo.owner}/${repo.name}/contents/${MARKER_PATH}`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (marker.ok) return 'lemma';
  // GitHub answers 409 for a repository without commits.
  const commits = await fetchImpl(`${API}/repos/${repo.owner}/${repo.name}/commits?per_page=1`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (commits.status === 409) return 'empty';
  // Deleted, renamed, or no longer among the repositories the App was installed on.
  if (commits.status === 404) return 'missing';
  if (!commits.ok) throw new Error(`commits: ${commits.status}`);
  const root = await getJson<{ name: string }[]>(fetchImpl, `/repos/${repo.owner}/${repo.name}/contents/`);
  return root.body?.every((entry) => STARTER_FILES.test(entry.name)) ? 'fresh' : 'other';
}

/**
 * Each repository's status, a few at a time (GitHub limits requests made at once); one that cannot be read
 * counts as holding other files.
 */
export async function repoStatuses(repos: LemmaRepo[], fetchImpl: typeof fetch, atOnce = 4): Promise<{ repo: LemmaRepo; status: RepoStatus }[]> {
  const found: { repo: LemmaRepo; status: RepoStatus }[] = [];
  let next = 0;
  const work = async () => {
    while (next < repos.length) {
      const index = next;
      next += 1;
      const status = await repoStatus(repos[index], fetchImpl).catch((): RepoStatus => 'other');
      found[index] = { repo: repos[index], status };
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, repos.length) }, work));
  return found;
}

const readme = (site: string): string => `# Papers in Lemma

This repository keeps papers written with [Lemma](${site}):

- \`results.json\` lists them, with each paper's information and the LaTeX source of its blocks;
- \`results/<paper>/\` holds the PDFs Lemma compiled and the files attached to each paper;
- \`lemma.json\` tells Lemma that this repository is its own.

Lemma reads and writes it through its GitHub App, which can reach only the repositories it was installed on.
Keep it private while the papers are unpublished.
`;

async function putFile(repo: LemmaRepo, path: string, text: string, message: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(`${API}/repos/${repo.owner}/${repo.name}/contents/${path}`, {
    method: 'PUT',
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: toBase64(new TextEncoder().encode(text)) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
}

/**
 * Starts Lemma's files in an empty or fresh repository (an empty one also gets its default branch from the
 * first commit). A README already there stays.
 */
export async function initializeRepo(repo: LemmaRepo, status: 'empty' | 'fresh', site: string, fetchImpl: typeof fetch): Promise<LemmaRepo> {
  if (status === 'empty') await putFile(repo, 'README.md', readme(site), 'Set up Lemma', fetchImpl);
  await putFile(repo, MARKER_PATH, `${JSON.stringify({ lemma: 1 }, null, 2)}\n`, 'Mark the repository as Lemma\'s', fetchImpl);
  const answer = await getJson<RepoAnswer>(fetchImpl, `/repos/${repo.owner}/${repo.name}`);
  return answer.body ? fromAnswer(answer.body) : repo;
}

const repoKey = (login: string): string => `lemma-repo:${login.toLowerCase()}`;

/** The repository this browser last used for the account. */
export function rememberedRepo(login: string): LemmaRepo | null {
  try {
    const value = JSON.parse(localStorage.getItem(repoKey(login)) ?? 'null') as LemmaRepo | null;
    return value && typeof value.owner === 'string' && typeof value.name === 'string' && typeof value.branch === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function rememberRepo(login: string, repo: LemmaRepo | null): void {
  try {
    if (repo) localStorage.setItem(repoKey(login), JSON.stringify(repo));
    else localStorage.removeItem(repoKey(login));
  } catch {
    // Found again from the App's installations next time.
  }
}
