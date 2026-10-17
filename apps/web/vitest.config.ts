import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  esbuild: { jsx: 'automatic' }, // components use the React 17+ JSX transform (no `import React`)
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
