import { fileURLToPath } from 'node:url';

export default {
  plugins: {
    // The config next to this file, whichever directory the build or dev server starts in.
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {},
  },
};
