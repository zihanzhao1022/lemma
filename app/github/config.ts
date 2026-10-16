/**
 * Lemma's GitHub App: public identifiers only. Its client secret is set in the Cloudflare Pages project as
 * GITHUB_CLIENT_SECRET and read by functions/api; it is never in this repository.
 */
export const GITHUB_APP = {
  /** The App's client ID (GitHub → Settings → Developer settings → GitHub Apps → the App). */
  clientId: 'Iv23liUGfsgmwFsTztro',
  /** The App's name in its address: github.com/apps/<slug>. */
  slug: 'lemmatex',
};

/** The repository name a new account is offered, as GitHub's own form offers one. */
export const SUGGESTED_REPO = 'lemma-papers';

/** Sign-in shows only once both are filled in. */
export const appConfigured = (): boolean => GITHUB_APP.clientId !== '' && GITHUB_APP.slug !== '';
