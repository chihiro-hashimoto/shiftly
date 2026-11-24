import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'src/frontend/entries');

// 開発サーバー・プレビュー用（複数ページ）。GAS 用の単一 HTML は scripts/build-frontend.mjs で生成
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  server: { port: 5173, open: '/preview.html' },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/preview'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: { preview: resolve(root, 'preview.html') },
    },
  },
});
