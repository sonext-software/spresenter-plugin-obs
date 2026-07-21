import { defineConfig } from 'vite';
import { resolve } from 'path';

// Build da UI (vanilla, sem framework). Painel dentro de um iframe sandboxed.
// `base: './'` mantém as URLs relativas para o host servir em /plugins/<id>/ui/.
export default defineConfig({
  root: resolve(__dirname, 'src/ui'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/ui'),
    emptyOutDir: true,
  },
});
