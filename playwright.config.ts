import { defineConfig } from '@playwright/test';

// Minimal stub. The single v1 end-to-end flow — import four decks, start a game,
// confirm it reaches a winner and the stats page updates (brief §12) — is built in
// Phase 4. This config exists now so the E2E harness is wired from day one.
export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
  },
});
