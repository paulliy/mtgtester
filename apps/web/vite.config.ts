import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * The spectator UI dev server. `/ws` proxies to the Bun server (`bun run serve`), which owns
 * the engine, the AI key, and the database - the frontend never talks to any of them directly
 * (brief §2, §11). Proxying rather than hardcoding a port means the client derives its socket
 * URL from `window.location` and a production build needs no configuration.
 */
const gameServerPort = Number.parseInt(process.env.GAME_SERVER_PORT ?? '3001', 10);
const gameServerHost = `127.0.0.1:${Number.isFinite(gameServerPort) ? gameServerPort : 3001}`;

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // The server only accepts browser origins on 5173 (`isAllowedLocalRequest`). Falling back
    // to 5174 when a stale dev server holds the port would load a UI whose every request is
    // refused, so fail at startup instead.
    strictPort: true,
    proxy: {
      '/ws': { target: `ws://${gameServerHost}`, ws: true },
      '/health': { target: `http://${gameServerHost}` },
      '/api': { target: `http://${gameServerHost}` },
    },
  },
});
