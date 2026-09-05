import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    command: 'bun run --cwd apps/web dev --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env['CI'],
  },
});
