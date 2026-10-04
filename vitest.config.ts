import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  resolve: { alias: {
    '@pricemesh/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
    '@pricemesh/pack': fileURLToPath(new URL('./packages/pack/src/index.ts', import.meta.url))
  } },
  test: { include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts', 'tests/unit/**/*.test.ts'], testTimeout: 30000 }
});
