import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// @vitejs/plugin-vue is wired now so Phase 4 can add .vue single-file components without
// touching config. The full spectator UI (brief §10) is built then.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
  },
});
