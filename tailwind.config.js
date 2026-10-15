/** @type {import('tailwindcss').Config} */
export default {
  // Relative to this file, so the classes are found whatever directory the build or dev server starts in.
  content: {
    relative: true,
    files: ['./index.html', './app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './editor/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  },
  theme: {
    extend: {},
  },
  plugins: [],
};
