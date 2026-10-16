import { createGitHubApi } from '../../editor/github';
import { ResultsBackend, createResultsBackend } from '../../editor/results/backend';
import { fileCache } from '../../lib/fileCache';
import { LemmaRepo } from './repo';
import { authorizedFetch } from './session';

/**
 * An account's papers in its own repository, read and saved with its GitHub token (one commit a save, as on
 * the homepage's results pages). Every paper is private: nothing is published and no one else is let in.
 */
export function repoBackend(repo: LemmaRepo, login: string): ResultsBackend {
  // The token is the account's newest, filled in by authorizedFetch on every request.
  const api = createGitHubApi('', { owner: repo.owner, repo: repo.name, branch: repo.branch }, authorizedFetch());
  const { loadAccess: _access, saveAccess: _save, ...backend } = createResultsBackend(api, null, fileCache(login), repo.branch);
  return backend;
}
