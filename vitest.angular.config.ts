import { defineConfig } from 'vitest/config';
// Keep JSDOM worker memory bounded on machines with many logical CPUs.
export default defineConfig({ test: { maxWorkers: 2 } });
