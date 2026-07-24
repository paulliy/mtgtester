import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live beside source (brief §12 — engine coverage is the bulk of these).
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
  },
});
