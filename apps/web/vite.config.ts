import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * The spectator UI dev server. `/ws` proxies to the Bun server (`bun run serve`), which owns
 * the engine, the AI key, and the database - the frontend never talks to any of them directly
 * (brief §2, §11). Proxying rather than hardcoding a port means the client derives its socket
 * URL from `window.location` and a production build needs no configuration.
 */
const gameServerPort = Number.parseInt(process.env.GAME_SERVER_PORT ?? '3001', 10);
const gameServerHost = `127.0.0.1:${Number.isFinite(gameServerPort) ? gameServerPort : 3001}`;
// `bun run dev --table` points the table app's dev server at `serve:table --dev` instead.
const tableServerPort = Number.parseInt(process.env.TABLE_SERVER_PORT ?? '3002', 10);
const tableServerHost = `127.0.0.1:${Number.isFinite(tableServerPort) ? tableServerPort : 3002}`;

/**
 * Local games in dev (`VITE_LOCAL_GAMES=true bun run dev:web`, ADR 0053): the game worker reads
 * the site card files from `/cards/`, so the dev server serves the folder `bun run site:cards`
 * wrote (`SITE_CARDS_DIR`, `data/site-cards` by default). A production build serves them itself.
 */
function siteCards(): Plugin {
  const root = resolve(__dirname, '../..', process.env.SITE_CARDS_DIR ?? 'data/site-cards');
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const path = normalize(decodeURIComponent((request.url ?? '/').split('?')[0]!));
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
    response.setHeader('content-type', 'application/json');
    response.end(readFileSync(file));
  };
  return {
    name: 'decktank-site-cards',
    configureServer(server) {
      server.middlewares.use('/cards/', serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/cards/', serve);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [vue(), siteCards()],
  // Only a local-games build carries the game worker: every other build gets the empty stand-in.
  ...(loadEnv(mode, __dirname, 'VITE_').VITE_LOCAL_GAMES !== 'true' && {
    resolve: {
      alias: [
        {
          find: /^\.\/localEngine$/,
          replacement: resolve(__dirname, 'src/lib/localEngine.off.ts'),
        },
      ],
    },
  }),
  // The game worker imports chunks of its own, which only module workers can do.
  worker: { format: 'es' },
  // `--mode table` builds the table app (ADR 0031, plan M6) into its own directory, with the
  // manifest `serve:table` reads to decide which files it may serve.
  ...(mode === 'table' && {
    build: { outDir: 'dist-table', manifest: true, emptyOutDir: true },
  }),
  server: {
    port: 5173,
    // The server only accepts browser origins on 5173 (`isAllowedLocalRequest`). Falling back
    // to 5174 when a stale dev server holds the port would load a UI whose every request is
    // refused, so fail at startup instead.
    strictPort: true,
    proxy:
      mode === 'table'
        ? {
            // Table pages, requests and sockets all live under `/tables`.
            '/tables': { target: `http://${tableServerHost}`, ws: true },
            '/health': { target: `http://${tableServerHost}` },
          }
        : {
            '/ws': { target: `ws://${gameServerHost}`, ws: true },
            // The site's multiplayer pages talk to the table server (`serve:table --dev`).
            '/tables': { target: `http://${tableServerHost}`, ws: true },
            '/health': { target: `http://${gameServerHost}` },
            '/api': { target: `http://${gameServerHost}` },
          },
  },
}));
