import { defineConfig } from 'vite';
import { resolve } from 'path';

// Logic thread build. Produces a single IIFE (no DOM) that the host evaluates
// inside a restricted vm context, where the `spresenter` global is injected.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/code.ts'),
      formats: ['iife'],
      name: 'SpresenterObsPlugin',
      fileName: () => 'code.js',
    },
    target: 'es2020',
    minify: false,
  },
});
