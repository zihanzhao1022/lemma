/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative paths, so the build works from any folder of any host (Cloudflare Pages, GitHub Pages, a server).
  base: './',
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: 'dist',
  },
  test: {
    setupFiles: ['./lib/i18n.testSetup.ts'],
    exclude: [...configDefaults.exclude],
  },
});
