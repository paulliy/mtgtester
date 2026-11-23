import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { IMPORT_REPORT_PATH } from './lib/navigation';

/**
 * The tester's routes. Every view loads on demand (plan M6 task 1), so a view is a chunk of its
 * own and the table app's bundle can be checked to hold none of them.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'setup', component: () => import('./views/SetupView.vue') },
  { path: '/game', name: 'game', component: () => import('./views/GameView.vue') },
  { path: '/stats', name: 'stats', component: () => import('./views/StatsView.vue') },
  { path: '/debug', name: 'debug', component: () => import('./views/DebugView.vue') },
  // `/batch/new` is listed first so `new` is never read as a run id.
  { path: '/batch/new', name: 'batch-new', component: () => import('./views/BatchSetupView.vue') },
  // One record serves the list (`/batch`) and a chosen run (`/batch/:id`), so picking a run swaps
  // the route without remounting the page.
  {
    path: '/batch/:id?',
    name: 'batch-results',
    component: () => import('./views/BatchRunsView.vue'),
  },
  // The last refused import and the work order for its unmodeled cards (ADR 0054).
  {
    path: IMPORT_REPORT_PATH,
    name: 'import-report',
    component: () => import('./views/ImportReportView.vue'),
  },
  ...(import.meta.env['DEV'] === true
    ? [
        {
          path: '/card-test-lab',
          name: 'card-test-lab',
          component: () => import('./views/CardTestLabView.vue'),
        },
        // The deal UI with sample data and no game (ADR 0035).
        {
          path: '/deals-preview',
          name: 'deals-preview',
          // Loaded on demand, so its sample data never ships in a production bundle.
          component: () => import('./views/DealsPreviewView.vue'),
        },
      ]
    : []),
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
