import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * The spectator UI dev server. `/ws` proxies to the Bun server (`bun run serve`), which owns
 * the engine, the AI key, and the database — the frontend never talks to any of them directly
 * (brief §2, §11). Proxying rather than hardcoding a port means the client derives its socket
 * URL from `window.location` and a production build needs no configuration.
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/health': { target: 'http://localhost:3001' },
      '/api': { target: 'http://localhost:3001' },
    },
  },
});
