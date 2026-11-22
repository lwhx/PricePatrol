import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['server/test/**/*.test.ts','web/test/**/*.test.ts'],testTimeout:15000,hookTimeout:20000,pool:'forks',maxWorkers:2}});
