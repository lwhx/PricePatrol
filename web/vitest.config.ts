import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('..', import.meta.url)), plugins: [vue()], test: { environment: 'jsdom', setupFiles: ['web/test/setup.ts'], include: ['web/test/**/*.{test,spec}.ts'], passWithNoTests: false } });
