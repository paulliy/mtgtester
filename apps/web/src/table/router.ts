import { createRouter, createWebHistory } from 'vue-router';
import { TABLES_PATH, tableRoutes } from './routes';

/**
 * The tables-only build (`vite build --mode table`), which the table server serves itself until
 * the site moves to static hosting: its front page is the tables' home.
 */
export const tableRouter = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', redirect: TABLES_PATH }, ...tableRoutes],
});
