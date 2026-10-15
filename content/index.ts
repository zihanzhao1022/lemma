import { SiteContent } from '../types';

/**
 * The site content the shared results components expect around a paper. Lemma has no homepage of its own, so
 * every list is empty; the papers come from the accounts' repositories.
 */
export const bundledContent: SiteContent = {
  profile: {
    name: { first: '', last: '' },
    title: '',
    affiliation: '',
    email: '',
    bio: [],
    avatar: '',
    socials: [],
    education: [],
    researchInterests: [],
    awards: [],
    skills: [],
    languages: [],
  },
  news: [],
  experiences: [],
  publications: [],
  projects: [],
  talks: [],
  awards: [],
  navigation: [],
  results: [],
};
