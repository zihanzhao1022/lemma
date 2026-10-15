/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" turns on the made-up accounts in development; index.html turns them on for the prototype anyway. */
  readonly VITE_EDITOR_MOCK?: string;
}
