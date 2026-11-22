import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: resolve(root), plugins: [vue()],
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { outDir: resolve(root, 'dist'), emptyOutDir: true },
});
