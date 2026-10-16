/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" (`npm run dev:mock`, see .env.mock) signs in made-up accounts and keeps everything in the browser. */
  readonly VITE_EDITOR_MOCK?: string;
}
